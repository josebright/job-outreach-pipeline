#!/usr/bin/env node
// pipeline/cli.js
// One entry point for every module. yargs subcommands, one per module.
// Idempotent: any command is safe to re-run.
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { getDb, closeDb } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { loadConfig } from './config/loader.js';
import { logger } from './util/logger.js';
import { runDiscover } from './discover/index.js';
import { runIngest } from './ingest/index.js';
import { runQualify } from './qualify/index.js';
import { runEnrich } from './enrich/index.js';
import { runDraft } from './draft/index.js';
import { runSend } from './send/index.js';
import { runReport } from './report/index.js';
import { reviewList, reviewShow, reviewApprove, reviewReject, reviewEdit, reviewMarkReplied } from './review/index.js';

const commands = {
  async init() {
    getDb();
    const { applied, skipped } = runMigrations();
    logger.info({ applied, skipped }, 'init complete');
  },

  async discover() {
    const config = loadConfig();
    getDb();
    runMigrations();
    const stats = await runDiscover({ config });
    logger.info(stats, 'discover complete');
  },

  async ingest() {
    const config = loadConfig();
    getDb();
    runMigrations();
    const stats = await runIngest({ config });
    logger.info(stats, 'ingest complete');
  },

  async qualify(argv) {
    const config = loadConfig();
    getDb();
    runMigrations();
    if (argv.eval) {
      const { evaluateAgainstLabels } = await import('./qualify/evaluate.js');
      const result = evaluateAgainstLabels({ csvPath: argv.eval, config });
      const passedPrecision = result.precision >= 0.90;
      const passedRecall    = result.recall    >= 0.80;
      logger.info({
        ...result,
        misses: result.misses.slice(0, 20),
        acceptancePassed: passedPrecision && passedRecall,
      }, `eval: precision=${result.precision.toFixed(3)} recall=${result.recall.toFixed(3)} f1=${result.f1.toFixed(3)}`);
      process.exit(passedPrecision && passedRecall ? 0 : 1);
    }
    const stats = await runQualify({ config });
    logger.info(stats, 'qualify complete');
  },

  async enrich() {
    const config = loadConfig();
    getDb();
    runMigrations();
    const stats = await runEnrich({ config });
    logger.info(stats, 'enrich complete');
  },

  async draft() {
    const config = loadConfig();
    getDb();
    runMigrations();
    const stats = await runDraft({ config });
    logger.info(stats, 'draft complete');
  },

  async send() {
    const config = loadConfig();
    getDb();
    runMigrations();
    const stats = await runSend({ config });
    logger.info(stats, 'send complete');
  },

  async report() {
    const config = loadConfig();
    getDb();
    runMigrations();
    const stats = await runReport({ config });
    logger.info(stats, 'report complete');
    // Best-effort Telegram digest so manual `pipeline report` runs still
    // notify. Silent if TELEGRAM_BOT_TOKEN is not set.
    const pending = stats?.totals?.drafts_pending ?? 0;
    if (pending > 0) {
      const { notify } = await import('./bot/telegram.js');
      await notify(`Report ping: ${pending} draft(s) pending review. Use /list.`);
    }
  },

  async review(argv) {
    loadConfig();
    getDb();
    runMigrations();
    const sub = argv._[1] || 'list';
    const arg = argv._[2];
    switch (sub) {
      case 'list':         return reviewList();
      case 'show':         return reviewShow(arg);
      case 'approve':      return reviewApprove(arg);
      case 'reject':       return reviewReject(arg, argv.reason);
      case 'edit':         return reviewEdit(arg);
      case 'mark-replied': return reviewMarkReplied(arg);
      default:
        logger.error({ sub }, 'unknown review subcommand (list|show|approve|reject|edit|mark-replied)');
        process.exit(1);
    }
  },
};

const argv = yargs(hideBin(process.argv))
  .command('init',     'Create SQLite DB and run pending migrations')
  .command('discover', 'Module 1: find company slugs (seed + SERP dorks + aggregators)')
  .command('ingest',   'Module 2: fetch jobs from each ATS')
  .command('qualify',  'Module 3: apply hard filters + score', (y) => {
    y.option('eval', {
      type: 'string',
      describe: 'Path to labeled CSV (job_id,expected) for precision/recall harness. Exits non-zero if targets missed.',
    });
  })
  .command('enrich',   'Module 4: find contacts + verify emails')
  .command('draft',    'Module 5: generate personalized drafts')
  .command('send',     'Module 6: send approved drafts (with all safety gates)')
  .command('report',   'Module 7: funnel report')
  .command('review',   'Review pending drafts (list|show|approve|reject|edit)', (y) => {
    y.option('reason', { type: 'string', describe: 'Reject reason (for review reject)' });
  })
  .demandCommand(1, 'Specify a command: init | discover | ingest | qualify | enrich | draft | send | report | review')
  .strict()
  .help()
  .version('3.0.0-alpha')
  .argv;

async function main() {
  const command = argv._[0];
  const fn = commands[command];
  if (!fn) {
    logger.error({ command }, 'unknown command');
    process.exit(1);
  }
  try {
    await fn(argv);
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'command failed');
    process.exit(1);
  } finally {
    closeDb();
  }
}

main();
