// tests/rejectall.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, upsertJob, upsertContact,
  createDraft, updateDraftStatus, draftsByStatus,
} from '../src/pipeline/db/repo.js';
import { handleRejectAll } from '../src/pipeline/bot/handlers.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `rejectall-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

function seedDraft({ email = 'a@x.com', status = 'pending_review' } = {}) {
  const c = upsertCompany({ name: 'X', ats: 'greenhouse', slug: `x-${Math.random().toString(36).slice(2, 6)}`, source: 'seed' });
  const contact = upsertContact({
    companyId: c.id, fullName: 'A', title: 'CEO', roleType: 'founder',
    email, emailStatus: 'verified', source: 'hunter',
  });
  const job = upsertJob({
    companyId: c.id, externalJobId: `j-${Math.random().toString(36).slice(2, 6)}`,
    title: 'Backend Engineer', locationRaw: 'Remote', remoteScope: 'worldwide',
  });
  const d = createDraft({
    contactId: contact.id, jobId: job.id,
    subject: 's', body: 'b', promptVersion: 'v1',
    hookEvidence: null, hookVerified: true, model: 'stub',
  });
  if (status !== 'pending_review') updateDraftStatus(d.id, status);
  return d;
}

describe('handleRejectAll', () => {
  beforeEach(() => freshDb());

  it('refuses without a reason', () => {
    seedDraft();
    const out = handleRejectAll('');
    expect(out).toMatch(/Reason is required/);
    expect(draftsByStatus('pending_review').length).toBe(1);
  });

  it('rejects both pending and approved drafts, leaves sent alone', () => {
    seedDraft({ email: 'a@x.com', status: 'pending_review' });
    seedDraft({ email: 'b@x.com', status: 'pending_review' });
    seedDraft({ email: 'c@x.com', status: 'approved' });
    seedDraft({ email: 'd@x.com', status: 'sent' });

    const out = handleRejectAll('wrong size tier');
    expect(out).toMatch(/Rejected 3 draft/);
    expect(draftsByStatus('pending_review').length).toBe(0);
    expect(draftsByStatus('approved').length).toBe(0);
    expect(draftsByStatus('sent').length).toBe(1);
    expect(draftsByStatus('rejected').length).toBe(3);
  });

  it('reports zero when there is nothing to reject', () => {
    const out = handleRejectAll('cleanup');
    expect(out).toMatch(/No pending or approved drafts/);
  });

  it('stores the reason with a bulk: prefix so it is grep-able later', () => {
    const d = seedDraft();
    handleRejectAll('mid-tier only, not priority');
    const rejected = draftsByStatus('rejected');
    expect(rejected.find(r => r.id === d.id)).toBeTruthy();
  });
});
