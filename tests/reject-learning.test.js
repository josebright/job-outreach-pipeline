// tests/reject-learning.test.js
// End-to-end regression for the rejection that did not stick. The applicant
// rejected #124 (founders@nango.com) and #125 (founders@jobs.dropbox.com) with
// "has founders in the email"; the next /run produced #126 and #127 - the same
// contacts, the same roles, byte for byte.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { _resetForTests, getDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, setCompanyStatus, upsertJob, upsertContact, setJobQualifyResult,
  createDraft, draftById, contactById, jobById, updateDraftStatus, draftsByStatus,
  isCompanySuppressed, listRejectionRules, addressBlockRules,
} from '../src/pipeline/db/repo.js';
import { parseConfig } from '../src/pipeline/config/schema.js';

vi.mock('../src/pipeline/draft/llm.js', () => ({
  generateDraft: vi.fn(),
  loadSystemPrompt: vi.fn(() => 'stub'),
}));
vi.mock('../src/pipeline/draft/profile.js', async () => {
  const actual = await vi.importActual('../src/pipeline/draft/profile.js');
  return {
    ...actual,
    loadProfile: vi.fn(() => ({
      name: 'Uchenna', links: { website: 'https://x.dev', linkedin: 'https://l.in/x' },
      achievements: ['Cut latency 3x'],
    })),
  };
});

const { generateDraft } = await import('../src/pipeline/draft/llm.js');
const { runDraft } = await import('../src/pipeline/draft/index.js');
const { runQualify } = await import('../src/pipeline/qualify/index.js');
const { handleReject, handleRules, handleForget } = await import('../src/pipeline/bot/handlers.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const draftConfig = {
  llm: { drafts_model: 'claude-sonnet-4-6', prompt_version: 'outreach_v3' },
  scoring: { threshold: 20 },
  stack: {
    keywords: ['software engineer', 'backend', 'node'],
    seniority_accept: ['senior', 'staff'], seniority_reject: ['intern'], junior_override_min_annual: 0,
  },
};

