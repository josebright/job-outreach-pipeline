// enrich/index.js
// Module 4 per PRD. For each qualified company, find 1-3 decision-maker
// contacts with verified emails via Hunter.io.
//
// Priority order: highest-scoring companies first. Cost guard bails cleanly
// when the monthly Hunter budget is exhausted, without failing the run.
import {
  companiesByStatus, contactCountForCompany, upsertContact,
  updateCompanyEnrichment,
} from '../db/repo.js';
import { getDb } from '../db/connection.js';
import { logger } from '../util/logger.js';
import {
  domainSearch, emailVerifier as hunterVerifier, mapHunterStatus,
  emailCount, companyEnrich, employeesToBand,
} from './hunter.js';

// Alias so both usages in this file (Hunter primary + posting-scrape verify) read cleanly.
const emailVerifier = hunterVerifier;
import { charge, usage } from './cost-guard.js';
import { queriesFor, rankPerson, roleTypeForTitle, isSmallCo } from './target.js';
import { contactsFromPosting, roleTypeFromLocalPart } from './from-posting.js';
import { guessDomain } from './domain-guess.js';

const PROVIDER = 'hunter';

// Local parts we never accept even as a last-resort fallback.
const NO_REPLY = new Set(['noreply', 'no-reply', 'donotreply', 'do-not-reply']);

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
    skippedEmptyIndex: 0,   // Hunter has 0 emails for this domain
    sizeBackfilled: 0,      // companies/find gave us a size_band
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
    let domain = deriveDomain(company);
    if (!domain) {
      // Try a cheap DNS-based guess from the company slug/name before giving up.
      const guessed = await guessDomain(company).catch(() => null);
      if (guessed) {
        domain = guessed;
        try {
          getDb().prepare(`UPDATE company SET website = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(`https://${guessed}`, company.id);
        } catch { /* non-fatal */ }
      }
    }
    if (!domain) { stats.skippedNoDomain++; continue; }

    try {
      // 0. FREE pre-check: Hunter's own guidance is to call email-count
      // before spending a domain-search credit. If Hunter has 0 emails on
      // the domain, we skip domain-search entirely and go straight to the
      // posting-scrape fallback.
      const count = await emailCount({ domain });
      if (count.total === 0) {
        stats.skippedEmptyIndex++;
        // still fall through to companies/find + posting-scrape below
      }

      // 0b. High-count company-size floor. Hunter's email index is
      // (roughly) a lower bound on employee count — if they have 250+
      // emails on the domain, the company almost certainly has more than
      // 500 employees. Overrides whatever companies/find later says (which
      // is often stale for large companies). Fixes the Affirm/Algolia/
      // Snowflake/Airtable leak class.
      if (count.total !== null && count.total >= 250) {
        const derivedBand = count.total >= 800 ? '1000+' : '501-1000';
        updateCompanyEnrichment(company.id, {
          sizeBand: derivedBand, sizeBandSource: 'hunter', overwriteSize: true,
        });
        company.size_band = derivedBand;
        company.size_band_source = 'hunter';
        logger.info({ companyId: company.id, domain, emailCount: count.total, derivedBand },
          'enrich: email-count floor set company to >500');
        stats.sizeFlooredByEmailCount = (stats.sizeFlooredByEmailCount || 0) + 1;
      }

      // 1. Company enrichment: cheap way to backfill missing size_band /
      // hq_country / industry. Only fire it when we're actually missing
      // one of those — no point spending a credit if the seed CSV already
      // gave us everything.
      if (!company.size_band || !company.hq_country || !company.industry) {
        try {
          charge(PROVIDER, 1, budget);
          const info = await companyEnrich({ domain });
          if (info) {
            const band = employeesToBand(info.employeesEstimate);
            updateCompanyEnrichment(company.id, {
              sizeBand:       band,
              sizeBandSource: band ? 'hunter' : null,
              hqCountry:      info.country,
              industry:       info.industry,
              linkedinUrl:    info.linkedin,
            });
            if (band && !company.size_band) stats.sizeBackfilled++;
            // Refresh local copy so downstream ranking sees the new size.
            if (band) company.size_band = band;
          }
        } catch (err) {
          if (err.name === 'BudgetExceededError') {
            stats.budgetExceeded = true; break;
          }
          logger.warn({ err: err.message, domain }, 'companies/find failed (non-fatal)');
        }
      }

      // 2. Domain-search only if Hunter has any data. `count.total === null`
      // means the free check itself failed — treat as unknown and try
      // anyway rather than starve the pipeline.
      const hasIndex = count.total === null || count.total > 0;
      if (!hasIndex) {
        stats.companiesProcessed++;
        // Skip to posting-scrape fallback below.
      }

      // Charge 1 credit per domain-search call up front (Hunter says
      // 1 credit per 10 results; we're approximating).
      const small = isSmallCo(company);
      const pool = new Map();          // email -> emailData (top rank wins)

      if (hasIndex) {
      charge(PROVIDER, 1, budget);
      for (const q of queriesFor(company)) {
        // Skip the unfiltered catch-all if we already have hits from
        // the targeted queries — saves a credit per company that had
        // any Hunter data at all.
        if (q._isFallback && pool.size > 0) break;
        const { _isFallback, ...params } = q;
        const res = await domainSearch({ domain, ...params });
        // Capture the pattern the first time Hunter returns one — even
        // one indexed person is enough for future email-finder calls.
        if (res.pattern && !company.email_pattern) {
          try { updateCompanyEnrichment(company.id, { emailPattern: res.pattern }); }
          catch { /* non-fatal */ }
          company.email_pattern = res.pattern;
        }
        for (const e of res.emails || []) {
          if (!e.value) continue;
          const key = e.value.toLowerCase();
          const score = rankPerson(e, { isSmall: small });
          const existing = pool.get(key);
          if (!existing || score > existing._rank) {
            pool.set(key, { ...e, _rank: score });
          }
        }
        // If we already have plenty of high-rank hits, stop paying for more queries.
        if ([...pool.values()].filter(p => p._rank >= 60).length >= 3) break;
      }

      // Rank and keep top 3.
      const uniqueEmails = new Map();
      const ranked = [...pool.values()].sort((a, b) => b._rank - a._rank).slice(0, 3);
      for (const e of ranked) {
        uniqueEmails.set(e.value.toLowerCase(), {
          emailData: e,
          roleType: roleTypeForTitle(e.position),
        });
      }

      // Verify + persist up to 3 contacts.
      for (const { emailData, roleType } of uniqueEmails.values()) {
        // Prefer Hunter's inline verification field. Its status maps directly
        // via mapHunterStatus and never returns null (unknown -> 'risky').
        // Only fall back to a paid verifier call if inline verification is
        // entirely absent from the domain-search payload.
        let statusLabel;
        let rawVer = emailData.verification || null;

        if (emailData.verification?.status) {
          statusLabel = mapHunterStatus(emailData.verification.status);
        } else {
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
      }   // end: if (hasIndex)

      // Count every company we actually looked at (paid or free path).
      // The `!hasIndex` branch above already incremented, so guard against
      // double-count.
      if (hasIndex) stats.companiesProcessed++;

      // Fallback: if Hunter yielded no contact, scan the company's job
      // postings for emails that appear in the text itself. Every candidate
      // is Hunter-verified before storing so we never send to an unverified
      // address (QA 2.4). Semi-generic addresses (founders@, team@,
      // engineering@) are accepted; pure noise (noreply@) is not.
      if (contactCountForCompany(company.id) === 0) {
        const jobs = getDb().prepare(
          `SELECT description_text FROM job WHERE company_id = ? AND description_text IS NOT NULL LIMIT 20`
        ).all(company.id);
        outer: for (const j of jobs) {
          const found = contactsFromPosting({ descriptionText: j.description_text, companyDomainHint: domain });
          // Try named + semi-generic first; only fall to generic if nothing else.
          const candidates = found.filter(c => c.quality !== 'generic').concat(
            found.filter(c => c.quality === 'generic' && !NO_REPLY.has(c.local))
          );
          for (const c of candidates) {
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
              emailStatus: v.status,
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

