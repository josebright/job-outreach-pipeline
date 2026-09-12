// tests/draft.test.js
// Draft orchestrator + profile loader + hook gate.
// LLM is mocked; we're testing wiring, not model output.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, setCompanyStatus, upsertJob, upsertContact,
  setJobQualifyResult, draftsByStatus,
} from '../src/pipeline/db/repo.js';
import { _resetProfileForTests } from '../src/pipeline/draft/profile.js';

const config = {
  llm: { drafts_model: 'claude-sonnet-4-6', prompt_version: 'outreach_v1' },
  scoring: { threshold: 40 },
  // Defensive Q1/Q6 rechecks in runDraft need these blocks.
  stack: {
    keywords: ['software engineer', 'backend', 'node', 'python'],
    seniority_accept: ['senior', 'staff', 'principal'],
    seniority_reject: ['intern', 'junior'],
    junior_override_min_annual: 0,
  },
};

// Stub the LLM so tests never touch the network.
vi.mock('../src/pipeline/draft/llm.js', () => ({
  generateDraft: vi.fn(),
  loadSystemPrompt: vi.fn(() => 'stub-prompt'),
}));

// Stub profile loader so tests do not depend on data/profile.yaml.
vi.mock('../src/pipeline/draft/profile.js', async () => {
  const actual = await vi.importActual('../src/pipeline/draft/profile.js');
  return {
    ...actual,
    loadProfile: vi.fn(() => ({
      name: 'Uchenna',
      links: { linkedin: 'https://linkedin.com/in/x', website: 'https://x.dev' },
      achievements: ['Reduced report generation from 4h to 6min'],
    })),
  };
});

import { generateDraft } from '../src/pipeline/draft/llm.js';
import { runDraft } from '../src/pipeline/draft/index.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `draft-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
  _resetProfileForTests();
  vi.clearAllMocks();
}

function seedQualifiedCompanyWithJobAndContact() {
  const c = upsertCompany({
    name: 'Acme', ats: 'greenhouse', slug: 'acme',
    source: 'seed', hqCountry: 'US', sizeBand: '51-200', nigeriaPresence: true,
  });
  setCompanyStatus(c.id, 'qualified');
  const j = upsertJob({
    companyId: c.id, externalJobId: 'A1', title: 'Senior Backend Engineer',
    descriptionText: 'Ship payments infrastructure. Node.js and Postgres.',
    postedAt: new Date().toISOString(),
  });
  setJobQualifyResult(j.id, { status: 'qualified', score: 65 });
  const contact = upsertContact({
    companyId: c.id, fullName: 'Jane Doe', title: 'VP Engineering',
    roleType: 'eng_leader', email: 'jane@acme.io', emailStatus: 'verified',
    source: 'hunter',
  });
  return { company: c, job: j, contact };
}

