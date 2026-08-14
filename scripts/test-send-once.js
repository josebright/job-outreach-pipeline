#!/usr/bin/env node
// scripts/test-send-once.js
// ONE-TIME test: runs the daily chain, auto-approves the single best pending
// draft, sends it, then reports. Used to verify the full server-side pipeline
// with a real outbound email.
//
// Selection rule for the "single best" draft, in order:
//   1. hook_verified = 1 (the LLM's quote was found in the source posting)
//   2. company score highest
//   3. draft id lowest (deterministic tie-break)
//
// After this test runs successfully, remove this script's cron schedule
// (railway.json startCommand back to `pipeline:daily`, cronSchedule back
// to `0 7 * * *`).
import { loadConfig } from '../src/pipeline/config/loader.js';
import { getDb, closeDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  draftsByStatus, updateDraftStatus, companyById, contactById,
} from '../src/pipeline/db/repo.js';
import { runDiscover } from '../src/pipeline/discover/index.js';
import { runIngest } from '../src/pipeline/ingest/index.js';
import { runQualify } from '../src/pipeline/qualify/index.js';
import { runEnrich } from '../src/pipeline/enrich/index.js';
import { runDraft } from '../src/pipeline/draft/index.js';
import { runSend } from '../src/pipeline/send/index.js';
import { runReport } from '../src/pipeline/report/index.js';
import { logger } from '../src/pipeline/util/logger.js';

async function main() {
  const config = loadConfig();
  getDb();
  runMigrations();

  logger.warn('TEST-SEND-ONCE: will auto-approve one draft after this run. Do not leave this cron in production.');

  await runDiscover({ config });
  await runIngest({ config });
  await runQualify({ config });
  await runEnrich({ config });
  await runDraft({ config });

  const db = getDb();
  const pending = draftsByStatus('pending_review');
  if (pending.length === 0) {
    logger.warn('no pending drafts to send; skipping send step');
    await runReport({ config });
    closeDb();
    return;
  }

  const top = pickBestDraft(pending, db);
  if (!top) {
    logger.warn('no draft passed the safety filter (hook_verified + verified contact); skipping send');
    await runReport({ config });
    closeDb();
    return;
  }

  const contact = contactById(top.contact_id);
  const company = contact ? companyById(contact.company_id) : null;
  logger.warn({
    draftId: top.id,
    company: company?.name,
    companyScore: company?.score,
    contactEmail: contact?.email,
    contactRole: contact?.role_type,
    subject: top.subject,
    hookVerified: Boolean(top.hook_verified),
    bodyPreview: (top.body || '').slice(0, 200),
  }, 'AUTO-APPROVING SINGLE DRAFT FOR END-TO-END TEST');

  updateDraftStatus(top.id, 'approved');
  await runSend({ config });
  await runReport({ config });
  closeDb();
}

// Prefer drafts whose hook_evidence is verified AND whose contact email
// status is 'verified'. Fall back to any hook_verified draft. Never send
// something whose hook failed the anti-hallucination gate.
function pickBestDraft(drafts, db) {
  const enriched = drafts.map(d => {
    const contact = db.prepare('SELECT * FROM contact WHERE id = ?').get(d.contact_id);
    const company = contact ? db.prepare('SELECT * FROM company WHERE id = ?').get(contact.company_id) : null;
    return {
      draft: d,
      hookVerified: Boolean(d.hook_verified),
      emailVerified: contact?.email_status === 'verified',
      companyScore: company?.score ?? 0,
    };
  });

  const strict = enriched
    .filter(x => x.hookVerified && x.emailVerified)
    .sort((a, b) => b.companyScore - a.companyScore || a.draft.id - b.draft.id);
  if (strict.length) return strict[0].draft;

  const relaxed = enriched
    .filter(x => x.hookVerified)
    .sort((a, b) => b.companyScore - a.companyScore || a.draft.id - b.draft.id);
  if (relaxed.length) return relaxed[0].draft;

  return null;
}

main().catch(err => {
  logger.error({ err: err.message, stack: err.stack }, 'test-send-once failed');
  process.exit(1);
});
