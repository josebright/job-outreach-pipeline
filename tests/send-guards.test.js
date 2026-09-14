// tests/send-guards.test.js
// Core invariant: no email can be sent that was not explicitly approved,
// is on the suppression list, or would breach the daily cap.
// Per PRD Module 6 acceptance criteria.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, upsertContact, createDraft, updateDraftStatus, suppress,
} from '../src/pipeline/db/repo.js';
import { sendApprovedDraft, SendBlockedError } from '../src/pipeline/send/index.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `guards-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

function seedApprovedDraft({ email = 'ok@example.com' } = {}) {
  const c = upsertCompany({ name: 'Acme', ats: 'greenhouse', slug: 'acme', source: 'seed' });
  const contact = upsertContact({
    companyId: c.id, fullName: 'A', title: 'CTO', roleType: 'founder',
    email, emailStatus: 'verified', source: 'hunter',
  });
  const draft = createDraft({
    contactId: contact.id, subject: 's', body: 'b',
    promptVersion: 'outreach_v1', hookVerified: true,
  });
  updateDraftStatus(draft.id, 'approved');
  return { draftId: draft.id, contactId: contact.id, email };
}

const fakeTransport = { send: async () => ({ messageId: 'stub@example.com', threadId: 't-1' }) };
const caps = { initial: 2, followup: 2 };

describe('send guards', () => {
  beforeEach(() => freshDb());

  it('refuses to send a draft that is not approved', async () => {
    const c = upsertCompany({ name: 'X', ats: 'lever', slug: 'x', source: 'seed' });
    const contact = upsertContact({
      companyId: c.id, fullName: 'A', title: 'CTO', roleType: 'founder',
      email: 'p@example.com', emailStatus: 'verified', source: 'hunter',
    });
    const d = createDraft({
      contactId: contact.id, subject: 's', body: 'b',
      promptVersion: 'outreach_v1', hookVerified: true,
    });
    const draft = { id: d.id, status: 'pending_review', subject: 's', body: 'b' };
    await expect(
      sendApprovedDraft({ draft, recipientEmail: 'p@example.com', kind: 'initial', caps, transport: fakeTransport })
    ).rejects.toThrow(SendBlockedError);
  });

  it('refuses to send to a suppressed address', async () => {
    const { draftId, email } = seedApprovedDraft({ email: 'blocked@example.com' });
    suppress(email, 'bounce');
    const draft = { id: draftId, status: 'approved', subject: 's', body: 'b' };
    await expect(
      sendApprovedDraft({ draft, recipientEmail: email, kind: 'initial', caps, transport: fakeTransport })
    ).rejects.toThrow(/suppressed/);
  });

  it('refuses to send once daily cap is hit', async () => {
    // Three different companies' domains. Three addresses at one domain is
    // three applications to the same company, which the duplicate-application
    // guard now stops before the cap is ever reached.
    const { draftId: d1, email: e1 } = seedApprovedDraft({ email: 'a@one.io' });
    const { draftId: d2, email: e2 } = seedApprovedDraft({ email: 'b@two.io' });
    const { draftId: d3, email: e3 } = seedApprovedDraft({ email: 'c@three.io' });
    const opts = { kind: 'initial', caps, transport: fakeTransport };
    await sendApprovedDraft({ draft: { id: d1, status: 'approved', subject: 's', body: 'b' }, recipientEmail: e1, ...opts });
    await sendApprovedDraft({ draft: { id: d2, status: 'approved', subject: 's', body: 'b' }, recipientEmail: e2, ...opts });
    await expect(
      sendApprovedDraft({ draft: { id: d3, status: 'approved', subject: 's', body: 'b' }, recipientEmail: e3, ...opts })
    ).rejects.toThrow(/daily_cap_reached/);
  });

  it('happy path: approved + clean recipient + under cap sends and increments counter', async () => {
    const { draftId, email } = seedApprovedDraft({ email: 'ok@example.com' });
    const result = await sendApprovedDraft({
      draft: { id: draftId, status: 'approved', subject: 'hi', body: 'body' },
      recipientEmail: email, kind: 'initial', caps, transport: fakeTransport,
    });
    expect(result.messageId).toBeDefined();
  });
});

/* ── ATS / job-board recipient guard ────────────────────────── */

describe('ATS-domain recipient guard', () => {
  beforeEach(() => freshDb());

  async function trySendTo(email, { override = false } = {}) {
    const c = upsertCompany({ name: 'Cint', ats: 'smartrecruiters', slug: 'cint', source: 'seed' });
    const contact = upsertContact({
      companyId: c.id, fullName: 'F', title: 'Founder', roleType: 'founder',
      email, emailStatus: 'risky', source: 'hunter',
    });
    const draft = createDraft({
      contactId: contact.id, subject: 's', body: 'b',
      promptVersion: 'outreach_v1', hookVerified: true,
    });
    updateDraftStatus(draft.id, 'approved');
    return sendApprovedDraft({
      draft: { id: draft.id, status: 'approved', subject: 's', body: 'b', deliverability_override: override },
      recipientEmail: email, kind: 'initial', caps, transport: fakeTransport,
    });
  }

  it('refuses to send to a pattern-probe address on an ATS host', async () => {
    // The live queue had two approved drafts aimed here (Cint + ServiceNow).
    await expect(trySendTo('founders@api.smartrecruiters.com'))
      .rejects.toMatchObject({ name: 'SendBlockedError', reason: 'recipient_ats_domain' });
  });

  it('is NOT bypassable by the /approve deliverability override', async () => {
    // /approve sets deliverability_override, which waives the verified-email
    // gate. It must not also waive this one — the address cannot receive mail
    // no matter how much the applicant consents.
    await expect(trySendTo('founders@api.smartrecruiters.com', { override: true }))
      .rejects.toMatchObject({ name: 'SendBlockedError', reason: 'recipient_ats_domain' });
  });

  it('still sends to a real employer domain', async () => {
    const r = await trySendTo('contact@clera.io');
    expect(r.messageId).toBeTruthy();
  });

  it('quarantines the contact and draft so it stops re-blocking every pass', async () => {
    // Without this, an unsendable draft sits in the approved queue and
    // re-blocks on every single send pass, forever.
    const { runSend } = await import('../src/pipeline/send/index.js');
    const { contactById, draftById } = await import('../src/pipeline/db/repo.js');

    const c = upsertCompany({ name: 'Cint', ats: 'smartrecruiters', slug: 'cint', source: 'seed' });
    const contact = upsertContact({
      companyId: c.id, fullName: 'F', title: 'Founder', roleType: 'founder',
      email: 'founders@api.smartrecruiters.com', emailStatus: 'risky', source: 'hunter',
    });
    const draft = createDraft({
      contactId: contact.id, subject: 's', body: 'b',
      promptVersion: 'outreach_v1', hookVerified: true,
    });
    updateDraftStatus(draft.id, 'approved');

    const config = {
      send: { sender_email: 'me@x.org', sender_name: 'Me', reply_to: null,
              daily_cap_initial: 15, daily_cap_followup: 15, research_daily_cap: 0 },
      enrichment: {},
    };
    const stats = await runSend({ config });

    expect(stats.blockedAtsDomain).toBe(1);
    expect(stats.atsDraftsQuarantined).toBe(1);
    expect(contactById(contact.id).email_status).toBe('invalid');
    expect(draftById(draft.id).status).toBe('rejected');
  });
});
