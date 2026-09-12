// tests/cleanup.test.js
// /cleanup purges drafts that were generated BEFORE the fixes that would have
// prevented them. Fixing deriveDomain stops NEW founders@& contacts; it does
// nothing about the six already sitting in the queue.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, upsertContact, upsertJob, createDraft, updateDraftStatus,
  draftsByStatus, draftById, contactById,
} from '../src/pipeline/db/repo.js';

vi.mock('../src/pipeline/config/loader.js', async () => {
  const actual = await vi.importActual('../src/pipeline/config/loader.js');
  return { ...actual, loadConfig: () => ({ llm: { prompt_version: 'outreach_v3' } }), env: {} };
});

const { handleCleanup } = await import('../src/pipeline/bot/handlers.js');

function freshDb() {
  const p = path.join(os.tmpdir(), `cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

let n = 0;
function seedDraft({ email, promptVersion = 'outreach_v3', company = null, status = 'pending_review' }) {
  n++;
  const slug = company || `co-${n}`;
  const c = upsertCompany({ name: slug, ats: 'lever', slug, source: 'seed' });
  const ct = upsertContact({
    companyId: c.id, fullName: 'A', title: 'Founder', roleType: 'founder',
    email, emailStatus: 'verified', source: 'hunter',
  });
  const j = upsertJob({ companyId: c.id, externalJobId: `j${n}`, title: 'Backend Engineer' });
  const d = createDraft({ contactId: ct.id, jobId: j.id, subject: 's', body: 'b',
    promptVersion, hookVerified: true });
  if (status !== 'pending_review') updateDraftStatus(d.id, status);
  return { draftId: d.id, contactId: ct.id, companyId: c.id };
}

describe('handleCleanup', () => {
  beforeEach(() => { freshDb(); n = 0; });

  it('says so when there is nothing to clean', () => {
    expect(handleCleanup()).toMatch(/no open drafts/i);
  });

  it('rejects the founders@& drafts and marks those contacts invalid', () => {
    const bad = seedDraft({ email: 'founders@&' });
    const out = handleCleanup();
    expect(draftById(bad.draftId).status).toBe('rejected');
    expect(contactById(bad.contactId).email_status).toBe('invalid');
    expect(out).toMatch(/Unsendable recipient/);
  });

  it('rejects ATS-domain drafts, approved ones included', () => {
    const ats = seedDraft({ email: 'founders@api.smartrecruiters.com', status: 'approved' });
    handleCleanup();
    expect(draftById(ats.draftId).status).toBe('rejected');
    expect(contactById(ats.contactId).email_status).toBe('invalid');
  });

  it('rejects drafts written by a superseded prompt version', () => {
    const old = seedDraft({ email: 'a@acme.io', promptVersion: 'outreach_v2' });
    const cur = seedDraft({ email: 'b@beta.io', promptVersion: 'outreach_v3' });
    const out = handleCleanup();
    expect(draftById(old.draftId).status).toBe('rejected');
    expect(draftById(cur.draftId).status).toBe('pending_review');
    expect(out).toMatch(/Superseded prompt/);
  });

  it('collapses duplicates to the newest draft per company', () => {
    // Bitwarden/Chronograph/Spade each had three, to three different people.
    const first  = seedDraft({ email: 'a@bitwarden.com', company: 'bitwarden' });
    const second = seedDraft({ email: 'b@bitwarden.com', company: 'bitwarden' });
    const third  = seedDraft({ email: 'c@bitwarden.com', company: 'bitwarden' });
    handleCleanup();
    expect(draftById(first.draftId).status).toBe('rejected');
    expect(draftById(second.draftId).status).toBe('rejected');
    expect(draftById(third.draftId).status).toBe('pending_review');
  });

  it('does not mark a contact invalid just for being a duplicate', () => {
    // The address is fine; only the extra draft is the problem.
    const first = seedDraft({ email: 'a@bitwarden.com', company: 'bitwarden' });
    seedDraft({ email: 'b@bitwarden.com', company: 'bitwarden' });
    handleCleanup();
    expect(contactById(first.contactId).email_status).toBe('verified');
  });

  it('never touches sent drafts', () => {
    const sent = seedDraft({ email: 'founders@&', status: 'sent' });
    handleCleanup();
    expect(draftById(sent.draftId).status).toBe('sent');
  });

  it('leaves a clean queue alone', () => {
    seedDraft({ email: 'a@acme.io' });
    seedDraft({ email: 'b@beta.io' });
    const out = handleCleanup();
    expect(out).toMatch(/Queue is clean/);
    expect(draftsByStatus('pending_review').length).toBe(2);
  });
});
