// enrich/index.js
// Module 4 per PRD. For each qualified company, find 1-3 decision-maker
// contacts with verified emails via Hunter.io.
//
// Priority order: highest-scoring companies first. Cost guard bails cleanly
// when the monthly Hunter budget is exhausted, without failing the run.
import {
  companiesByStatus, contactCountForCompany, upsertContact,
} from '../db/repo.js';
import { getDb } from '../db/connection.js';
import { logger } from '../util/logger.js';
import { domainSearch, emailVerifier as hunterVerifier } from './hunter.js';

// Alias so both usages in this file (Hunter primary + posting-scrape verify) read cleanly.
const emailVerifier = hunterVerifier;
import { charge, usage } from './cost-guard.js';
import { targetHintsFor, titleMatches } from './target.js';
import { contactsFromPosting, roleTypeFromLocalPart } from './from-posting.js';

const PROVIDER = 'hunter';

/**
 * Run enrichment against all qualified companies, in company.score order.
 * @param {object} args
 * @param {object} args.config
 * @param {number} [args.maxCompanies] hard cap (safety)
 */
export async function runEnrich({ config, maxCompanies = 200 } = {}) {
  const stats = {
    companiesProcessed: 0,
    contactsCreated: 0,
    verified: 0,
    risky: 0,
    invalid: 0,
    budgetExceeded: false,
    skippedNoDomain: 0,
  };

  // Prefer the new `monthly_budget` field; fall back to the legacy `monthly_budget_usd`.
  const budget = config.enrichment.monthly_budget ?? config.enrichment.monthly_budget_usd ?? 0;
  const before = usage(PROVIDER, budget);
  logger.info({ ...before }, 'hunter budget status');
  if (before.remaining <= 0) {
    stats.budgetExceeded = true;
    return stats;
  }

  const companies = companiesByStatus('qualified').slice(0, maxCompanies);

  for (const company of companies) {
    if (contactCountForCompany(company.id) > 0) continue;      // already enriched
    const domain = deriveDomain(company);
    if (!domain) { stats.skippedNoDomain++; continue; }

    try {
      // Charge 1 credit per domain-search call up front (Hunter says
      // 1 credit per 10 results; we're approximating).
      charge(PROVIDER, 1, budget);
      const hints = targetHintsFor(company);
      const uniqueEmails = new Map();

      for (const hint of hints) {
        const res = await domainSearch({
          domain,
          seniority: hint.seniority,
          department: hint.department,
          limit: 10,
        });
        for (const e of res.emails || []) {
          if (!e.value) continue;
          if (!titleMatches(e.position, hint.titleAny) && hint.titleAny?.length) continue;
          if (!uniqueEmails.has(e.value.toLowerCase())) {
            uniqueEmails.set(e.value.toLowerCase(), { emailData: e, roleType: hint.roleType });
          }
          if (uniqueEmails.size >= 3) break;
        }
        if (uniqueEmails.size >= 3) break;
      }

      // Verify + persist up to 3 contacts.
      for (const { emailData, roleType } of uniqueEmails.values()) {
        // Prefer Hunter's inline verification field, fall back to explicit verifier.
        let statusLabel = mapVerification(emailData.verification?.status);
        let rawVer = emailData.verification || null;

        if (!statusLabel) {
          charge(PROVIDER, 1, budget);
          const v = await emailVerifier({ email: emailData.value });
          statusLabel = v.status;
          rawVer = v.raw;
        }

        if (statusLabel === 'verified') stats.verified++;
        else if (statusLabel === 'risky') stats.risky++;
        else stats.invalid++;

        if (statusLabel === 'invalid') continue;

        const { created } = upsertContact({
          companyId: company.id,
          fullName: [emailData.first_name, emailData.last_name].filter(Boolean).join(' ') || null,
          title: emailData.position || null,
          roleType,
          email: emailData.value,
          emailStatus: statusLabel,
          source: 'hunter',
          raw: { hunter: emailData, verification: rawVer },
        });
        if (created) stats.contactsCreated++;
      }

      stats.companiesProcessed++;

      // Fallback: if Hunter yielded no contact, scan the company's job
      // postings for emails that appear in the text itself. Every candidate
      // is Hunter-verified before storing so we never send to an unverified
      // address (QA 2.4).
      if (uniqueEmails.size === 0) {
        const jobs = getDb().prepare(
          `SELECT description_text FROM job WHERE company_id = ? AND description_text IS NOT NULL LIMIT 20`
        ).all(company.id);
        outer: for (const j of jobs) {
          const found = contactsFromPosting({ descriptionText: j.description_text, companyDomainHint: domain });
          for (const c of found) {
            if (c.quality === 'generic') continue;
            // Verify with Hunter before storing. Charge one credit per verification.
            try { charge(PROVIDER, 1, budget); }
            catch (err) {
              if (err.name === 'BudgetExceededError') {
                stats.budgetExceeded = true;
                break outer;
              }
              throw err;
            }
            const v = await emailVerifier({ email: c.email });
            if (v.status === 'invalid') { stats.invalid++; continue; }

            const { created } = upsertContact({
              companyId: company.id,
              fullName: null,
              title: null,
              roleType: roleTypeFromLocalPart(c.local),
              email: c.email,
              emailStatus: v.status,                // 'verified' or 'risky'
              source: 'posting_scrape',
              raw: { local: c.local, domain: c.domain, quality: c.quality, verification: v.raw },
            });
            if (created) {
              stats.contactsCreated++;
              if (v.status === 'verified') stats.verified++;
              else stats.risky++;
            }
            break outer;                            // one posting-derived contact per company
          }
        }
      }
    } catch (err) {
      if (err.name === 'BudgetExceededError') {
        logger.warn({ used: err.used, budget: err.budget }, 'hunter budget exhausted, stopping');
        stats.budgetExceeded = true;
        break;
      }
      logger.error({ err: err.message, companyId: company.id }, 'enrich failed for company');
    }
  }

  logger.info(stats, 'enrich pass complete');
  return stats;
}

/**
 * Cheap domain derivation. Priority: company.website -> job URLs registered
 * in the last discovery -> ATS slug fallback (least reliable).
 */
export function deriveDomain(company) {
  if (company.website) {
    try {
      const u = new URL(company.website.startsWith('http') ? company.website : `https://${company.website}`);
      return u.hostname.replace(/^www\./, '');
    } catch { /* fall through */ }
  }
  // Try to derive from a job URL for this company.
  const row = getDb().prepare(`
    SELECT url FROM job WHERE company_id = ? AND url IS NOT NULL LIMIT 1
  `).get(company.id);
  if (row?.url) {
    try {
      const u = new URL(row.url);
      // ATS-hosted URLs (boards.greenhouse.io/acme) are not the company's real
      // domain. Skip those.
      if (/greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com/.test(u.hostname)) return null;
      return u.hostname.replace(/^www\./, '');
    } catch { /* ignore */ }
  }
  return null;
}

function mapVerification(status) {
  if (!status) return null;
  const map = { deliverable: 'verified', valid: 'verified', risky: 'risky', invalid: 'invalid', undeliverable: 'invalid' };
  return map[status] || null;
}
