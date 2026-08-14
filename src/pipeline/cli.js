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

  async qualify() {
    const config = loadConfig();
    getDb();
    runMigrations();
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
  },
};

const argv = yargs(hideBin(process.argv))
  .command('init',     'Create SQLite DB and run pending migrations')
  .command('discover', 'Module 1: find company slugs (seed + SERP dorks + aggregators)')
  .command('ingest',   'Module 2: fetch jobs from each ATS')
  .command('qualify',  'Module 3: apply hard filters + score')
  .command('enrich',   'Module 4: find contacts + verify emails')
  .command('draft',    'Module 5: generate personalized drafts')
  .command('send',     'Module 6: send approved drafts (with all safety gates)')
  .command('report',   'Module 7: funnel report')
  .demandCommand(1, 'Specify a command: init | discover | ingest | qualify | enrich | draft | send | report')
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
    await fn();
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'command failed');
    process.exit(1);
  } finally {
    closeDb();
  }
}

main();
