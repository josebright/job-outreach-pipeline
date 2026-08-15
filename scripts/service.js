#!/usr/bin/env node
// scripts/service.js
// Always-on Railway entry. Runs:
//   1. Telegraf bot for interactive review (long-polling).
//   2. Internal node-cron scheduler for the daily pipeline.
//   3. Health heartbeat every 6 hours so a stuck process shows in logs.
//
// Every path exits with code 0 when possible so env-var redeploys are not
// mislabelled as crashes by Railway's alert system.
import cron from 'node-cron';
import { loadConfig } from '../src/pipeline/config/loader.js';
import { getDb, closeDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import { runDiscover } from '../src/pipeline/discover/index.js';
import { runIngest } from '../src/pipeline/ingest/index.js';
import { runQualify } from '../src/pipeline/qualify/index.js';
import { runEnrich } from '../src/pipeline/enrich/index.js';
import { runDraft } from '../src/pipeline/draft/index.js';
import { runReport } from '../src/pipeline/report/index.js';
import { startBot, stopBot } from '../src/pipeline/bot/index.js';
import { notify } from '../src/pipeline/bot/telegram.js';
import { logger } from '../src/pipeline/util/logger.js';

const DAILY_SCHEDULE = process.env.PIPELINE_DAILY_CRON || '0 7 * * *';   // 07:00 UTC
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

let running = false;

async function dailyRun() {
  if (running) {
    logger.warn('daily run already in progress, skipping this fire');
    return;
  }
  running = true;
  const started = Date.now();
  try {
    const config = loadConfig();
    logger.info({ schedule: DAILY_SCHEDULE }, 'daily run started');
    await runDiscover({ config });
    await runIngest({ config });
    await runQualify({ config });
    await runEnrich({ config });
    await runDraft({ config });
    const rep = await runReport({ config });

    const durationSec = Math.round((Date.now() - started) / 1000);
    logger.info({ durationSec }, 'daily run complete');

    const pending = rep?.totals?.drafts_pending ?? 0;
    if (pending > 0) {
      await notify(
        [
          '<b>Daily pipeline done.</b>',
          `<b>${pending}</b> new draft(s) awaiting your review.`,
          `Jobs qualified: ${rep.totals.jobs_qualified}`,
          `Contacts: ${rep.totals.contacts_total} (${rep.totals.contacts_verified} verified)`,
          '',
          'Use /list to see the queue.',
        ].join('\n'),
      );
    }
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'daily run failed');
    try { await notify(`<b>Pipeline error:</b> ${err.message.slice(0, 200)}`); } catch { /* ignore */ }
  } finally {
    running = false;
  }
}

async function main() {
  getDb();
  runMigrations();
  logger.info('service boot: migrations applied');

  startBot();

  cron.schedule(DAILY_SCHEDULE, dailyRun, { timezone: 'UTC' });
  logger.info({ cron: DAILY_SCHEDULE }, 'daily cron scheduled');

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
