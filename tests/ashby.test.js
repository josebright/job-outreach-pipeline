// tests/ashby.test.js
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalize, fetchJobs, probe } from '../src/pipeline/ingest/ats/ashby.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ashby.json'), 'utf8'));

vi.mock('../src/pipeline/util/http.js', async () => {
  const actual = await vi.importActual('../src/pipeline/util/http.js');
  return { ...actual, http: { get: vi.fn() } };
});

import { http } from '../src/pipeline/util/http.js';

describe('ashby normalize', () => {
  it('maps a remote worldwide role with USD compensation', () => {
    const j = normalize(fixture.jobs[0]);
    expect(j.title).toBe('Senior Software Engineer');
    expect(j.workplaceType).toBe('remote');
    expect(j.remoteScope).toBe('worldwide');
    expect(j.currencySignal).toBe('USD');
    expect(j.compRaw).toContain('USD');
    expect(j.url).toContain('ashbyhq.com');
  });

  it('respects isRemote:false as onsite', () => {
    const j = normalize(fixture.jobs[1]);
    expect(j.workplaceType).toBe('onsite');
  });
});

describe('ashby fetchJobs + probe', () => {
  it('fetchJobs returns normalized jobs on 200', async () => {
    http.get.mockResolvedValueOnce({ status: 200, data: fixture });
    const jobs = await fetchJobs('example');
    expect(jobs.length).toBe(2);
  });

  it('probe returns alive with the board name', async () => {
    http.get.mockResolvedValueOnce({ status: 200, data: fixture });
    const res = await probe('example');
    expect(res.alive).toBe(true);
    expect(res.companyName).toBe('Example Co');
  });

  it('probe returns dead on 404', async () => {
    http.get.mockResolvedValueOnce({ status: 404, data: null });
    const res = await probe('bogus');
    expect(res.alive).toBe(false);
  });
});
