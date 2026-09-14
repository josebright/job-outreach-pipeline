#!/usr/bin/env node
// scripts/service.js
// Always-on Railway entry. Runs:
//   1. Telegraf bot for interactive review (long-polling).
//   2. Daily pipeline cron (07:00 UTC) — discover → ingest → qualify →
//      enrich → draft → report. Creates pending_review drafts, notifies
//      you via Telegram if any land.
//   3. Send cron (07:30 UTC = 08:30 WAT, inside the send window) — sends
//      drafts already in status='approved'. Pending drafts are never
//      auto-approved and never auto-sent; you must /approve them first.
//   4. Health heartbeat every 6 hours so a stuck process shows in logs.
//
// Every path exits with code 0 when possible so env-var redeploys are not
// mislabelled as crashes by Railway's alert system.
import cron from 'node-cron';
import { loadConfig } from '../src/pipeline/config/loader.js';
import { getDb, closeDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import { runReport } from '../src/pipeline/report/index.js';
import { runPipeline, runSendPass } from '../src/pipeline/run.js';
import { summarizeIssues } from '../src/pipeline/util/issues.js';
import { lockInfo } from '../src/pipeline/util/run-lock.js';
import { startBot, stopBot } from '../src/pipeline/bot/index.js';
import { notify } from '../src/pipeline/bot/telegram.js';
import { logger } from '../src/pipeline/util/logger.js';

const DAILY_SCHEDULE = process.env.PIPELINE_DAILY_CRON || '0 7 * * *';   // 07:00 UTC
// Send cron fires once inside the applicant's send window
// (config.send.send_window_local_start = 08:30 WAT = 07:30 UTC).
// Approved drafts go out; pending / rejected are untouched.
const SEND_SCHEDULE = process.env.PIPELINE_SEND_CRON || '30 7 * * *';    // 07:30 UTC = 08:30 WAT
const HEARTBEAT_SCHEDULE = '0 */6 * * *';                                 // every 6h

// ── Global error guards ─────────────────────────────────────
// Catch anything that would otherwise take the process down with a
// non-zero exit code and trigger a Railway "Deploy Crashed" email.
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'uncaughtException (swallowed)');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason?.message || String(reason) }, 'unhandledRejection (swallowed)');
});

// Overlap protection lives in util/run-lock.js, shared with the Telegram
// /run and /send commands - see pipeline/run.js.

async function dailyRun() {
  const started = Date.now();
  logger.info({ schedule: DAILY_SCHEDULE }, 'daily run started');
  const out = await runPipeline({ origin: 'cron:daily' });
  if (out.busy) {
    logger.info({ holder: out.info?.holder }, 'daily run skipped: a pipeline run is already in progress');
    return;
  }
  const durationSec = Math.round((Date.now() - started) / 1000);
  logger.info({ durationSec, issues: out.run?.issues?.length || 0 }, 'daily run complete');

  let rep = null;
  try {
    rep = await runReport({ config: loadConfig() });
  } catch (err) {
    logger.error({ err: err.message }, 'daily report failed');
  }

  const pending = rep?.totals?.drafts_pending ?? 0;
  const issues = summarizeIssues(out.run?.issues);
  // Notify when there is something to act on: drafts to review, OR problems.
  // Previously a run that failed quietly sent nothing at all.
  if (pending === 0 && issues.length === 0 && !out.error) return;
  const lines = [out.error
    ? `<b>Daily pipeline aborted:</b> ${out.error.message.slice(0, 200)}`
    : '<b>Daily pipeline done.</b>'];
  if (rep) {
    lines.push(
      `<b>${pending}</b> draft(s) awaiting your review.`,
      `Jobs qualified: ${rep.totals.jobs_qualified}`,
      `Contacts: ${rep.totals.contacts_total} (${rep.totals.contacts_verified} verified)`,
    );
  }
  if (issues.length) lines.push('', ...issues);
  lines.push('', pending > 0 ? 'Use /list to see the queue.' : 'Use /issues for the full list.');
  await notify(lines.join('\n'));
}

