// tests/send-unverified-guard.test.js
// Deliverability invariant: when `min_email_status_for_auto_send` is set,
// the send path must refuse recipients whose email_status is below the bar.
// Protects sender reputation from cold-mailbox bounce spikes.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, upsertContact, createDraft, updateDraftStatus,
} from '../src/pipeline/db/repo.js';
import { sendApprovedDraft, SendBlockedError } from '../src/pipeline/send/index.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `unverified-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

function seed({ emailStatus, email = 'x@example.com' }) {
  const c = upsertCompany({ name: 'Acme', ats: 'greenhouse', slug: 'acme', source: 'seed' });
  const contact = upsertContact({
    companyId: c.id, fullName: 'A', title: 'CTO', roleType: 'founder',
    email, emailStatus, source: 'hunter',
  });
  const draft = createDraft({
    contactId: contact.id, subject: 's', body: 'b',
    promptVersion: 'outreach_v1', hookVerified: true,
  });
  updateDraftStatus(draft.id, 'approved');
  return { draftId: draft.id, contactEmail: email, emailStatus };
}

const fakeTransport = { send: async () => ({ messageId: 'stub@example.com', threadId: 't-1' }) };
const caps = { initial: 5, followup: 5 };

describe('send unverified-recipient guard', () => {
  beforeEach(() => freshDb());

  it('blocks risky recipient when minEmailStatus=verified', async () => {
    const { draftId, contactEmail, emailStatus } = seed({ emailStatus: 'risky' });
    await expect(sendApprovedDraft({
      draft: { id: draftId, status: 'approved', subject: 's', body: 'b' },
      recipientEmail: contactEmail, kind: 'initial', caps, transport: fakeTransport,
      recipientEmailStatus: emailStatus, minEmailStatus: 'verified',
    })).rejects.toMatchObject({ name: 'SendBlockedError', reason: 'recipient_unverified' });
  });

  it('allows verified recipient when minEmailStatus=verified', async () => {
    const { draftId, contactEmail, emailStatus } = seed({ emailStatus: 'verified' });
    const r = await sendApprovedDraft({
      draft: { id: draftId, status: 'approved', subject: 's', body: 'b' },
      recipientEmail: contactEmail, kind: 'initial', caps, transport: fakeTransport,
      recipientEmailStatus: emailStatus, minEmailStatus: 'verified',
    });
    expect(r.messageId).toBeDefined();
  });

  it('allows risky recipient when minEmailStatus=risky', async () => {
    const { draftId, contactEmail, emailStatus } = seed({ emailStatus: 'risky' });
    const r = await sendApprovedDraft({
      draft: { id: draftId, status: 'approved', subject: 's', body: 'b' },
      recipientEmail: contactEmail, kind: 'initial', caps, transport: fakeTransport,
      recipientEmailStatus: emailStatus, minEmailStatus: 'risky',
    });
    expect(r.messageId).toBeDefined();
  });

  it('blocks null status when minEmailStatus=verified (fail-closed)', async () => {
    const { draftId, contactEmail } = seed({ emailStatus: 'verified' });
    await expect(sendApprovedDraft({
      draft: { id: draftId, status: 'approved', subject: 's', body: 'b' },
      recipientEmail: contactEmail, kind: 'initial', caps, transport: fakeTransport,
      recipientEmailStatus: null, minEmailStatus: 'verified',
    })).rejects.toMatchObject({ name: 'SendBlockedError', reason: 'recipient_unverified' });
  });

  it('skips the check when minEmailStatus is not provided (backward compat)', async () => {
    const { draftId, contactEmail } = seed({ emailStatus: 'risky' });
    const r = await sendApprovedDraft({
      draft: { id: draftId, status: 'approved', subject: 's', body: 'b' },
      recipientEmail: contactEmail, kind: 'initial', caps, transport: fakeTransport,
    });
    expect(r.messageId).toBeDefined();
  });
});