describe('runDraft', () => {
  beforeEach(() => freshDb());

  it('creates one draft when the LLM returns a verifiable hook', async () => {
    seedQualifiedCompanyWithJobAndContact();
    generateDraft.mockResolvedValueOnce({
      subject: 'Payments infrastructure at Acme',
      body: 'Hi Jane, saw your team is shipping payments infrastructure. I cut report generation from 4h to 6min.',
      hookEvidence: 'Ship payments infrastructure',
      model: 'claude-sonnet-4-6',
      promptVersion: 'outreach_v1',
      rawUsage: null,
    });
    const stats = await runDraft({ config });
    expect(stats.draftsCreated).toBe(1);
    expect(stats.hookFailed).toBe(0);
    const pending = draftsByStatus('pending_review');
    expect(pending.length).toBe(1);
    expect(pending[0].hook_verified).toBe(1);
  });

  it('marks hookVerified=false when the quote is hallucinated', async () => {
    seedQualifiedCompanyWithJobAndContact();
    generateDraft.mockResolvedValueOnce({
      subject: 'Hi',
      body: 'Generic body.',
      hookEvidence: 'AI copilots for enterprise customers (not in source)',
      model: 'claude-sonnet-4-6',
      promptVersion: 'outreach_v1',
      rawUsage: null,
    });
    const stats = await runDraft({ config });
    expect(stats.draftsCreated).toBe(1);
    expect(stats.hookFailed).toBe(1);
    const draft = draftsByStatus('pending_review')[0];
    expect(draft.hook_verified).toBe(0);
  });

  it('does not persist a draft when the LLM emits SKIP', async () => {
    seedQualifiedCompanyWithJobAndContact();
    generateDraft.mockResolvedValueOnce({
      subject: '',
      body: 'SKIP: no verifiable hook',
      hookEvidence: '',
      model: 'claude-sonnet-4-6',
      promptVersion: 'outreach_v1',
      rawUsage: null,
    });
    const stats = await runDraft({ config });
    expect(stats.draftsCreated).toBe(0);
    expect(draftsByStatus('pending_review').length).toBe(0);
    // Telemetry: SKIP must count in its own bucket, not conflate with hookFailed.
    // Prior bug: empty hookEvidence on SKIP bumped hookFailed, masking the real
    // failure mode when investigating "0 drafts produced" in production.
    expect(stats.skippedLlmSkip).toBe(1);
    expect(stats.hookFailed).toBe(0);
  });

  it('does not draft a company again while it already has an open draft', async () => {
    // Previously the only guard was per-(contact, job), so a second pass simply
    // moved on to the next contact at the same company. Three runs left several
    // companies with three drafts queued to three different people.
    seedQualifiedCompanyWithJobAndContact();
    generateDraft.mockResolvedValue({
      subject: 'Hi', body: 'Hi Jane, real hook here.',
      hookEvidence: 'Ship payments infrastructure',
      model: 'claude-sonnet-4-6', promptVersion: 'outreach_v1', rawUsage: null,
    });
    await runDraft({ config });
    const stats2 = await runDraft({ config });
    expect(stats2.skippedCompanyHasDraft).toBeGreaterThanOrEqual(1);
    expect(stats2.draftsCreated).toBe(0);
  });

  it('drafts the company again once the open draft is rejected', async () => {
    // Rejection must free the company - otherwise a bad draft permanently
    // removes that company from the pipeline.
    const { getDb } = await import('../src/pipeline/db/connection.js');
    seedQualifiedCompanyWithJobAndContact();
    generateDraft.mockResolvedValue({
      subject: 'Hi', body: 'Hi Jane, real hook here.',
      hookEvidence: 'Ship payments infrastructure',
      model: 'claude-sonnet-4-6', promptVersion: 'outreach_v1', rawUsage: null,
    });
    const first = await runDraft({ config });
    expect(first.draftsCreated).toBe(1);

    getDb().prepare(`UPDATE draft SET status = 'rejected'`).run();
    const second = await runDraft({ config });
    expect(second.draftsCreated).toBe(1);
  });

  it('does not bother calling the LLM when the company has no contacts', async () => {
    const c = upsertCompany({ name: 'Beta', ats: 'lever', slug: 'beta', source: 'seed' });
    setCompanyStatus(c.id, 'qualified');
    const j = upsertJob({
      companyId: c.id, externalJobId: 'B1', title: 'Backend',
      descriptionText: 'x', postedAt: new Date().toISOString(),
    });
    setJobQualifyResult(j.id, { status: 'qualified', score: 50 });

    const stats = await runDraft({ config });
    expect(generateDraft).not.toHaveBeenCalled();
    expect(stats.skippedNoContact).toBe(1);
    expect(stats.draftsCreated).toBe(0);
  });

  it('defensive Q1: skips a "qualified" job whose title no longer passes Q1', async () => {
    // Simulate the drift case: a job was qualified at some point, but the
    // ATS renamed it to something we now reject (ML Engineer). Draft must
    // not spend an Anthropic credit on it.
    const c = upsertCompany({
      name: 'Narvar', ats: 'greenhouse', slug: 'narvar',
      source: 'seed', hqCountry: 'US', sizeBand: '201-500',
    });
    setCompanyStatus(c.id, 'qualified');
    const j = upsertJob({
      companyId: c.id, externalJobId: 'N1', title: 'Senior ML Engineer II',
      descriptionText: 'Node.js and Python.', postedAt: new Date().toISOString(),
    });
    setJobQualifyResult(j.id, { status: 'qualified', score: 55 });
    upsertContact({
      companyId: c.id, fullName: 'Ram', title: 'CTO', roleType: 'founder',
      email: 'ram@narvar.com', emailStatus: 'verified', source: 'hunter',
    });

    const stats = await runDraft({ config });
    expect(generateDraft).not.toHaveBeenCalled();
    expect(stats.skippedBadTitle).toBe(1);
    expect(stats.draftsCreated).toBe(0);
  });

  it('defensive Q6: skips a company whose size is over the ceiling', async () => {
    // Company is marked qualified but its size band is beyond the 500
    // ceiling (this is how zombies leaked before). Draft must skip.
    const c = upsertCompany({
      name: 'Affirm', ats: 'greenhouse', slug: 'affirm',
      source: 'seed', hqCountry: 'US', sizeBand: '1000+',
    });
    setCompanyStatus(c.id, 'qualified');
    const j = upsertJob({
      companyId: c.id, externalJobId: 'AF1', title: 'Senior Backend Engineer',
      descriptionText: 'Node.js and Postgres.', postedAt: new Date().toISOString(),
    });
    setJobQualifyResult(j.id, { status: 'qualified', score: 65 });
    upsertContact({
      companyId: c.id, fullName: 'Michael', title: 'Founder', roleType: 'founder',
      email: 'm@affirm.com', emailStatus: 'verified', source: 'hunter',
    });

    const cfg = {
      ...config,
      scoring: { ...config.scoring, reject_size_bands: ['501-1000', '1000+'] },
    };
    const stats = await runDraft({ config: cfg });
    expect(generateDraft).not.toHaveBeenCalled();
    expect(stats.skippedTooBig).toBe(1);
    expect(stats.draftsCreated).toBe(0);
  });
});
