#!/usr/bin/env node
// scripts/service.js
// Always-on Railway entry. Runs:
//   1. Telegraf bot for interactive review (long-polling).
//   2. Internal node-cron scheduler for the daily pipeline.
//   3. Health heartbeat every 6 hours so a stuck process shows in logs.
//
// A single service also means: SSH into it any time to run CLI commands.
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
    const dis = await runDiscover({ config });
    const ing = await runIngest({ config });
    const qua = await runQualify({ config });
    const enr = await runEnrich({ config });
    const drf = await runDraft({ config });
    const rep = await runReport({ config });

    const durationSec = Math.round((Date.now() - started) / 1000);
    logger.info({ durationSec }, 'daily run complete');

    // Notify user in Telegram so they know drafts are ready.
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
    await notify(`<b>Pipeline error:</b> ${err.message.slice(0, 200)}`);
  } finally {
    running = false;
  }
}

async function main() {
  // One-time init: migrations run once at boot, then again defensively on cron.
  getDb();
  runMigrations();
  logger.info('service boot: migrations applied');

  startBot();

  cron.schedule(DAILY_SCHEDULE, dailyRun, { timezone: 'UTC' });
  logger.info({ cron: DAILY_SCHEDULE }, 'daily cron scheduled');

  cron.schedule(HEARTBEAT_SCHEDULE, () => {
    logger.info({ uptime_s: Math.round(process.uptime()) }, 'heartbeat');
  }, { timezone: 'UTC' });

  // Optional: run once on boot if REQUESTED. Off by default so redeploys
  // don't accidentally trigger a real pipeline.
  if (process.env.RUN_ON_BOOT === '1') {
    logger.warn('RUN_ON_BOOT=1 detected; running pipeline immediately');
    await dailyRun();
  }

  const shutdown = (sig) => {
    logger.info({ sig }, 'shutdown signal received');
    stopBot(sig);
    closeDb();
    // Give logs a beat to flush.
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('service running; waiting for bot commands and cron fires');
}

main().catch(err => {
  logger.error({ err: err.message, stack: err.stack }, 'service crashed');
  process.exit(1);
});
