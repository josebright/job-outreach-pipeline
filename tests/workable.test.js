// tests/workable.test.js
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalize, fetchJobs, probe } from '../src/pipeline/ingest/ats/workable.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const widget = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/workable-widget.json'), 'utf8'));
const detail = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/workable-detail.json'), 'utf8'));

vi.mock('../src/pipeline/util/http.js', async () => {
  const actual = await vi.importActual('../src/pipeline/util/http.js');
  return { ...actual, http: { get: vi.fn() } };
});

import { http } from '../src/pipeline/util/http.js';

describe('workable normalize (widget only)', () => {
  it('summary-level fields map correctly for remote-worldwide role', () => {
    const j = normalize(widget.jobs[0]);
    expect(j.title).toBe('Senior Node.js Engineer');
    expect(j.workplaceType).toBe('remote');
    expect(j.remoteScope).toBe('worldwide');
    expect(j.url).toContain('workable.com');
    expect(j.externalJobId).toBe('99001');
  });

  it('detail merge picks up USD salary and appends description', () => {
    const j = normalize(widget.jobs[0], detail);
    expect(j.currencySignal).toBe('USD');
    expect(j.compRaw).toContain('USD');
    expect(j.descriptionText).toMatch(/payments service/);
  });

  it('non-remote onsite job is classified as onsite', () => {
    const j = normalize(widget.jobs[1]);
    expect(j.workplaceType).toBe('onsite');
  });
});

describe('workable fetchJobs + probe', () => {
  it('fetchJobs with withDetails=false only hits widget endpoint once', async () => {
    http.get.mockResolvedValueOnce({ status: 200, data: widget });
    const jobs = await fetchJobs('example', { withDetails: false });
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(jobs.length).toBe(2);
  });

  it('fetchJobs with details fetches per-job detail up to maxDetail', async () => {
    http.get
      .mockResolvedValueOnce({ status: 200, data: widget })    // widget
      .mockResolvedValueOnce({ status: 200, data: detail })    // detail for job 0
      .mockResolvedValueOnce({ status: 200, data: {} });       // detail for job 1
    const jobs = await fetchJobs('example', { withDetails: true, maxDetail: 5 });
    expect(jobs.length).toBe(2);
    expect(jobs[0].currencySignal).toBe('USD');
  });

  it('probe alive returns the account name', async () => {
    http.get.mockResolvedValueOnce({ status: 200, data: widget });
    const res = await probe('example');
    expect(res.alive).toBe(true);
    expect(res.companyName).toBe('Example Ltd');
  });
});
