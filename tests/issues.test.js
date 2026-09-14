// tests/issues.test.js
// Every warning and error the pipeline raises must reach the applicant. Before
// this they lived only in Railway's log stream, so from Telegram a failure was
// either silence or a result with a quietly missing piece.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests, closeDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import { logger } from '../src/pipeline/util/logger.js';
import {
  withRun, runStage, summarizeIssues, recentIssues, issueText,
} from '../src/pipeline/util/issues.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `issues-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

describe('issue capture', () => {
  beforeEach(() => freshDb());

  it('captures every existing logger.warn / logger.error, tagged with its stage', async () => {
    const { run, ok } = await withRun('test', async () => {
      await runStage('enrich', async () => { logger.warn({ domain: '&' }, 'enrich: implausible domain, skipping'); });
      await runStage('draft', async () => { logger.error({ err: '401 invalid x-api-key' }, 'draft generation failed'); });
    });
    expect(ok).toBe(true);
    expect(run.issues.map(i => [i.stage, i.level, i.message])).toEqual([
      ['enrich', 'warn', 'enrich: implausible domain, skipping'],
      ['draft', 'error', 'draft generation failed'],
    ]);
  });

  it('ignores info and debug logs', async () => {
    const { run } = await withRun('test', async () => { logger.info('draft pass complete'); });
    expect(run.issues).toHaveLength(0);
  });

  it('records a stage that throws and carries on with the next stage', async () => {
    const { run, value } = await withRun('test', async () => {
      const discover = await runStage('discover', async () => { throw new Error('serp provider down'); });
      const ingest = await runStage('ingest', async () => ({ processed: 3 }));
      return { discover, ingest };
    });
    expect(value.discover).toMatchObject({ failed: true, error: 'serp provider down' });
    expect(value.ingest).toEqual({ processed: 3 });
    expect(run.issues[0]).toMatchObject({ stage: 'discover', level: 'error' });
  });

  it('returns an aborted run instead of throwing', async () => {
    const out = await withRun('test', async () => { throw new Error('config missing'); });
    expect(out.ok).toBe(false);
    expect(out.error.message).toBe('config missing');
    expect(out.run.issues.some(i => /config missing/.test(i.message))).toBe(true);
  });

  it('persists issues, so problems from unattended cron runs can be read later', async () => {
    await withRun('cron:daily', () => runStage('send', async () => { logger.warn('gmail poll failed'); }));
    const rows = recentIssues({ hours: 1 });
    expect(rows[0]).toMatchObject({ stage: 'send', level: 'warn', message: 'gmail poll failed', origin: 'cron:daily' });
  });

  it('records issues raised outside any run as well', () => {
    logger.error({ updateType: 'message' }, 'telegraf handler error');
    expect(recentIssues({ hours: 1 }).some(r => r.message === 'telegraf handler error')).toBe(true);
  });

  it('never throws when the database is not open', () => {
    closeDb();
    expect(() => logger.warn('logged before the db was opened')).not.toThrow();
  });
});

describe('summarizeIssues', () => {
  it('groups repeats with a count and lists errors before warnings', () => {
    const warn = { level: 'warn', stage: 'send', message: 'send blocked', detail: { reason: 'recipient_unverified' } };
    const lines = summarizeIssues([
      warn, warn, warn,
      { level: 'error', stage: 'draft', message: 'draft generation failed', detail: { err: '401 invalid key' } },
    ]);
    expect(lines[0]).toMatch(/1 error\(s\), 3 warning\(s\)/);
    expect(lines[1]).toMatch(/\[draft\] draft generation failed: 401 invalid key/);
    expect(lines[2]).toMatch(/\[send\] send blocked \(recipient_unverified\) ×3/);
  });

  it('caps the list and points at /issues for the rest', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ level: 'warn', stage: 'x', message: `problem ${i}` }));
    const lines = summarizeIssues(many, { limit: 5 });
    expect(lines).toHaveLength(7);
    expect(lines[6]).toMatch(/15 more kind\(s\)/);
  });

  it('escapes HTML so an error message cannot break the Telegram reply', () => {
    const [, line] = summarizeIssues([{ level: 'error', stage: 'draft', message: 'bad <tag> & stuff' }]);
    expect(line).toContain('bad &lt;tag&gt; &amp; stuff');
  });

  it('returns nothing for a clean run', () => {
    expect(summarizeIssues([])).toEqual([]);
  });

  it('does not repeat a reason or error already in the message', () => {
    expect(issueText({ message: 'failed: 401', detail: { err: '401' } })).toBe('failed: 401');
  });
});
