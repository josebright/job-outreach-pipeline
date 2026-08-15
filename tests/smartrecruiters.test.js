// tests/smartrecruiters.test.js
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalize, fetchJobs, probe } from '../src/pipeline/ingest/ats/smartrecruiters.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/smartrecruiters.json'), 'utf8'));
const detail = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/smartrecruiters-detail.json'), 'utf8'));

vi.mock('../src/pipeline/util/http.js', async () => {
  const actual = await vi.importActual('../src/pipeline/util/http.js');
  return { ...actual, http: { get: vi.fn() } };
});

import { http } from '../src/pipeline/util/http.js';

describe('smartrecruiters normalize', () => {
  it('maps a remote posting with detail body', () => {
    const j = normalize(list.content[0], detail);
    expect(j.title).toBe('Senior Backend Engineer');
    expect(j.workplaceType).toBe('remote');
    expect(j.currencySignal).toBe('USD');
    expect(j.descriptionText).toMatch(/payments infrastructure/);
    expect(j.url).toContain('smartrecruiters.com');
    expect(j.externalJobId).toBe('744000123456789');
  });

  it('non-remote posting classified as onsite', () => {
    const j = normalize(list.content[1]);
    expect(j.workplaceType).toBe('onsite');
    expect(j.locationRaw).toBe('Berlin, de');
  });

  it('returns null for malformed input', () => {
    expect(normalize({})).toBeNull();
    expect(normalize(null)).toBeNull();
  });
});

describe('smartrecruiters fetchJobs + probe', () => {
  it('fetchJobs returns normalized jobs', async () => {
    http.get
      .mockResolvedValueOnce({ status: 200, data: list })        // list call
      .mockResolvedValueOnce({ status: 200, data: detail })      // detail call 1
      .mockResolvedValueOnce({ status: 200, data: {} });          // detail call 2 (empty)
    const jobs = await fetchJobs('example');
    expect(jobs.length).toBe(2);
    expect(jobs[0].currencySignal).toBe('USD');
  });

  it('probe returns alive with the company name', async () => {
    http.get.mockResolvedValueOnce({ status: 200, data: list });
    const res = await probe('example');
    expect(res.alive).toBe(true);
    expect(res.companyName).toBe('Example Corp');
  });

  it('probe returns dead on 404', async () => {
    http.get.mockResolvedValueOnce({ status: 404, data: null });
    const res = await probe('bogus');
    expect(res.alive).toBe(false);
  });
});
