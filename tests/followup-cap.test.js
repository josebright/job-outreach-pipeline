// tests/followup-cap.test.js
// daily_cap_followup must be ONE budget shared by both follow-up kinds.
// Previously each kind incremented its own counter (followup_1 / followup_2)
// while the loop-break read a third counter ('followup') that nothing ever
// wrote — so a cap of 15 permitted 15 + 15, and a live send pass pushed 19
// follow-ups out in a single burst from a warming domain.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, upsertContact, createDraft, updateDraftStatus, getSendCount,
} from '../src/pipeline/db/repo.js';
import { sendApprovedDraft, SendBlockedError } from '../src/pipeline/send/index.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `fcap-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

const fakeTransport = { send: async () => ({ messageId: 'm@x', threadId: 't' }) };

function seed(email = 'a@acme.io') {
  const c = upsertCompany({ name: 'Acme', ats: 'lever', slug: `acme-${Math.random().toString(36).slice(2)}`, source: 'seed' });
  const ct = upsertContact({
    companyId: c.id, fullName: 'A', title: 'CTO', roleType: 'founder',
    email, emailStatus: 'verified', source: 'hunter',
  });
  const d = createDraft({ contactId: ct.id, subject: 's', body: 'b', promptVersion: 'v1', hookVerified: true });
  updateDraftStatus(d.id, 'approved');
  return { draft: { id: d.id, status: 'approved', subject: 's', body: 'b' }, email };
}

async function sendFollowup(kind, caps) {
  const { draft, email } = seed(`u${Math.random().toString(36).slice(2)}@acme.io`);
  return sendApprovedDraft({
    draft, recipientEmail: email, kind, caps, transport: fakeTransport,
    counterKind: 'followup',
  });
}

describe('follow-up daily cap', () => {
  beforeEach(() => freshDb());

  it('counts both follow-up kinds into one shared bucket', async () => {
    const caps = { initial: 15, followup: 15 };
    await sendFollowup('followup_1', caps);
    await sendFollowup('followup_2', caps);

    expect(getSendCount('followup')).toBe(2);
    // The per-kind counters must stay empty — that split was the bug.
    expect(getSendCount('followup_1')).toBe(0);
    expect(getSendCount('followup_2')).toBe(0);
  });

  it('blocks a follow-up_2 once follow-up_1 has consumed the whole budget', async () => {
    const caps = { initial: 15, followup: 2 };
    await sendFollowup('followup_1', caps);
    await sendFollowup('followup_1', caps);

    // Budget is spent. Under the old split counters this would have sailed
    // through on a fresh followup_2 counter.
    await expect(sendFollowup('followup_2', caps))
      .rejects.toMatchObject({ name: 'SendBlockedError', reason: 'daily_cap_reached' });
  });

  it('keeps the initial bucket independent of follow-ups', async () => {
    const caps = { initial: 1, followup: 5 };
    await sendFollowup('followup_1', caps);
    await sendFollowup('followup_2', caps);
    expect(getSendCount('followup')).toBe(2);
    expect(getSendCount('initial')).toBe(0);
  });

  it('stores the real message kind, not the cap bucket', async () => {
    const { getDb } = await import('../src/pipeline/db/connection.js');
    const caps = { initial: 15, followup: 15 };
    await sendFollowup('followup_1', caps);
    await sendFollowup('followup_2', caps);
    const kinds = getDb().prepare(
      `SELECT kind FROM message WHERE direction='outbound' ORDER BY id`
    ).all().map(r => r.kind);
    expect(kinds).toEqual(['followup_1', 'followup_2']);
  });
});
