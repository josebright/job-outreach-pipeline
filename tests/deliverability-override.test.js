// tests/deliverability-override.test.js
// The per-draft deliverability override. /approve sets it (informed
// consent), sendApprovedDraft honors it and logs an event so risky
// sends stay attributable.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests, getDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, upsertJob, upsertContact,
  createDraft, draftById, setDraftDeliverabilityOverride,
  setJobQualifyResult,
} from '../src/pipeline/db/repo.js';
import { handleApprove } from '../src/pipeline/bot/handlers.js';
import { sendApprovedDraft, SendBlockedError } from '../src/pipeline/send/index.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `override-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

function seedRiskyDraft() {
  const c = upsertCompany({ name: 'Chainguard', ats: 'external', slug: 'chainguard', source: 'manual' });
  const j = upsertJob({
    companyId: c.id, externalJobId: 'CG1', title: 'Principal Software Engineer',
    descriptionText: 'x', postedAt: new Date().toISOString(),
  });
  setJobQualifyResult(j.id, { status: 'qualified', score: 40 });
  const email = 'founders@chainguard.com';
  const contactResult = upsertContact({
    companyId: c.id, fullName: null, title: null, roleType: 'founder',
    email, emailStatus: 'risky', source: 'pattern_probe',
  });
  const d = createDraft({
    contactId: contactResult.id, jobId: j.id,
    subject: 's', body: 'b', promptVersion: 'v2', hookEvidence: null,
    hookVerified: true, model: 'stub', variant: 'V1_ROLE_FIT',
  });
  return { draftId: d.id, contactEmail: email, job: j };
}

describe('deliverability override', () => {
  beforeEach(() => freshDb());

  it('setDraftDeliverabilityOverride flips the bit', () => {
    const { draftId } = seedRiskyDraft();
    expect(draftById(draftId).deliverability_override).toBe(0);
    setDraftDeliverabilityOverride(draftId, true);
    expect(draftById(draftId).deliverability_override).toBe(1);
    setDraftDeliverabilityOverride(draftId, false);
    expect(draftById(draftId).deliverability_override).toBe(0);
  });

  it('handleApprove sets the override + warns applicant when recipient is risky', () => {
    const { draftId } = seedRiskyDraft();
    const out = handleApprove(draftId);
    expect(out).toMatch(/approved/);
    expect(out).toMatch(/overrides the deliverability gate/);
    expect(draftById(draftId).deliverability_override).toBe(1);
  });

  it('handleApprove does NOT show the override warning for verified recipients', () => {
    const c = upsertCompany({ name: 'PostHog', ats: 'ashby', slug: 'posthog', source: 'seed' });
    const j = upsertJob({
      companyId: c.id, externalJobId: 'PH1', title: 'Senior Backend Engineer',
      descriptionText: 'x', postedAt: new Date().toISOString(),
    });
    setJobQualifyResult(j.id, { status: 'qualified', score: 65 });
    const contact = upsertContact({
      companyId: c.id, fullName: 'Tim', title: 'CEO', roleType: 'founder',
      email: 'tim@posthog.com', emailStatus: 'verified', source: 'hunter',
    });
    const d = createDraft({
      contactId: contact.id, jobId: j.id,
      subject: 's', body: 'b', promptVersion: 'v2', hookEvidence: null,
      hookVerified: true, model: 'stub', variant: 'V1_ROLE_FIT',
    });
    const out = handleApprove(d.id);
    expect(out).not.toMatch(/overrides the deliverability gate/);
  });
});

describe('sendApprovedDraft honors the override', () => {
  beforeEach(() => freshDb());

  const stubTransport = { send: async () => ({ messageId: 'mid', threadId: 'tid', rfc5322MessageId: 'rid' }) };
  const caps = { initial: 15, followup: 15, initial_research: 2 };

  it('BLOCKS a risky recipient by default (no override)', async () => {
    const { draftId, contactEmail } = seedRiskyDraft();
    // approved but no override
    getDb().prepare("UPDATE draft SET status = 'approved' WHERE id = ?").run(draftId);
    const draft = draftById(draftId);

    await expect(sendApprovedDraft({
      draft, recipientEmail: contactEmail, kind: 'initial', caps, transport: stubTransport,
      fromEmail: 'x@y.com', fromName: 'X',
      recipientEmailStatus: 'risky', minEmailStatus: 'verified',
    })).rejects.toMatchObject({ name: 'SendBlockedError', reason: 'recipient_unverified' });
  });

  it('ALLOWS a risky recipient when the override is set', async () => {
    const { draftId, contactEmail } = seedRiskyDraft();
    getDb().prepare("UPDATE draft SET status = 'approved' WHERE id = ?").run(draftId);
    setDraftDeliverabilityOverride(draftId, true);
    const draft = draftById(draftId);

    const result = await sendApprovedDraft({
      draft, recipientEmail: contactEmail, kind: 'initial', caps, transport: stubTransport,
      fromEmail: 'x@y.com', fromName: 'X',
      recipientEmailStatus: 'risky', minEmailStatus: 'verified',
    });
    expect(result.messageId).toBe('mid');
  });

  it('override does NOT bypass suppression or daily cap (those are separate gates)', async () => {
    const { draftId, contactEmail } = seedRiskyDraft();
    getDb().prepare("UPDATE draft SET status = 'approved' WHERE id = ?").run(draftId);
    setDraftDeliverabilityOverride(draftId, true);
    const draft = draftById(draftId);

    // Simulate the daily cap already being hit
    const zeroCaps = { initial: 0, followup: 0, initial_research: 0 };
    await expect(sendApprovedDraft({
      draft, recipientEmail: contactEmail, kind: 'initial', caps: zeroCaps, transport: stubTransport,
      fromEmail: 'x@y.com', fromName: 'X',
      recipientEmailStatus: 'risky', minEmailStatus: 'verified',
    })).rejects.toMatchObject({ name: 'SendBlockedError', reason: 'daily_cap_reached' });
  });
});
