// tests/addcompany.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  parseLinkedInCompanySlug, parseAtsUrl, addCompanyFromInput,
} from '../src/pipeline/bot/addcompany.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `addcompany-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

describe('parseLinkedInCompanySlug', () => {
  it('extracts slug from canonical LinkedIn URL', () => {
    expect(parseLinkedInCompanySlug('https://www.linkedin.com/company/modal-labs/')).toBe('modal-labs');
  });
  it('handles URL without trailing slash', () => {
    expect(parseLinkedInCompanySlug('https://linkedin.com/company/vercel')).toBe('vercel');
  });
  it('handles URL with query string', () => {
    expect(parseLinkedInCompanySlug('https://www.linkedin.com/company/anthropic/about?foo=1')).toBe('anthropic');
  });
  it('returns null for a non-LinkedIn URL', () => {
    expect(parseLinkedInCompanySlug('https://example.com/company/foo')).toBe(null);
  });
  it('returns null for an empty input', () => {
    expect(parseLinkedInCompanySlug('')).toBe(null);
    expect(parseLinkedInCompanySlug(null)).toBe(null);
  });
});

describe('parseAtsUrl', () => {
  it('recognizes a Greenhouse URL', () => {
    expect(parseAtsUrl('https://boards.greenhouse.io/anthropic/jobs/1234'))
      .toEqual({ ats: 'greenhouse', slug: 'anthropic' });
  });
  it('recognizes a Lever URL', () => {
    expect(parseAtsUrl('https://jobs.lever.co/scale/some-job-id'))
      .toEqual({ ats: 'lever', slug: 'scale' });
  });
  it('recognizes an Ashby URL', () => {
    expect(parseAtsUrl('https://jobs.ashbyhq.com/modal-labs'))
      .toEqual({ ats: 'ashby', slug: 'modal-labs' });
  });
  it('recognizes a Workable URL', () => {
    expect(parseAtsUrl('https://apply.workable.com/some-company/'))
      .toEqual({ ats: 'workable', slug: 'some-company' });
  });
  it('recognizes a SmartRecruiters URL', () => {
    expect(parseAtsUrl('https://jobs.smartrecruiters.com/AcmeCorp/xyz'))
      .toEqual({ ats: 'smartrecruiters', slug: 'acmecorp' });
  });
  it('returns null for a plain LinkedIn URL', () => {
    expect(parseAtsUrl('https://linkedin.com/company/foo')).toBe(null);
  });
});

describe('addCompanyFromInput', () => {
  beforeEach(() => freshDb());

  it('adds a company from an ATS URL directly (no probe needed)', async () => {
    const r = await addCompanyFromInput('https://boards.greenhouse.io/testco', {
      probe: async () => { throw new Error('probe should not be called'); },
    });
    expect(r.status).toBe('added');
    expect(r.company).toEqual({ ats: 'greenhouse', slug: 'testco' });
  });

  it('re-adding returns exists, not added', async () => {
    await addCompanyFromInput('https://boards.greenhouse.io/testco', { probe: async () => null });
    const r = await addCompanyFromInput('https://boards.greenhouse.io/testco', { probe: async () => null });
    expect(r.status).toBe('exists');
  });

  it('probes ATS when only a LinkedIn URL is given', async () => {
    const r = await addCompanyFromInput('https://linkedin.com/company/modal-labs/', {
      probe: async (slug) => ({ ats: 'ashby', slug, jobCount: 3 }),
    });
    expect(r.status).toBe('added');
    expect(r.company).toEqual({ ats: 'ashby', slug: 'modal-labs', jobs: 3 });
  });

  it('reports not_found when LinkedIn slug does not probe to any ATS', async () => {
    const r = await addCompanyFromInput('https://linkedin.com/company/nowhere/', {
      probe: async () => null,
    });
    expect(r.status).toBe('not_found');
  });

  it('accepts `<name> <slug> <ats>` triple as a fallback', async () => {
    const r = await addCompanyFromInput('Modal Labs modal-labs ashby', { probe: async () => null });
    expect(r.status).toBe('added');
    expect(r.company).toEqual({ ats: 'ashby', slug: 'modal-labs' });
  });

  it('rejects unknown ATS in triple form', async () => {
    const r = await addCompanyFromInput('Foo Bar foo-bar unknown-ats', { probe: async () => null });
    expect(r.status).toBe('invalid');
  });

  it('rejects empty input', async () => {
    const r = await addCompanyFromInput('', { probe: async () => null });
    expect(r.status).toBe('invalid');
  });

  /* ── unsupported URLs (real cases the applicant hit) ────── */

  it('returns "unsupported" with LinkedIn-job-URL guidance for /jobs/view URLs', async () => {
    const r = await addCompanyFromInput(
      'https://www.linkedin.com/jobs/view/4447087551/',
      { probe: async () => null },
    );
    expect(r.status).toBe('unsupported');
    expect(r.message).toMatch(/linkedin.*job.*URL/i);
    expect(r.message).toMatch(/linkedin\.com\/company/);
  });

  it('returns "unsupported" with ATS explanation for a direct careers page', async () => {
    const r = await addCompanyFromInput(
      'https://herakonlab.com.ng/careers/full-stack-researcher',
      { probe: async () => null },
    );
    expect(r.status).toBe('unsupported');
    expect(r.message).toMatch(/careers page/i);
    expect(r.message).toMatch(/greenhouse|lever|ashby/i);
  });

  it('warns about non-Western TLDs (gate 2 would reject NGN pay)', async () => {
    const r = await addCompanyFromInput(
      'https://herakonlab.com.ng/careers/full-stack-researcher',
      { probe: async () => null },
    );
    expect(r.message).toMatch(/gate 2|USD\/EUR\/GBP/);
  });

  it('LinkedIn company URL not_found message points to careers-page ATS URL', async () => {
    const r = await addCompanyFromInput(
      'https://www.linkedin.com/company/topmediaconsulting',
      { probe: async () => null },
    );
    expect(r.status).toBe('not_found');
    expect(r.message).toMatch(/topmediaconsulting/);
    expect(r.message).toMatch(/greenhouse.*lever.*ashby/i);
  });
});