function freshDb() {
  const p = path.join(os.tmpdir(), `rejlearn-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
  vi.clearAllMocks();
  generateDraft.mockResolvedValue({
    subject: 'Staff Software Engineer, Backend - Uchenna', body: 'Hi, applying. Ship payments infrastructure.',
    hookEvidence: 'Ship payments infrastructure', model: 'stub', promptVersion: 'outreach_v3', variant: 'V1_ROLE_FIT',
  });
}

// A company that runDraft will happily draft: qualified, trusted size, one
// qualified job, one contact, one open draft already created for that pair.
function seed({ slug, email, title = 'Staff Software Engineer, Backend' }) {
  const c = upsertCompany({ name: slug, ats: 'ashby', slug, source: 'seed', sizeBand: '11-50' });
  setCompanyStatus(c.id, 'qualified');
  const j = upsertJob({
    companyId: c.id, externalJobId: `${slug}-1`, title,
    descriptionText: 'Ship payments infrastructure. Node.js.', postedAt: new Date().toISOString(),
  });
  setJobQualifyResult(j.id, { status: 'qualified', score: 40 });
  const ct = upsertContact({
    companyId: c.id, fullName: null, title: null, roleType: 'founder',
    email, emailStatus: 'risky', source: 'pattern_probe',
  });
  const d = createDraft({ contactId: ct.id, jobId: j.id, subject: 's', body: 'b',
    promptVersion: 'outreach_v3', hookVerified: true });
  return { companyId: c.id, jobId: j.id, contactId: ct.id, draftId: d.id };
}

describe('/reject makes the decision stick', () => {
  beforeEach(() => freshDb());

  it('reproduces the live case: "has founders in the email" does not come back on the next run', async () => {
    const nango = seed({ slug: 'nango', email: 'founders@nango.com' });
    const dropbox = seed({ slug: 'dropbox', email: 'founders@jobs.dropbox.com' });

    const out = handleReject(nango.draftId, 'has founders in the email');

    expect(draftById(nango.draftId).status).toBe('rejected');
    expect(draftById(nango.draftId).redraft_blocked).toBe(1);
    // The rule reaches every founders@ contact, not just the rejected one...
    expect(contactById(nango.contactId).email_status).toBe('invalid');
    expect(contactById(dropbox.contactId).email_status).toBe('invalid');
    // ...and takes its open draft down with it (#125/#127 in the live queue).
    expect(draftById(dropbox.draftId).status).toBe('rejected');
    expect(out).toMatch(/Learned:/);
    expect(out).toMatch(/founders@/);
    expect(listRejectionRules().map(r => [r.kind, r.value])).toContainEqual(['local_part', 'founders']);

    const stats = await runDraft({ config: draftConfig });
    expect(stats.draftsCreated).toBe(0);
    expect(draftsByStatus('pending_review')).toHaveLength(0);
  });

  it('never re-drafts the exact contact + role, even when the reason is not understood', async () => {
    const named = seed({ slug: 'acme', email: 'jane.doe@acme.io' });
    const out = handleReject(named.draftId, 'meh');
    expect(out).toMatch(/could not tell what was wrong/);
    expect(contactById(named.contactId).email_status).toBe('risky');   // not over-applied

    const stats = await runDraft({ config: draftConfig });
    expect(stats.draftsCreated).toBe(0);
    expect(stats.skippedRejectedBefore).toBe(1);
  });

  it('still lets a housekeeping rejection be re-drafted', async () => {
    // /cleanup and /rejectall reject superseded drafts so they can be written
    // again with the current prompt. Those must not become permanent blocks.
    const s = seed({ slug: 'beta', email: 'jane@beta.io' });
    updateDraftStatus(s.draftId, 'rejected', { reason: 'cleanup: superseded prompt outreach_v2' });
    const stats = await runDraft({ config: draftConfig });
    expect(stats.draftsCreated).toBe(1);
  });

  it('suppresses the company and rejects its other open drafts on a company reason', () => {
    const a = seed({ slug: 'bigco', email: 'jane@bigco.com' });
    const ct2 = upsertContact({ companyId: a.companyId, fullName: 'Bo', title: 'CTO', roleType: 'founder',
      email: 'bo@bigco.com', emailStatus: 'verified', source: 'hunter' });
    const d2 = createDraft({ contactId: ct2.id, jobId: a.jobId, subject: 's', body: 'b',
      promptVersion: 'outreach_v3', hookVerified: true });

    const out = handleReject(a.draftId, 'too big, 3000 people');
    expect(isCompanySuppressed(a.companyId)).toBe(true);
    expect(draftById(d2.id).status).toBe('rejected');
    expect(out).toMatch(/Auto-suppressed/);
  });

  it('blocks the role on a role reason, and a config-change sweep does not resurrect it', async () => {
    const s = seed({ slug: 'gamma', email: 'jane@gamma.io' });
    handleReject(s.draftId, 'wrong role, that is a data engineer job');
    expect(jobById(s.jobId).status).toBe('disqualified');
    expect(jobById(s.jobId).disqualify_reason).toMatch(/^rejected:/);

    // No fingerprint stored yet, so this pass is a config-change sweep that
    // re-scores every disqualified job - except ones a person rejected.
    const config = parseConfig(yaml.load(fs.readFileSync(path.join(ROOT, 'config.example.yaml'), 'utf8')));
    const q = await runQualify({ config });
    expect(q.configChanged).toBe(true);
    expect(jobById(s.jobId).status).toBe('disqualified');
    expect(jobById(s.jobId).disqualify_reason).toMatch(/^rejected:/);
  });

  it('lists learned rules and lets /forget undo one', () => {
    const s = seed({ slug: 'nango', email: 'founders@nango.com' });
    handleReject(s.draftId, 'has founders in the email');
    expect(handleRules()).toMatch(/never use founders@ \/ founder@ addresses/);

    const rule = listRejectionRules().find(r => r.kind === 'local_part');
    expect(handleForget(rule.id)).toMatch(/Forgot rule/);
    expect(addressBlockRules().families.has('founders')).toBe(false);
  });

  it('refuses to reject a draft that was already sent', () => {
    const s = seed({ slug: 'delta', email: 'jane@delta.io' });
    getDb().prepare(`UPDATE draft SET status = 'sent' WHERE id = ?`).run(s.draftId);
    expect(handleReject(s.draftId, 'too big')).toMatch(/already sent/);
    expect(isCompanySuppressed(s.companyId)).toBe(false);
  });
});
