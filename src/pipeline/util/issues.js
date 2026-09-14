// util/issues.js
// Collect every problem the pipeline hits and hand it back to the applicant.
//
// Every logger.warn / logger.error / logger.fatal call already in the codebase
// arrives here through the hook in util/logger.js. Each one is:
//   - attached to the current run (a /run, a cron pass, a /send), tagged with
//     the stage it happened in, so the reply for that run can list it;
//   - written to pipeline_issue, so /issues can show problems from cron runs
//     nobody was watching.
//
// A stage that throws is recorded and the run moves on to the next stage,
// instead of one failure silently discarding everything after it.
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { getDb, isDbOpen } from '../db/connection.js';
import { logger, setIssueSink } from './logger.js';

const als = new AsyncLocalStorage();
const MAX_ISSUES_PER_RUN = 500;
const LEVEL_NAME = { 40: 'warn', 50: 'error', 60: 'fatal' };
const LEVEL_RANK = { fatal: 3, error: 2, warn: 1 };

export function currentRun() {
  return als.getStore() || null;
}

/**
 * Run fn as one reportable unit. Never throws: an exception inside fn is
 * logged (and therefore recorded) and returned as { ok: false, error }.
 * @returns {Promise<{ run, ok: boolean, value?: any, error?: Error }>}
 */
export async function withRun(origin, fn) {
  const run = {
    runId: crypto.randomUUID().slice(0, 8),
    origin,
    stage: null,
    issues: [],
    counters: { dropped: 0 },
  };
  return als.run(run, async () => {
    try {
      return { run, ok: true, value: await fn(run) };
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, `${origin} aborted: ${err.message}`);
      return { run, ok: false, error: err };
    }
  });
}

/**
 * Run one pipeline stage. Issues raised inside are tagged with `stage`. If the
 * stage throws, the error is recorded and { failed: true, error } is returned
 * so the caller can carry on with the next stage.
 */
export async function runStage(stage, fn) {
  const parent = als.getStore();
  const exec = async () => {
    try {
      return await fn();
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack, stage }, `${stage} stage failed: ${err.message}`);
      return { failed: true, error: err.message };
    }
  };
  // Shares the parent's issues array and counters by reference.
  return parent ? als.run({ ...parent, stage }, exec) : exec();
}

let reentrant = false;

function recordIssue(levelNum, inputArgs) {
  if (reentrant) return;
  reentrant = true;
  try {
    const level = LEVEL_NAME[levelNum] || String(levelNum);
    const { message, detail } = parseLogArgs(inputArgs);
    const run = als.getStore();
    const stage = run?.stage || detail?.stage || null;
    const issue = { level, stage, message, detail, at: new Date().toISOString() };

    if (run) {
      if (run.issues.length < MAX_ISSUES_PER_RUN) run.issues.push(issue);
      else run.counters.dropped++;
    }
    if (isDbOpen()) {
      getDb().prepare(`
        INSERT INTO pipeline_issue (run_id, origin, stage, level, message, detail_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        run?.runId || null, run?.origin || null, stage, level, message,
        detail ? JSON.stringify(detail).slice(0, 4000) : null,
      );
    }
  } catch (err) {
    // Cannot go through logger (that is how we got here). stderr still lands
    // in Railway's logs, so a broken issue log is never itself invisible.
    process.stderr.write(`[issues] failed to record issue: ${err.message}\n`);
  } finally {
    reentrant = false;
  }
}

setIssueSink(recordIssue);

// pino call shapes: (msg), (obj, msg), (err), (err, msg).
function parseLogArgs(args) {
  const [first, second] = args || [];
  let detail = null;
  let message = '';
  if (typeof first === 'string') {
    message = first;
  } else if (first instanceof Error) {
    detail = { err: first.message, stack: first.stack };
    message = typeof second === 'string' ? second : first.message;
  } else if (first && typeof first === 'object') {
    detail = { ...first };
    if (detail.err instanceof Error) detail = { ...detail, err: detail.err.message, stack: detail.err.stack };
    message = typeof second === 'string' ? second : (detail.msg || detail.err || 'unlabelled issue');
  }
  return { message: String(message).slice(0, 500), detail };
}

/** One human line for an issue: the message plus the fields that explain it. */
export function issueText(i) {
  const d = i.detail || {};
  let t = i.message || '';
  if (d.reason && !t.includes(String(d.reason))) t += ` (${d.reason})`;
  if (d.err && !t.includes(String(d.err))) t += `: ${d.err}`;
  return t;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Telegram-ready lines. Identical issues are grouped with a count, errors
 * sort ahead of warnings, and the output is capped so a noisy run stays
 * readable.
 */
export function summarizeIssues(issues, { limit = 8, title = 'Issues this run' } = {}) {
  if (!issues || issues.length === 0) return [];
  const groups = new Map();
  for (const i of issues) {
    const text = issueText(i);
    const key = `${i.level}|${i.stage || ''}|${text}`;
    const g = groups.get(key) || { level: i.level, stage: i.stage, text, count: 0 };
    g.count++;
    groups.set(key, g);
  }
  const sorted = [...groups.values()].sort((a, b) =>
    (LEVEL_RANK[b.level] || 0) - (LEVEL_RANK[a.level] || 0) || b.count - a.count);

  const errors = issues.filter(i => i.level !== 'warn').length;
  const warns = issues.length - errors;
  const lines = [`<b>${esc(title)}:</b> ${errors} error(s), ${warns} warning(s)`];
  for (const g of sorted.slice(0, limit)) {
    const mark = g.level === 'warn' ? '⚠' : '✖';
    const count = g.count > 1 ? ` ×${g.count}` : '';
    lines.push(`  ${mark} [${esc(g.stage || 'general')}] ${esc(g.text.slice(0, 180))}${count}`);
  }
  if (sorted.length > limit) lines.push(`  …and ${sorted.length - limit} more kind(s). /issues lists everything.`);
  return lines;
}

export function recentIssues({ hours = 24, limit = 2000 } = {}) {
  if (!isDbOpen()) return [];
  return getDb().prepare(`
    SELECT * FROM pipeline_issue WHERE at > datetime('now', ?) ORDER BY id DESC LIMIT ?
  `).all(`-${hours} hours`, limit).map(r => ({
    level: r.level, stage: r.stage, message: r.message, origin: r.origin, runId: r.run_id, at: r.at,
    detail: (() => { try { return r.detail_json ? JSON.parse(r.detail_json) : null; } catch { return null; } })(),
  }));
}

/** Keep the table bounded. Called once per daily run. */
export function pruneIssues(days = 30) {
  if (!isDbOpen()) return 0;
  return getDb().prepare(`DELETE FROM pipeline_issue WHERE at < datetime('now', ?)`).run(`-${days} days`).changes;
}
