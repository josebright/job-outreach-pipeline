// tests/follow-up.test.js
// Follow-up scheduling + subject threading.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, upsertContact, createDraft, updateDraftStatus,
} from '../src/pipeline/db/repo.js';
import { getDb } from '../src/pipeline/db/connection.js';
import { draftsDueForFollowup, threadedSubject, followupBody } from '../src/pipeline/send/follow-up.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `fu-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

function seedSentDraft({ daysAgo, replied = false }) {
  const c = upsertCompany({ name: 'X', ats: 'lever', slug: `x${daysAgo}`, source: 'seed' });
  const contact = upsertContact({
    companyId: c.id, fullName: 'A', title: 'CTO', roleType: 'founder',
    email: `x${daysAgo}@example.com`, emailStatus: 'verified', source: 'hunter',
  });
  const d = createDraft({
    contactId: contact.id, subject: 'Hello', body: 'Body',
    promptVersion: 'outreach_v1', hookVerified: true,
  });
  updateDraftStatus(d.id, 'sent');
  const db = getDb();
  db.prepare(`
    INSERT INTO message (draft_id, direction, kind, sent_at, replied_at, thread_id, message_id)
    VALUES (?, 'outbound', 'initial', datetime('now', ?), ?, ?, ?)
  `).run(d.id, `-${daysAgo} days`, replied ? "datetime('now')" : null, `t${d.id}`, `m${d.id}@x`);
  return d.id;
}

describe('follow-up scheduling', () => {
  beforeEach(() => freshDb());

  it('draftsDueForFollowup(followup_1) picks drafts sent 4+ days ago with no reply', () => {
    const dueId = seedSentDraft({ daysAgo: 5 });
    seedSentDraft({ daysAgo: 2 });                        // too soon
    seedSentDraft({ daysAgo: 5, replied: true });         // replied
    const due = draftsDueForFollowup('followup_1');
    expect(due.map(d => d.id)).toEqual([dueId]);
  });

  it('draftsDueForFollowup(followup_2) requires 10+ days since initial', () => {
    seedSentDraft({ daysAgo: 5 });
    const dueId = seedSentDraft({ daysAgo: 11 });
    const due = draftsDueForFollowup('followup_2');
    expect(due.map(d => d.id)).toContain(dueId);
  });

  it('a draft that already has a followup_1 is not returned again for followup_1', () => {
    const id = seedSentDraft({ daysAgo: 6 });
    const db = getDb();
    db.prepare(`
      INSERT INTO message (draft_id, direction, kind, sent_at, thread_id)
      VALUES (?, 'outbound', 'followup_1', datetime('now'), 't')
    `).run(id);
    const due = draftsDueForFollowup('followup_1').map(d => d.id);
    expect(due).not.toContain(id);
  });
});

describe('threadedSubject', () => {
  it('prefixes with Re: when missing', () => {
    expect(threadedSubject('Payments infra at Acme')).toBe('Re: Payments infra at Acme');
  });
  it('does not double-prefix', () => {
    expect(threadedSubject('Re: Hello')).toBe('Re: Hello');
    expect(threadedSubject('RE:  Hello')).toBe('RE:  Hello');
  });
});

describe('followupBody', () => {
  it('followup_1 mentions contractor setup', () => {
    const s = followupBody({ profile: { name: 'X', links: {} }, kind: 'followup_1' });
    expect(s.toLowerCase()).toMatch(/deel|remote\.com/);
  });
  it('followup_2 is a short breakup email', () => {
    const s = followupBody({ profile: { name: 'X', links: {} }, kind: 'followup_2' });
    expect(s.toLowerCase()).toMatch(/closing the loop/);
    expect(s.split('\n').length).toBeLessThan(15);
  });
});
