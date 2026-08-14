// tests/resolve-slug.test.js
// Verifies resolveSlug tries hints first, falls back to slug candidates,
// respects dead_slug, and marks dead slugs when probes fail.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import { isSlugDead, markSlugDead } from '../src/pipeline/db/repo.js';
import { resolveSlug } from '../src/pipeline/discover/resolve-slug.js';
import { slugCandidates } from '../src/pipeline/ingest/ats/classify.js';

// Stub every ATS client's probe with vi.fn we can control per-test.
vi.mock('../src/pipeline/ingest/ats/greenhouse.js', () => ({
  name: 'greenhouse', discoveryHost: 'boards.greenhouse.io',
  probe: vi.fn(), fetchJobs: vi.fn(),
}));
vi.mock('../src/pipeline/ingest/ats/lever.js', () => ({
  name: 'lever', discoveryHost: 'jobs.lever.co',
  probe: vi.fn(), fetchJobs: vi.fn(),
}));
vi.mock('../src/pipeline/ingest/ats/ashby.js', () => ({
  name: 'ashby', discoveryHost: 'jobs.ashbyhq.com',
  probe: vi.fn(), fetchJobs: vi.fn(),
}));
vi.mock('../src/pipeline/ingest/ats/workable.js', () => ({
  name: 'workable', discoveryHost: 'apply.workable.com',
  probe: vi.fn(), fetchJobs: vi.fn(),
}));

import * as greenhouse from '../src/pipeline/ingest/ats/greenhouse.js';
import * as lever from '../src/pipeline/ingest/ats/lever.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `resolve-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
  vi.clearAllMocks();
}

describe('slugCandidates', () => {
  it('produces sensible variants for a company name', () => {
    const c = slugCandidates('Acme Corp, Inc.');
    expect(c).toContain('acmecorp');
    expect(c).toContain('acme-corp');
    expect(c).toContain('acme');
  });

  it('strips punctuation and suffixes', () => {
    const c = slugCandidates('Beta & Sons Ltd');
    expect(c.some(s => s.includes('beta'))).toBe(true);
  });
});

describe('resolveSlug', () => {
  beforeEach(() => freshDb());

  it('trusts a hint when it probes alive', async () => {
    greenhouse.probe.mockResolvedValueOnce({ alive: true, companyName: 'Acme Real' });
    const r = await resolveSlug({
      companyName: 'Acme Corp',
      hint: { ats: 'greenhouse', slug: 'acme' },
      atsPlatforms: ['greenhouse', 'lever'],
    });
    expect(r).toEqual({ ats: 'greenhouse', slug: 'acme', companyName: 'Acme Real' });
    expect(greenhouse.probe).toHaveBeenCalledTimes(1);
  });

  it('falls back to candidates when hint is dead', async () => {
    greenhouse.probe.mockResolvedValueOnce({ alive: false });
    greenhouse.probe.mockResolvedValueOnce({ alive: false });
    greenhouse.probe.mockResolvedValueOnce({ alive: false });
    lever.probe.mockResolvedValueOnce({ alive: true, companyName: 'Acme Lever' });

    const r = await resolveSlug({
      companyName: 'Acme',
      hint: { ats: 'greenhouse', slug: 'acme' },
      atsPlatforms: ['greenhouse', 'lever'],
    });
    expect(r?.ats).toBe('lever');
    // hint slug should now be dead
    expect(isSlugDead('greenhouse', 'acme')).toBe(true);
  });

  it('returns null when nothing is alive and marks all tried slugs dead', async () => {
    greenhouse.probe.mockResolvedValue({ alive: false });
    lever.probe.mockResolvedValue({ alive: false });

    const r = await resolveSlug({
      companyName: 'Nothing Here',
      atsPlatforms: ['greenhouse', 'lever'],
    });
    expect(r).toBeNull();
    // at least one candidate should now be dead for one ATS
    expect(isSlugDead('greenhouse', 'nothinghere')).toBe(true);
  });

  it('skips already-dead slugs without probing', async () => {
    markSlugDead('greenhouse', 'acme', 30);
    greenhouse.probe.mockResolvedValue({ alive: false });
    lever.probe.mockResolvedValueOnce({ alive: true, companyName: 'Acme' });

    await resolveSlug({
      companyName: 'Acme',
      atsPlatforms: ['greenhouse', 'lever'],
    });
    // greenhouse.probe should not have been called for 'acme' (dead), only for other candidates
    for (const call of greenhouse.probe.mock.calls) {
      expect(call[0]).not.toBe('acme');
    }
  });
});
