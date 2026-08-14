// draft/index.js
// Module 5 per PRD. For each qualified company with a verified contact and at
// least one qualified job, ask Claude for a personalized draft, run the
// hook_evidence gate, and persist to the draft table.
import {
  companiesByStatus, contactsByCompany, jobsByCompany,
  createDraft, existingDraftFor,
} from '../db/repo.js';
import { charge, usage } from '../enrich/cost-guard.js';
import { loadProfile } from './profile.js';
import { generateDraft } from './llm.js';
import { verifyHookEvidence } from './hook-verify.js';
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
export async function runDraft({ config, budgetUsd = 20 } = {}) {
  const stats = {
    companiesConsidered: 0,
    draftsCreated: 0,
    hookFailed: 0,
    skippedNoContact: 0,
    skippedNoJob: 0,
    skippedExisting: 0,
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

  const companies = companiesByStatus('qualified');
  for (const company of companies) {
    stats.companiesConsidered++;

    const contacts = contactsByCompany(company.id)
      .filter(c => c.email_status !== 'invalid');
    if (contacts.length === 0) { stats.skippedNoContact++; continue; }

    const qualifiedJobs = jobsByCompany(company.id)
      .filter(j => j.status === 'qualified')
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    if (qualifiedJobs.length === 0) { stats.skippedNoJob++; continue; }
    const topJob = qualifiedJobs[0];

    for (const contact of contacts.slice(0, 1)) {          // top 1 contact per company
      if (existingDraftFor(contact.id, topJob.id)) {
        stats.skippedExisting++;
        continue;
      }

      try {
        charge(PROVIDER, 1, budgetUsd);                    // rough call-count guard
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

  logger.info({ ...stats, budget: usage(PROVIDER, budgetUsd) }, 'draft pass complete');
  return stats;
}
