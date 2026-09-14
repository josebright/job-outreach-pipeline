// draft/index.js
// Module 5 per PRD. For each qualified company with a verified contact and at
// least one qualified job, ask Claude for a personalized draft, run the
// hook_evidence gate, and persist to the draft table.
import {
  companiesByStatus, contactsByCompany, jobsByCompany,
  createDraft, existingDraftFor, updateCompanyEnrichment,
  isCompanySuppressed, companyHasOpenDraft, redraftBlockedFor, addressBlockRules,
} from '../db/repo.js';
import { charge, usage } from '../enrich/cost-guard.js';
import { loadProfile } from './profile.js';
import { generateDraft } from './llm.js';
import { verifyHookEvidence } from './hook-verify.js';
import { gate3_skillsetMatch, gate4_companySize } from '../qualify/filters.js';
import { companyEnrich, employeesToBand, emailCount } from '../enrich/hunter.js';
import { logger } from '../util/logger.js';
import { isAddressBlocked } from './rejection-rules.js';
import { isCareersSubdomainEmail } from '../util/email-domain.js';
import { deriveDomain } from '../enrich/index.js';

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
    hookFailed: 0,            // real draft persisted but quote didn't verify
    skippedLlmSkip: 0,        // LLM returned "SKIP:" (no bridge/hook available)
    skippedNoContact: 0,
    skippedNoJob: 0,
    skippedExisting: 0,
    skippedBadTitle: 0,       // defensive Q1 rejected the top job's title
    skippedTooBig: 0,         // company size resolved to >500 during draft
    errors: 0,
    firstError: null,           // first error message seen, for /run surface
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
  // Address rules learned from the applicant's rejections, loaded once per pass.
  const addressRules = addressBlockRules();

  for (const company of companies) {
    stats.companiesConsidered++;

    // Belt+suspenders: qualify already skips suppressed companies, but
    // check here too. Prevents a race where /suppress ran after qualify
    // but before this draft pass.
    if (isCompanySuppressed(company.id)) {
      stats.skippedSuppressed = (stats.skippedSuppressed || 0) + 1;
      continue;
    }

    // One open draft per company. The per-(contact, job) check further down
    // only prevents re-drafting the SAME contact, so each run picked the next
    // contact at a company that already had a draft waiting - after three runs
    // Bitwarden, Chronograph, Spade and four others each had three drafts
    // queued to three different people. Three cold emails from one applicant
    // into one company reads as spray-and-pray and burns LLM credit on it.
    // Rejected and sent drafts do not block: rejection should free the company
    // to be re-drafted, and re-contact after a send is gate5's 90-day rule.
    if (companyHasOpenDraft(company.id)) {
      stats.skippedCompanyHasDraft = (stats.skippedCompanyHasDraft || 0) + 1;
      continue;
    }

    // Drop addresses the applicant has ruled out ("has founders in the email"
    // blocks every founders@), and careers-subdomain addresses such as
    // founders@jobs.dropbox.com left over from before domain normalization.
    const contacts = contactsByCompany(company.id)
      .filter(c => c.email_status !== 'invalid')
      .filter(c => !isAddressBlocked(c.email, addressRules))
      .filter(c => !isCareersSubdomainEmail(c.email));
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
      // deriveDomain rather than the raw website hostname. The raw form kept
      // jobs.dropbox.com, where Hunter indexes no mail, so the size never
      // resolved and a 3,000-person company passed the 2-500 gate. deriveDomain
      // also falls back to the job URL when website is empty, instead of
      // skipping this size check altogether.
      let domain = null;
      try {
        domain = deriveDomain(company);
      } catch (err) {
        logger.warn({ err: err.message, companyId: company.id }, 'draft: could not derive a domain for the size re-check');
      }
      if (domain) {
        try {
          // Prefer email-count as a size floor (deterministic; free) —
          // companies/find is often stale for large companies. If either
          // signal says "too big", use it.
          const [info, count] = await Promise.all([
            companyEnrich({ domain }).catch((err) => {
              logger.warn({ err: err.message, domain }, 'draft: companies/find failed, company size may stay unknown');
              return null;
            }),
            emailCount({ domain }).catch((err) => {
              logger.warn({ err: err.message, domain }, 'draft: email-count failed, company size may stay unknown');
              return { total: null };
            }),
          ]);
          let band = info ? employeesToBand(info.employeesEstimate) : null;
          if (count.total !== null && count.total >= 250) {
            band = count.total >= 800 ? '1000+' : '501-1000';
          }
          if (band) {
            updateCompanyEnrichment(company.id, {
              sizeBand: band, sizeBandSource: 'hunter', overwriteSize: true,
            });
            company.size_band = band;
            company.size_band_source = 'hunter';
          }
        } catch (err) {
          logger.warn({ err: err.message, companyId: company.id }, 'draft: size re-check failed, company size stays unverified');
        }
      }
    }
    const q6 = gate4_companySize(company, config);
    if (!q6.pass) {
      stats.skippedTooBig++;
      logger.info({ companyId: company.id, band: company.size_band, source: company.size_band_source },
        'draft: company too big, skipping');
      continue;
    }

    // Try contacts in priority order until one produces a draft.
    // Only ONE draft is created per company per run (break after success).
    // If the best contact already has a live draft (pending/approved/sent),
    // fall through to the next — this handles the case where a NEW contact
    // was discovered for a company whose original contact was already emailed.
    let drafted = false;
    for (const contact of contacts) {
      if (drafted) break;
      if (existingDraftFor(contact.id, topJob.id)) {
        stats.skippedExisting++;
        continue;
      }
      // The applicant already rejected exactly this contact for exactly this
      // role. Regenerating it is how #124 came back as #126, byte for byte.
      if (redraftBlockedFor(contact.id, topJob.id)) {
        stats.skippedRejectedBefore = (stats.skippedRejectedBefore || 0) + 1;
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

        // SKIP takes precedence over hook check. A SKIP is a deliberate no-
        // draft signal (no bridge from profile achievements to this JD, or
        // personalization floor unmet) — not a hook-verification failure.
        // Counting them together made the failure mode invisible.
        if (/^SKIP:/i.test(gen.body)) {
          stats.skippedLlmSkip++;
          logger.warn({
            contactId: contact.id, companyId: company.id, companyName: company.name,
            jobTitle: topJob.title, reason: gen.body, hookEvidence: gen.hookEvidence,
          }, 'draft skipped by LLM');
          continue;
        }

        // hookFailed only applies to persisted drafts (still saved with
        // hook_verified=0 so the reviewer sees it flagged).
        if (!hookOK) stats.hookFailed++;

        createDraft({
          contactId: contact.id,
          jobId: topJob.id,
          subject: gen.subject,
          body: gen.body,
          promptVersion: gen.promptVersion,
          hookEvidence: gen.hookEvidence,
          hookVerified: hookOK,
          model: gen.model,
          variant: gen.variant,
        });
        stats.draftsCreated++;
        drafted = true;
      } catch (err) {
        stats.errors++;
        if (!stats.firstError) stats.firstError = err.message;
        logger.error({ err: err.message, contactId: contact.id, companyId: company.id, companyName: company.name }, 'draft generation failed');
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
