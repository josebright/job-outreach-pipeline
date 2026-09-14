// tests/duplicate-application.test.js
// No application may go out twice. The guards that already existed all keyed
// on the company ROW, but one real company can arrive through two sources as
// two rows (the live queue once had the same address under both Cint and
// ServiceNow). And the database can believe a draft is unsent when Gmail
// actually delivered it - a timed-out response, or a redeploy between the Gmail
// call and the database write - so the next pass would send it again.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests, getDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, setCompanyStatus, upsertJob, upsertContact, setJobQualifyResult,
  createDraft, updateDraftStatus, draftById, getSendCount,
} from '../src/pipeline/db/repo.js';

vi.mock('../src/pipeline/draft/llm.js', () => ({
  generateDraft: vi.fn(),
  loadSystemPrompt: vi.fn(() => 'stub'),
}));
vi.mock('../src/pipeline/draft/profile.js', async () => {
  const actual = await vi.importActual('../src/pipeline/draft/profile.js');
  return {
    ...actual,
    loadProfile: vi.fn(() => ({
      name: 'U', links: { website: 'https://x.dev', linkedin: 'https://l.in/x' }, achievements: ['x'],
    })),
  };
});

const { generateDraft } = await import('../src/pipeline/draft/llm.js');
const { duplicateApplicationReason } = await import('../src/pipeline/send/duplicate-guard.js');
const { sendApprovedDraft } = await import('../src/pipeline/send/index.js');
const { runDraft } = await import('../src/pipeline/draft/index.js');

const caps = { initial: 15, followup: 15 };
const SUBJECT = 'Senior Backend Engineer - Uchenna Bright Ugwumadu';

