// tests/reply-detect-integration.test.js
// Verifies the from+subject fallback matches to a real DB row.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests, getDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, upsertContact, createDraft, updateDraftStatus,
} from '../src/pipeline/db/repo.js';
import { findByFromAndSubject } from '../src/pipeline/send/reply-detect.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `rd-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

function seedSentInitial({ subject = 'Senior Backend Engineer application — Uchenna Ugwumadu', email = 'jane@acme.io', daysAgo = 3 }) {
  const c = upsertCompany({ name: 'Acme', ats: 'greenhouse', slug: 'acme-' + Math.random().toString(36).slice(2), source: 'seed' });
  const contact = upsertContact({
    companyId: c.id, fullName: 'Jane Kim', title: 'VP Eng', roleType: 'eng_leader',
    email, emailStatus: 'verified', source: 'hunter',
  });
  const d = createDraft({
    contactId: contact.id, subject, body: 'body',
    promptVersion: 'outreach_v1', hookVerified: true,
  });
  updateDraftStatus(d.id, 'approved');
  updateDraftStatus(d.id, 'sent');
  const db = getDb();
  db.prepare(`
    INSERT INTO message (draft_id, direction, kind, sent_at, thread_id, message_id)
    VALUES (?, 'outbound', 'initial', datetime('now', ?), 't-1', 'msg-1@x')
  `).run(d.id, `-${daysAgo} days`);
  return { draftId: d.id, contactId: contact.id, email };
}

describe('findByFromAndSubject fallback', () => {
  beforeEach(() => freshDb());

  it('matches when subject has Re: prefix and From matches', () => {
    const { draftId } = seedSentInitial({ email: 'jane@acme.io' });
    const row = findByFromAndSubject('"Jane Kim" <jane@acme.io>', 'Re: Senior Backend Engineer application — Uchenna Ugwumadu');
    expect(row).toBeTruthy();
    expect(row.draft_id).toBe(draftId);
  });

  it('returns null when subject does not match', () => {
    seedSentInitial({ email: 'jane@acme.io' });
    const row = findByFromAndSubject('jane@acme.io', 'Re: unrelated topic');
    expect(row).toBeNull();
  });

  it('returns null when From does not match any known contact', () => {
    seedSentInitial({ email: 'jane@acme.io' });
    const row = findByFromAndSubject('stranger@nowhere.io', 'Re: Senior Backend Engineer application — Uchenna Ugwumadu');
    expect(row).toBeNull();
  });

  it('ignores outbound messages older than 30 days', () => {
    seedSentInitial({ email: 'jane@acme.io', daysAgo: 45 });
    const row = findByFromAndSubject('jane@acme.io', 'Re: Senior Backend Engineer application — Uchenna Ugwumadu');
    expect(row).toBeNull();
  });
});
