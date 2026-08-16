// tests/suppression.test.js
// Company suppression: applicant-declared blocklist that beats every
// other gate. Covers the auto-suppress side-effect of /reject.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, setCompanyStatus, upsertJob, upsertContact,
  setJobQualifyResult, createDraft, draftsByStatus,
  isCompanySuppressed, listSuppressedCompanies, companyBySlug,
} from '../src/pipeline/db/repo.js';
import {
  handleSuppress, handleUnblock, handleSuppressed, handleReject,
} from '../src/pipeline/bot/handlers.js';
import { runQualify } from '../src/pipeline/qualify/index.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `supp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

describe('company suppression: repo + Telegram commands', () => {
  beforeEach(() => freshDb());

  it('handleSuppress blocks a company; handleUnblock reverses it', () => {
    const c = upsertCompany({ name: 'Affirm', ats: 'greenhouse', slug: 'affirm', source: 'dork' });
    expect(isCompanySuppressed(c.id)).toBe(false);

    const out = handleSuppress('affirm', 'always over 500 employees');
    expect(out).toMatch(/Suppressed <b>Affirm/);
    expect(isCompanySuppressed(c.id)).toBe(true);

    const listed = listSuppressedCompanies();
    expect(listed.length).toBe(1);
    expect(listed[0].name).toBe('Affirm');

    const undo = handleUnblock('affirm');
    expect(undo).toMatch(/Unblocked/);
    expect(isCompanySuppressed(c.id)).toBe(false);
  });

  it('handleSuppress refuses to double-suppress', () => {
    upsertCompany({ name: 'X', ats: 'greenhouse', slug: 'x', source: 'dork' });
    handleSuppress('x', 'first time');
    const out = handleSuppress('x', 'second time');
    expect(out).toMatch(/already suppressed/);
  });

  it('handleSuppressed returns "No suppressed companies." when empty', () => {
    expect(handleSuppressed()).toMatch(/No suppressed/);
  });
});

describe('handleReject auto-suppresses on size / role reasons', () => {
  beforeEach(() => freshDb());

  function seedDraft() {
    const c = upsertCompany({ name: 'BigCo', ats: 'greenhouse', slug: 'bigco', source: 'dork' });
    const contact = upsertContact({
      companyId: c.id, fullName: 'Ceo', title: 'CEO', roleType: 'founder',
      email: 'ceo@bigco.com', emailStatus: 'verified', source: 'hunter',
    });
    const job = upsertJob({
      companyId: c.id, externalJobId: 'B1',
      title: 'Senior Backend Engineer', descriptionText: 'x', postedAt: new Date().toISOString(),
    });
    setJobQualifyResult(job.id, { status: 'qualified', score: 60 });
    const d = createDraft({
      contactId: contact.id, jobId: job.id,
      subject: 's', body: 'b', promptVersion: 'v1', hookEvidence: null, hookVerified: true, model: 'stub',
    });
    return { company: c, draftId: d.id };
  }

  it('auto-suppresses when reason contains "too big"', () => {
    const { company, draftId } = seedDraft();
    const out = handleReject(draftId, 'too big for our tier — 2000 employees');
    expect(out).toMatch(/Auto-suppressed/);
    expect(isCompanySuppressed(company.id)).toBe(true);
  });

  it('auto-suppresses on "too large"', () => {
    const { company, draftId } = seedDraft();
    handleReject(draftId, 'too large');
    expect(isCompanySuppressed(company.id)).toBe(true);
  });

  it('auto-suppresses on "wrong industry"', () => {
    const { company, draftId } = seedDraft();
    handleReject(draftId, 'wrong industry');
    expect(isCompanySuppressed(company.id)).toBe(true);
  });

  it('does NOT auto-suppress on ordinary reject reasons', () => {
    const { company, draftId } = seedDraft();
    handleReject(draftId, 'body is off');
    expect(isCompanySuppressed(company.id)).toBe(false);
  });
});

describe('runQualify skips suppressed companies (gate 0)', () => {
  beforeEach(() => freshDb());

  it('a suppressed company never leaves qualify with status=qualified', async () => {
    const c = upsertCompany({
      name: 'Affirm', ats: 'greenhouse', slug: 'affirm', source: 'dork',
      sizeBand: '11-50',   // (deliberately "small" — suppression wins anyway)
    });
    handleSuppress('affirm', 'always big');
    upsertJob({
      companyId: c.id, externalJobId: 'AF1',
      title: 'Senior Backend Engineer',
      locationRaw: 'Remote Worldwide', remoteScope: 'worldwide',
      compRaw: '$150,000 USD',
      descriptionText: 'Node.js. Salary $150k.',
      postedAt: new Date().toISOString(),
    });

    const config = {
      gates: { pay_minimum_annual: 24000, max_posting_age_days: 30 },
      stack: { keywords: ['software engineer', 'node'], seniority_accept: ['senior'], seniority_reject: [], junior_override_min_annual: 0 },
      location: { allow: ['worldwide'], deny: [] },
      currency: { accept: ['USD', 'EUR', 'GBP'] },
      scoring: { threshold: 40, reject_size_bands: ['501-1000', '1000+'] },
    };
    const stats = await runQualify({ config });
    expect(stats.qualified).toBe(0);
    expect(stats.disqualified).toBe(1);
  });
});