function freshDb() {
  const p = path.join(os.tmpdir(), `dup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
  vi.clearAllMocks();
}

function company(slug, extra = {}) {
  return upsertCompany({ name: slug, ats: 'ashby', slug, source: 'seed', sizeBand: '11-50', ...extra });
}

function draftTo(co, email, status = 'pending_review') {
  const ct = upsertContact({ companyId: co.id, fullName: null, title: null, roleType: 'founder',
    email, emailStatus: 'verified', source: 'hunter' });
  const d = createDraft({ contactId: ct.id, subject: SUBJECT, body: 'b', promptVersion: 'outreach_v3', hookVerified: true });
  if (status !== 'pending_review') updateDraftStatus(d.id, status);
  return d.id;
}

describe('duplicateApplicationReason', () => {
  beforeEach(() => freshDb());

  it('flags the same address', () => {
    draftTo(company('acme'), 'jane@acme.io', 'sent');
    expect(duplicateApplicationReason({ email: 'JANE@acme.io' })).toMatchObject({ code: 'already_applied_address' });
  });

  it('flags another person at the same company reached through a second company row', () => {
    draftTo(company('acme'), 'jane@acme.io', 'sent');
    company('acme-yc', { name: 'Acme (YC W21)' });
    const r = duplicateApplicationReason({ email: 'bob@acme.io' });
    expect(r).toMatchObject({ code: 'already_applied_domain' });
    expect(r.message).toMatch(/jane@acme\.io at acme\.io/);
  });

  it('never groups people by a free-mail domain', () => {
    draftTo(company('solo'), 'founder.one@gmail.com', 'sent');
    expect(duplicateApplicationReason({ email: 'someone.else@gmail.com' })).toBeNull();
  });

  it('allows re-contact once the 90-day window has passed', () => {
    const id = draftTo(company('acme'), 'jane@acme.io', 'sent');
    getDb().prepare(`UPDATE draft SET sent_at = datetime('now', '-100 days') WHERE id = ?`).run(id);
    expect(duplicateApplicationReason({ email: 'jane@acme.io' })).toBeNull();
  });

  it('treats a draft already waiting for review as taken, but only when asked', () => {
    const id = draftTo(company('beta'), 'jane@beta.io');
    expect(duplicateApplicationReason({ email: 'bob@beta.io' })).toBeNull();
    expect(duplicateApplicationReason({ email: 'bob@beta.io', includeOpenDrafts: true }))
      .toMatchObject({ code: 'open_draft_same_recipient', draftId: id });
    expect(duplicateApplicationReason({ email: 'jane@beta.io', includeOpenDrafts: true, excludeDraftId: id })).toBeNull();
  });

  it('ignores rejected drafts', () => {
    draftTo(company('gamma'), 'jane@gamma.io', 'rejected');
    expect(duplicateApplicationReason({ email: 'jane@gamma.io', includeOpenDrafts: true })).toBeNull();
  });
});

describe('sendApprovedDraft never sends an application twice', () => {
  beforeEach(() => freshDb());

  const transport = (sent = []) => ({
    send: vi.fn(async () => ({ messageId: 'new@mail', threadId: 'thread-new' })),
    findSentTo: vi.fn(async () => sent),
  });

  it('blocks a second application to the same company via another row, before touching Gmail', async () => {
    draftTo(company('acme'), 'jane@acme.io', 'sent');
    const id = draftTo(company('acme-yc'), 'bob@acme.io', 'approved');
    const t = transport();
    await expect(sendApprovedDraft({ draft: draftById(id), recipientEmail: 'bob@acme.io', kind: 'initial', caps, transport: t }))
      .rejects.toMatchObject({ reason: 'duplicate_application', detail: { code: 'already_applied_domain' } });
    expect(t.findSentTo).not.toHaveBeenCalled();
    expect(t.send).not.toHaveBeenCalled();
  });

  it('records a draft Gmail already delivered as sent instead of sending it again', async () => {
    const id = draftTo(company('acme'), 'jane@acme.io', 'approved');
    const t = transport([{
      id: 'g1', threadId: 'thread-1', subject: SUBJECT,
      date: 'Mon, 14 Sep 2026 08:31:00 +0000', messageId: 'abc@mail.gmail.com',
    }]);
    const r = await sendApprovedDraft({ draft: draftById(id), recipientEmail: 'jane@acme.io', kind: 'initial', caps, transport: t });

    expect(r.reconciled).toBe(true);
    expect(t.send).not.toHaveBeenCalled();
    expect(draftById(id).status).toBe('sent');
    expect(getSendCount('initial')).toBe(0);         // not counted against today's cap
    const msg = getDb().prepare(`SELECT * FROM message WHERE draft_id = ?`).get(id);
    expect(msg).toMatchObject({ direction: 'outbound', kind: 'initial', thread_id: 'thread-1', message_id: 'abc@mail.gmail.com' });
  });

  it('blocks when the Sent folder holds a different email to that address', async () => {
    const id = draftTo(company('acme'), 'jane@acme.io', 'approved');
    const t = transport([{ id: 'g2', threadId: 't', subject: 'Quick question about your API', date: 'recently' }]);
    await expect(sendApprovedDraft({ draft: draftById(id), recipientEmail: 'jane@acme.io', kind: 'initial', caps, transport: t }))
      .rejects.toMatchObject({ reason: 'duplicate_application', detail: { code: 'already_in_sent_folder' } });
    expect(t.send).not.toHaveBeenCalled();
  });

  it('holds the send back when the Sent folder cannot be checked', async () => {
    const id = draftTo(company('acme'), 'jane@acme.io', 'approved');
    const t = { send: vi.fn(), findSentTo: vi.fn(async () => { throw new Error('gmail 503'); }) };
    await expect(sendApprovedDraft({ draft: draftById(id), recipientEmail: 'jane@acme.io', kind: 'initial', caps, transport: t }))
      .rejects.toMatchObject({ reason: 'sent_folder_check_failed' });
    expect(t.send).not.toHaveBeenCalled();
  });

  it('sends normally when there is no prior application anywhere', async () => {
    const id = draftTo(company('fresh'), 'jane@fresh.io', 'approved');
    const t = transport([]);
    const r = await sendApprovedDraft({ draft: draftById(id), recipientEmail: 'jane@fresh.io', kind: 'initial', caps, transport: t });
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(r.reconciled).toBeUndefined();
    expect(draftById(id).status).toBe('sent');
  });
});

describe('runDraft does not write a duplicate application', () => {
  beforeEach(() => freshDb());

  it('skips a second company row for a company already applied to, before calling the LLM', async () => {
    draftTo(company('acme'), 'jane@acme.io', 'sent');

    const dupRow = company('acme-yc', { name: 'Acme (YC W21)' });
    setCompanyStatus(dupRow.id, 'qualified');
    const j = upsertJob({ companyId: dupRow.id, externalJobId: 'b1', title: 'Senior Backend Engineer',
      descriptionText: 'Ship payments infrastructure. Node.js.', postedAt: new Date().toISOString() });
    setJobQualifyResult(j.id, { status: 'qualified', score: 40 });
    upsertContact({ companyId: dupRow.id, fullName: 'Bob', title: 'CTO', roleType: 'founder',
      email: 'bob@acme.io', emailStatus: 'verified', source: 'hunter' });

    const stats = await runDraft({ config: {
      llm: { drafts_model: 'stub', prompt_version: 'outreach_v3' },
      scoring: { threshold: 20 },
      stack: { keywords: ['backend', 'node'], seniority_accept: ['senior'], seniority_reject: [], junior_override_min_annual: 0 },
    } });

    expect(stats.skippedDuplicate).toBe(1);
    expect(stats.draftsCreated).toBe(0);
    expect(generateDraft).not.toHaveBeenCalled();
  });
});
