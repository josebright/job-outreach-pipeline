// draft/index.js
// Module 5 per PRD. For each qualified company with a verified contact and at
// least one qualified job, ask Claude for a personalized draft, run the
// hook_evidence gate, and persist to the draft table.
import {
  companiesByStatus, contactsByCompany, jobsByCompany,
  createDraft, existingDraftFor, updateCompanyEnrichment,
} from '../db/repo.js';
import { charge, usage } from '../enrich/cost-guard.js';
import { loadProfile } from './profile.js';
import { generateDraft } from './llm.js';
import { verifyHookEvidence } from './hook-verify.js';
import { gate3_skillsetMatch, gate4_companySize } from '../qualify/filters.js';
import { companyEnrich, employeesToBand } from '../enrich/hunter.js';
import { logger } from '../util/logger.js';

// Re-export so existing tests importing from draft/index.js still work.
export { verifyHookEvidence } from './hook-verify.js';

const PROVIDER = 'anthropic';

/**
 * Draft one email per (contact, top-job) pair. Skips contacts that already
 * have a draft in a live state (pending_review | approved | sent).
 * hook_evidence gate: if the returned quote does not appear in the source,
 * we still persist the draft but with hook_verified=false so the reviewer
 * sees it flagged.
 */
export async function runDraft({ config, budgetUsd = null } = {}) {
  // Budget resolution order:
  //   1. explicit arg (used by tests)
  //   2. config.llm.monthly_budget
  //   3. hard fallback of 500
  const budget = budgetUsd ?? config?.llm?.monthly_budget ?? 500;
  const stats = {
    companiesConsidered: 0,
    draftsCreated: 0,
    hookFailed: 0,
    skippedNoContact: 0,
    skippedNoJob: 0,
    skippedExisting: 0,
    skippedBadTitle: 0,       // defensive Q1 rejected the top job's title
    skippedTooBig: 0,         // company size resolved to >500 during draft
    errors: 0,
    budgetExceeded: false,
  };

  let profile;
  try { profile = loadProfile(); }
  catch (err) {
    logger.error({ err: err.message }, 'draft aborted: profile not ready');
    return { ...stats, error: err.message };
  }

  const model = config.llm.drafts_model;
  const promptVersion = config.llm.prompt_version;

  // Prioritize small companies (2-100 employees) so the daily draft budget
  // gets spent on the tier most likely to reply. Mid-size (101-500) and
  // unknown-size companies come after. Within each tier, higher score wins.
  const companies = companiesByStatus('qualified').sort((a, b) => {
    const ta = sizeTier(a.size_band), tb = sizeTier(b.size_band);
    if (ta !== tb) return ta - tb;
    return (b.score || 0) - (a.score || 0);
  });
  for (const company of companies) {
    stats.companiesConsidered++;

    const contacts = contactsByCompany(company.id)
      .filter(c => c.email_status !== 'invalid');
    if (contacts.length === 0) { stats.skippedNoContact++; continue; }

    const qualifiedJobs = jobsByCompany(company.id)
      .filter(j => j.status === 'qualified')
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    if (qualifiedJobs.length === 0) { stats.skippedNoJob++; continue; }

    // Defensive Q1: re-check every qualified job's title before we spend
    // an Anthropic credit. Catches drift where the ATS changed the job
    // title between the last qualify pass and now, plus any bug in Q1
    // itself. Pick the first job whose title still passes Q1.
    const topJob = qualifiedJobs.find(j => gate3_skillsetMatch(j, config).pass);
    if (!topJob) {
      stats.skippedBadTitle++;
      logger.warn({
        companyId: company.id,
        titles: qualifiedJobs.slice(0, 3).map(j => j.title),
      }, 'draft: all qualified jobs failed defensive Q1 recheck');
      continue;
    }

    // Defensive Q6: verify company size before spending an LLM credit.
    // Trust source: only 'seed' and 'manual' are trusted. 'hunter' (and
    // null) must be re-verified via a fresh companies/find call — Hunter's
    // employee-count field is often 1-2 years stale for larger companies
    // (Affirm, Algolia, Canonical all cached wrong values previously).
    const trusted = company.size_band_source === 'seed' || company.size_band_source === 'manual';
    if (!trusted) {
      const domain = company.website ? new URL(
        company.website.startsWith('http') ? company.website : `https://${company.website}`
      ).hostname.replace(/^www\./, '') : null;
      if (domain) {
        try {
          const info = await companyEnrich({ domain });
          if (info) {
            const band = employeesToBand(info.employeesEstimate);
            if (band) {
              // overwriteSize: force a fresh value over the stale one.
              updateCompanyEnrichment(company.id, {
                sizeBand: band, sizeBandSource: 'hunter', overwriteSize: true,
              });
              company.size_band = band;
              company.size_band_source = 'hunter';
            }
          }
        } catch { /* non-fatal */ }
      }
    }
    const q6 = gate4_companySize(company, config);
    if (!q6.pass) {
      stats.skippedTooBig++;
      logger.info({ companyId: company.id, band: company.size_band, source: company.size_band_source },
        'draft: company too big, skipping');
      continue;
    }

    for (const contact of contacts.slice(0, 1)) {          // top 1 contact per company
      if (existingDraftFor(contact.id, topJob.id)) {
        stats.skippedExisting++;
        continue;
      }

      try {
        charge(PROVIDER, 1, budget);                       // rough call-count guard
      } catch (err) {
        if (err.name === 'BudgetExceededError') {
          stats.budgetExceeded = true;
          logger.warn({ used: err.used, budget: err.budget }, 'anthropic budget exhausted, stopping');
          return stats;
        }
        throw err;
      }

      try {
        const gen = await generateDraft({
          model, promptVersion, profile,
          company, contact, job: topJob,
          track: (topJob.track || 'A'),
        });

        // Anti-hallucination gate.
        const hookOK = verifyHookEvidence({
          hookEvidence: gen.hookEvidence,
          sourceText: topJob.description_text || '',
        });
        if (!hookOK) stats.hookFailed++;

        // If the LLM opted to skip, do not persist anything and log why.
        if (/^SKIP:/i.test(gen.body)) {
          logger.warn({ contactId: contact.id, reason: gen.body }, 'draft skipped by LLM');
          continue;
        }

        createDraft({
          contactId: contact.id,
          jobId: topJob.id,
          subject: gen.subject,
          body: gen.body,
          promptVersion: gen.promptVersion,
          hookEvidence: gen.hookEvidence,
          hookVerified: hookOK,
          model: gen.model,
        });
        stats.draftsCreated++;
      } catch (err) {
        stats.errors++;
        logger.error({ err: err.message, contactId: contact.id }, 'draft generation failed');
      }
    }
  }

  logger.info({ ...stats, budget: usage(PROVIDER, budget) }, 'draft pass complete');
  return stats;
}

/**
 * Draft-ordering tier. Lower tier goes first.
 *   tier 1: high end of band <= 100     ("2-10", "11-50", "1-50", "51-100")
 *   tier 2: unknown/null size            (charitable — might be small)
 *   tier 3: everything else (up to 500)  (Q6 already dropped 501+)
 *
 * Exported for tests.
 */
export function sizeTier(sizeBand) {
  const s = String(sizeBand || '').trim().toLowerCase();
  if (!s) return 2;
  const m = s.match(/^(\d+)\s*-\s*(\d+)/);
  if (m) {
    const hi = Number(m[2]);
    if (hi <= 100) return 1;
    return 3;
  }
  // Open-ended bands like "51+" — take the low end.
  const open = s.match(/^(\d+)\s*\+$/);
  if (open) return Number(open[1]) <= 100 ? 1 : 3;
  // Words like "small" -> treat as tier 1.
  if (/small|seed|early/.test(s)) return 1;
  return 3;
}
