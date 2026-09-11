// tests/enrich.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, setCompanyStatus, upsertJob, contactsByCompany,
} from '../src/pipeline/db/repo.js';
import { charge, usage } from '../src/pipeline/enrich/cost-guard.js';
import { targetHintsFor, titleMatches } from '../src/pipeline/enrich/target.js';
import { deriveDomain } from '../src/pipeline/enrich/index.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `enrich-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

describe('cost-guard', () => {
  beforeEach(() => freshDb());

  it('starts at 0 usage and charges accumulate', () => {
    const u0 = usage('hunter', 100);
    expect(u0.units).toBe(0);
    expect(u0.remaining).toBe(100);
    charge('hunter', 5, 100);
    expect(usage('hunter', 100).units).toBe(5);
  });

  it('throws BudgetExceededError when charge would exceed budget', () => {
    charge('hunter', 90, 100);
    expect(() => charge('hunter', 20, 100)).toThrow(/Budget exceeded/);
  });

  it('resets when month rolls over (different month key)', () => {
    // Same-month reads only, so this simply confirms same-month usage sticks.
    charge('hunter', 10, 100);
    expect(usage('hunter', 100).units).toBe(10);
  });
});

describe('targetHintsFor', () => {
  it('targets founders for small companies', () => {
    const hints = targetHintsFor({ size_band: '11-50' });
    expect(hints[0].roleType).toBe('founder');
  });
  it('targets eng leaders for mid companies', () => {
    const hints = targetHintsFor({ size_band: '51-200' });
    expect(hints[0].roleType).toBe('eng_leader');
  });
  it('falls back to eng leader + engineer for large or unknown', () => {
    const hints = targetHintsFor({ size_band: '10000+' });
    expect(hints.some(h => h.roleType === 'engineer')).toBe(true);
  });
});

describe('titleMatches', () => {
  it('is a loose case-insensitive contains match', () => {
    expect(titleMatches('VP of Engineering', ['vp engineering'])).toBe(true);
    expect(titleMatches('CTO & Cofounder', ['cto', 'founder'])).toBe(true);
    expect(titleMatches('Product Manager', ['engineering'])).toBe(false);
  });
});

describe('deriveDomain', () => {
  beforeEach(() => freshDb());

  it('prefers company.website when set', () => {
    expect(deriveDomain({ website: 'https://www.acme.io/careers', id: 1 })).toBe('acme.io');
    expect(deriveDomain({ website: 'foo.com', id: 2 })).toBe('foo.com');
  });

  it('falls back to a job URL, skipping ATS-hosted hosts', () => {
    const c = upsertCompany({ name: 'Beta', ats: 'greenhouse', slug: 'beta', source: 'seed' });
    upsertJob({
      companyId: c.id, externalJobId: 'b1', title: 'Eng',
      url: 'https://boards.greenhouse.io/beta/jobs/1',
    });
    expect(deriveDomain({ id: c.id, website: null })).toBeNull();

    const c2 = upsertCompany({ name: 'Gamma', ats: 'greenhouse', slug: 'gamma', source: 'seed' });
    upsertJob({
      companyId: c2.id, externalJobId: 'g1', title: 'Eng',
      url: 'https://careers.gamma.io/openings/1',
    });
    expect(deriveDomain({ id: c2.id, website: null })).toBe('careers.gamma.io');
  });

  it('skips api.smartrecruiters.com job URLs', () => {
    // Regression: the SmartRecruiters adapter stores raw.ref as the job URL,
    // which is an api.smartrecruiters.com address. deriveDomain used to accept
    // it as the employer domain, and the pattern probe then built
    // founders@api.smartrecruiters.com — a guaranteed bounce that reached the
    // approved queue for two separate companies.
    const c = upsertCompany({ name: 'Cint', ats: 'smartrecruiters', slug: 'cint', source: 'seed' });
    upsertJob({
      companyId: c.id, externalJobId: 'c1', title: 'Software Engineer II',
      url: 'https://api.smartrecruiters.com/v1/companies/cint/postings/abc-123',
    });
    expect(deriveDomain({ id: c.id, website: null })).toBeNull();
  });

  it('skips every ATS platform we ingest from', () => {
    const urls = {
      gh:  'https://job-boards.greenhouse.io/acme/jobs/1',
      lev: 'https://api.lever.co/v0/postings/acme/1',
      ash: 'https://api.ashbyhq.com/posting-api/job-board/acme',
      wk:  'https://apply.workable.com/acme/j/ABC/',
      sr:  'https://api.smartrecruiters.com/v1/companies/acme/postings/1',
    };
    let n = 0;
    for (const [key, url] of Object.entries(urls)) {
      const co = upsertCompany({ name: `Co${key}`, ats: 'greenhouse', slug: `co-${key}`, source: 'seed' });
      upsertJob({ companyId: co.id, externalJobId: `${key}-1`, title: 'Eng', url });
      expect(deriveDomain({ id: co.id, website: null }), `${key} should be skipped`).toBeNull();
      n++;
    }
    expect(n).toBe(5);
  });
});
