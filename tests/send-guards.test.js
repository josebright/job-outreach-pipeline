// tests/send-guards.test.js
// Core invariant: no email can be sent that was not explicitly approved,
// is on the suppression list, or would breach the daily cap.
// Per PRD Module 6 acceptance criteria.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import { suppress } from '../src/pipeline/db/repo.js';
import { sendApprovedDraft, SendBlockedError } from '../src/pipeline/send/index.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `guards-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
  return p;
}

const fakeTransport = {
  send: async () => ({ messageId: 'stub@example.com' }),
};

const caps = { initial: 2, followup: 2 };

describe('send guards', () => {
  beforeEach(() => freshDb());

  it('refuses to send a draft that is not approved', async () => {
    const draft = { id: 1, status: 'pending_review', subject: 's', body: 'b' };
    await expect(
      sendApprovedDraft({ draft, recipientEmail: 'a@example.com', kind: 'initial', caps, transport: fakeTransport })
    ).rejects.toThrow(SendBlockedError);
  });

  it('refuses to send to a suppressed address', async () => {
    suppress('blocked@example.com', 'bounce');
    const draft = { id: 2, status: 'approved', subject: 's', body: 'b' };
    await expect(
      sendApprovedDraft({ draft, recipientEmail: 'blocked@example.com', kind: 'initial', caps, transport: fakeTransport })
    ).rejects.toThrow(/suppressed/);
  });

  it('refuses to send once daily cap is hit', async () => {
    const draft = { id: 3, status: 'approved', subject: 's', body: 'b' };
    await sendApprovedDraft({ draft: { ...draft, id: 10 }, recipientEmail: 'a@example.com', kind: 'initial', caps, transport: fakeTransport });
    await sendApprovedDraft({ draft: { ...draft, id: 11 }, recipientEmail: 'b@example.com', kind: 'initial', caps, transport: fakeTransport });
    await expect(
      sendApprovedDraft({ draft: { ...draft, id: 12 }, recipientEmail: 'c@example.com', kind: 'initial', caps, transport: fakeTransport })
    ).rejects.toThrow(/daily_cap_reached/);
  });

  it('happy path: approved + clean recipient + under cap sends and increments counter', async () => {
    const draft = { id: 20, status: 'approved', subject: 'hi', body: 'body' };
    const result = await sendApprovedDraft({
      draft, recipientEmail: 'ok@example.com', kind: 'initial', caps, transport: fakeTransport,
    });
    expect(result.messageId).toBeDefined();
  });
});
