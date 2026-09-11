// tests/bounce-pause.test.js
// The bounce-alarm pause must always have an exit path. The previous build
// wrote a PAUSED row that no code path ever deleted, so one bounce spike
// disabled sending permanently and stranded the approved queue.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests, getDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  isPaused, pauseState, pauseSending, clearPause, bounceRate,
} from '../src/pipeline/send/reply-detect.js';
import { upsertCompany, upsertContact, createDraft } from '../src/pipeline/db/repo.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `pause-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

const DAY = 86400;
const nowEpoch = () => Math.floor(Date.now() / 1000);

// Write the PAUSED row directly with a chosen timestamp.
function pausedAt(epoch) {
  getDb().prepare(
    `INSERT OR REPLACE INTO send_counter (date, kind, count) VALUES ('PAUSED', 'alarm', ?)`
  ).run(epoch);
}

function pausedRowCount() {
  return getDb().prepare(
    `SELECT COUNT(*) AS n FROM send_counter WHERE date = 'PAUSED' AND kind = 'alarm'`
  ).get().n;
}

describe('bounce-alarm pause lifecycle', () => {
  beforeEach(() => freshDb());

  it('is not paused on a clean database', () => {
    expect(isPaused()).toBe(false);
    expect(pauseState().paused).toBe(false);
  });

  it('pauses when pauseSending is called', () => {
    pauseSending({ bounceRatePct: 12, cap: 3 });
    expect(isPaused()).toBe(true);
    expect(pauseState().paused).toBe(true);
  });

  it('stays paused inside the cooldown window', () => {
    pausedAt(nowEpoch() - 2 * DAY);
    expect(isPaused()).toBe(true);
  });

  it('auto-lifts once the 7-day cooldown elapses', () => {
    pausedAt(nowEpoch() - 8 * DAY);
    expect(isPaused()).toBe(false);
  });

  it('deletes the expired row on read so it cannot linger forever', () => {
    pausedAt(nowEpoch() - 8 * DAY);
    expect(pausedRowCount()).toBe(1);
    isPaused();
    expect(pausedRowCount()).toBe(0);
  });

  it('self-heals a legacy count=1 row written by the old never-clearing build', () => {
    // This is the exact row shape stranding the live queue: count=1 reads as
    // epoch 1970, so it is already past cooldown and clears on first read.
    pausedAt(1);
    expect(pauseState().expired).toBe(true);
    expect(isPaused()).toBe(false);
    expect(pausedRowCount()).toBe(0);
  });

  it('clearPause reports whether it actually cleared anything', () => {
    expect(clearPause('test')).toBe(false);
    pauseSending({});
    expect(clearPause('test')).toBe(true);
    expect(isPaused()).toBe(false);
  });
});

describe('bounceRate', () => {
  beforeEach(() => freshDb());

  it('returns a zero rate when there are no sends in the window', () => {
    const r = bounceRate();
    expect(r.total).toBe(0);
    expect(r.bounces).toBe(0);
    expect(r.pct).toBe(0);
  });

  it('counts only outbound messages inside the 7-day window', () => {
    const db = getDb();
    const co = upsertCompany({ name: 'Acme', ats: 'greenhouse', slug: 'acme', source: 'seed' });
    const ct = upsertContact({
      companyId: co.id, fullName: 'A', title: 'CTO', roleType: 'founder',
      email: 'a@acme.io', emailStatus: 'verified', source: 'hunter',
    });
    const d = createDraft({
      contactId: ct.id, subject: 's', body: 'b',
      promptVersion: 'outreach_v1', hookVerified: true,
    });
    const ins = db.prepare(`
      INSERT INTO message (draft_id, direction, kind, sent_at, bounced)
      VALUES (?, 'outbound', 'initial', datetime('now', ?), ?)
    `);
    ins.run(d.id, '-1 days', 1);
    ins.run(d.id, '-1 days', 0);
    ins.run(d.id, '-2 days', 0);
    ins.run(d.id, '-30 days', 1);     // outside window, must not count

    const r = bounceRate();
    expect(r.total).toBe(3);
    expect(r.bounces).toBe(1);
    expect(r.pct).toBeCloseTo(33.3, 0);
  });
});
