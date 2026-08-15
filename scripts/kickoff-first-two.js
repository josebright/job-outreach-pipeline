#!/usr/bin/env node
// scripts/kickoff-first-two.js
// One-time kickoff: run the daily pipeline, then auto-approve up to TWO
// pending drafts and send. Guardrails:
//   - Only approve drafts where hook_verified = 1 AND email_status = 'verified'.
//   - Sort by company.score desc, then draft.id asc.
//   - Never approve more than 2 in this run.
//   - Send loop still respects warm-up cap, suppression list, and daily cap.
//
// Intended usage: run once via `railway ssh` on Day 1 to seed the pipeline.
// Delete this file after use.
import { loadConfig } from '../src/pipeline/config/loader.js';
import { getDb, closeDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  draftsByStatus, contactById, companyById, updateDraftStatus,
} from '../src/pipeline/db/repo.js';
import { runDiscover } from '../src/pipeline/discover/index.js';
import { runIngest } from '../src/pipeline/ingest/index.js';
import { runQualify } from '../src/pipeline/qualify/index.js';
import { runEnrich } from '../src/pipeline/enrich/index.js';
import { runDraft } from '../src/pipeline/draft/index.js';
import { runSend } from '../src/pipeline/send/index.js';
import { runReport } from '../src/pipeline/report/index.js';
import { logger } from '../src/pipeline/util/logger.js';

const MAX_APPROVALS = 2;

async function main() {
  const config = loadConfig();
  getDb();
  runMigrations();
  logger.warn('KICKOFF: running daily chain then auto-approving up to 2 drafts');

  await runDiscover({ config });
  await runIngest({ config });
  await runQualify({ config });
  await runEnrich({ config });
  await runDraft({ config });

  const pending = draftsByStatus('pending_review');
  logger.info({ pending: pending.length }, 'draft pass complete; selecting for approval');

  const scored = pending
    .map(d => {
      const contact = contactById(d.contact_id);
      const company = contact ? companyById(contact.company_id) : null;
      return {
        draft: d,
        hookVerified: Boolean(d.hook_verified),
        emailVerified: contact?.email_status === 'verified',
        companyScore: company?.score ?? 0,
        companyName: company?.name,
        contactEmail: contact?.email,
      };
    })
    .filter(x => x.hookVerified && x.emailVerified)
    .sort((a, b) => b.companyScore - a.companyScore || a.draft.id - b.draft.id)
    .slice(0, MAX_APPROVALS);

  if (scored.length === 0) {
    logger.warn('no drafts passed the safety filter (hook_verified + verified email); nothing to auto-approve');
    await runReport({ config });
    closeDb();
    return;
  }

  for (const { draft, companyName, contactEmail } of scored) {
    logger.warn({ draftId: draft.id, company: companyName, to: contactEmail, subject: draft.subject },
      'KICKOFF: approving');
    updateDraftStatus(draft.id, 'approved');
  }

  await runSend({ config });
  await runReport({ config });
  closeDb();
}

main().catch(err => {
  logger.error({ err: err.message, stack: err.stack }, 'kickoff failed');
  process.exit(1);
});
