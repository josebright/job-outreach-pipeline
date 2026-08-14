// tests/lever.test.js
// Lever client: normalize from fixture, plus fetchJobs happy path with a stubbed http.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalize, fetchJobs } from '../src/pipeline/ingest/ats/lever.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/lever.json'), 'utf8'));

vi.mock('../src/pipeline/util/http.js', async () => {
  const actual = await vi.importActual('../src/pipeline/util/http.js');
  return {
    ...actual,
    http: { get: vi.fn() },
  };
});

import { http } from '../src/pipeline/util/http.js';

describe('lever normalize', () => {
  it('maps a remote EMEA posting with EUR salary range', () => {
    const j = normalize(fixture[0]);
    expect(j.externalJobId).toBe('abc-123-def');
    expect(j.title).toBe('Staff Platform Engineer');
    expect(j.workplaceType).toBe('remote');
    expect(j.remoteScope).toBe('emea');
    expect(j.currencySignal).toBe('EUR');
    expect(j.descriptionText).toMatch(/EU infrastructure/);
    expect(j.url).toContain('lever.co');
    expect(j.postedAt).toMatch(/^2025-\d{2}|^2026-\d{2}/); // epoch ms -> ISO
  });

  it('maps an onsite London role with GBP', () => {
    const j = normalize(fixture[1]);
    expect(j.workplaceType).toBe('onsite');
    expect(j.currencySignal).toBe('GBP');
    expect(j.locationRaw).toBe('London, UK');
  });

  it('returns null for malformed input', () => {
    expect(normalize({})).toBeNull();
    expect(normalize(null)).toBeNull();
  });
});

describe('lever fetchJobs', () => {
  it('returns normalized jobs on 200', async () => {
    http.get.mockResolvedValueOnce({ status: 200, data: fixture });
    const jobs = await fetchJobs('example');
    expect(jobs.length).toBe(2);
    expect(jobs[0].title).toBe('Staff Platform Engineer');
  });

  it('returns [] on non-200', async () => {
    http.get.mockResolvedValueOnce({ status: 404, data: null });
    expect(await fetchJobs('nope')).toEqual([]);
  });

  it('returns [] when payload is not an array', async () => {
    http.get.mockResolvedValueOnce({ status: 200, data: { error: 'x' } });
    expect(await fetchJobs('weird')).toEqual([]);
  });
});
