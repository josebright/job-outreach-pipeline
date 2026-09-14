// pipeline/run.js
// The one full-pipeline sequence and the one send pass, shared by the Telegram
// commands and the cron jobs in scripts/service.js.
//
// Both used to carry their own copy of the sequence and their own notion of
// "already running" (the cron had a local flag, /run had none), so a /run that
// overlapped the daily cron could draft the same company twice, and a /send
// that overlapped the send cron could deliver the same approved email twice.
import { runDiscover } from './discover/index.js';
import { runIngest } from './ingest/index.js';
import { runQualify } from './qualify/index.js';
import { runEnrich } from './enrich/index.js';
import { runDraft } from './draft/index.js';
import { runSend } from './send/index.js';
import { loadConfig } from './config/loader.js';
import { withLock } from './util/run-lock.js';
import { withRun, runStage, pruneIssues } from './util/issues.js';

/**
 * @returns {Promise<{ busy: true, info } | { busy: false, run, stats, error }>}
 */
export async function runPipeline({ origin, config = null }) {
  const locked = await withLock('pipeline', origin, () => withRun(origin, async () => {
    const cfg = config ?? loadConfig();
    const stats = {};
    // Each stage is isolated: one that throws is recorded as an issue and the
    // run continues on the data already in the database.
    stats.discover = await runStage('discover', () => runDiscover({ config: cfg }));
    stats.ingest   = await runStage('ingest',   () => runIngest({ config: cfg }));
    stats.qualify  = await runStage('qualify',  () => runQualify({ config: cfg }));
    stats.enrich   = await runStage('enrich',   () => runEnrich({ config: cfg }));
    stats.draft    = await runStage('draft',    () => runDraft({ config: cfg }));
    // The old "0 drafts? run enrich + draft again" retry is gone. Enrich now
    // retries a company at most weekly, so a second pass seconds later could
    // not find anything new - it only doubled the counts in the report.
    try { pruneIssues(30); } catch { /* bounded table upkeep, never worth failing a run */ }
    return stats;
  }));
  if (locked.busy) return { busy: true, info: locked.info };
  const { run, ok, value, error } = locked.result;
  return { busy: false, run, stats: ok ? value : null, error: ok ? null : error };
}

/**
 * @returns {Promise<{ busy: true, info } | { busy: false, run, stats, error }>}
 */
export async function runSendPass({ origin, config = null }) {
  const locked = await withLock('send', origin, () => withRun(origin, () =>
    runStage('send', () => runSend({ config: config ?? loadConfig() }))));
  if (locked.busy) return { busy: true, info: locked.info };
  const { run, ok, value, error } = locked.result;
  return { busy: false, run, stats: ok ? value : null, error: ok ? null : error };
}