/**
 * Send cron. Fires once per day inside the applicant's send window.
 * Only sends drafts already in status='approved' — pending drafts are
 * never auto-approved and never auto-sent. This is a scheduled version
 * of the /send Telegram command.
 *
 * Skips fire if the dailyRun is still running (draft generation shouldn't
 * race with sending).
 */
async function sendRun() {
  if (lockInfo('pipeline')) {
    logger.info('daily pipeline still running, deferring send fire');
    return;
  }
  logger.info({ schedule: SEND_SCHEDULE }, 'send cron started');
  const out = await runSendPass({ origin: 'cron:send' });
  if (out.busy) {
    logger.info({ holder: out.info?.holder }, 'send cron skipped: a send pass is already in progress');
    return;
  }
  const stats = out.stats && !out.stats.failed ? out.stats : null;
  logger.info(stats || {}, 'send cron complete');

  const sent = (stats?.initialSent || 0) + (stats?.researchSent || 0);
  const issues = summarizeIssues(out.run?.issues);
  if (sent === 0 && issues.length === 0 && !stats?.paused && !out.error) return;
  await notify([
    out.error ? `<b>Send window aborted:</b> ${out.error.message.slice(0, 200)}` : '<b>Send window complete.</b>',
    stats ? `Initial: ${stats.initialSent || 0}${stats.researchSent ? ` (+${stats.researchSent} research)` : ''}` : '',
    stats?.paused ? '<b>PAUSED</b> — bounce alarm tripped. /diag shows why.' : '',
    ...(issues.length ? ['', ...issues] : []),
  ].filter(Boolean).join('\n'));
}

async function main() {
  getDb();
  runMigrations();
  logger.info('service boot: migrations applied');

  startBot();

  cron.schedule(DAILY_SCHEDULE, dailyRun, { timezone: 'UTC' });
  logger.info({ cron: DAILY_SCHEDULE }, 'daily cron scheduled');

  cron.schedule(SEND_SCHEDULE, sendRun, { timezone: 'UTC' });
  logger.info({ cron: SEND_SCHEDULE }, 'send cron scheduled');

  cron.schedule(HEARTBEAT_SCHEDULE, () => {
    logger.info({ uptime_s: Math.round(process.uptime()) }, 'heartbeat');
  }, { timezone: 'UTC' });

  if (process.env.RUN_ON_BOOT === '1') {
    logger.warn('RUN_ON_BOOT=1 detected; running pipeline immediately');
    await dailyRun();
  }

  // ── Graceful shutdown ──────────────────────────────────────
  // Received SIGTERM/SIGINT (Railway redeploy, env-var change, manual stop).
  // Stop the bot's long-poll, close the DB, exit 0 within a bounded time so
  // Railway does not consider us "crashed".
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, 'shutdown: signal received, exiting cleanly');
    try { stopBot(sig); } catch (e) { logger.warn({ err: e.message }, 'shutdown: stopBot errored'); }
    try { closeDb(); }   catch (e) { logger.warn({ err: e.message }, 'shutdown: closeDb errored'); }
    // Force exit after 3s even if something upstream holds the loop open.
    setTimeout(() => process.exit(0), 3000).unref();
    // Small delay to let logs flush.
    await new Promise(r => setTimeout(r, 250));
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP',  () => shutdown('SIGHUP'));

  logger.info('service running; waiting for bot commands and cron fires');
}

main().catch(err => {
  // Log the reason and exit 0 so Railway does not flag as crashed on startup.
  // If the reason is a real permanent misconfiguration, restart policy
  // will still cycle it, but no crash email per exit.
  logger.error({ err: err.message, stack: err.stack }, 'service startup failed (exiting 0)');
  process.exit(0);
});
