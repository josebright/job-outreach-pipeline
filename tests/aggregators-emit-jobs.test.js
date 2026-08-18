// tests/aggregators-emit-jobs.test.js
// Aggregators now emit full job data — not just company names. This
// unblocks the 97% of HN/WWR candidates that previously got thrown
// out for having no matching ATS slug.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/pipeline/util/http.js', () => ({
  http: { get: vi.fn() },
  hostLimiter: () => (fn) => fn(),
}));

import { http } from '../src/pipeline/util/http.js';
import * as hn from '../src/pipeline/discover/aggregators/hn.js';
import * as wwr from '../src/pipeline/discover/aggregators/wwr.js';

beforeEach(() => vi.resetAllMocks());

describe('hn.fetchCompanies now emits jobs', () => {
  it('returns candidates with a jobs array containing title + description + location', async () => {
    http.get
      .mockResolvedValueOnce({ status: 200, data: {
        hits: [{ objectID: '999', title: 'Ask HN: Who is hiring? (August 2026)' }],
      }})
      .mockResolvedValueOnce({ status: 200, data: {
        children: [{
          id: 101,
          text: '<p>Modal | Backend Engineer | REMOTE | Stack: Python, Go<p>We build serverless AI infra. Small team. <a href="https://jobs.ashbyhq.com/modal">apply</a>',
        }],
      }});

    const out = await hn.fetchCompanies();
    expect(out.length).toBe(1);
    const c = out[0];
    expect(c.companyName).toBe('Modal');
    expect(c.source).toBe('hn');
    expect(Array.isArray(c.jobs)).toBe(true);
    expect(c.jobs.length).toBe(1);
    expect(c.jobs[0].title).toContain('Backend Engineer');
    expect(c.jobs[0].location).toMatch(/REMOTE/i);
    expect(c.jobs[0].description).toContain('serverless AI infra');
    expect(c.jobs[0].url).toMatch(/ashbyhq/);
    expect(c.jobs[0].externalJobId).toMatch(/^hn:999:/);
  });

  it('extracts website from a link in the comment', async () => {
    http.get
      .mockResolvedValueOnce({ status: 200, data: {
        hits: [{ objectID: '888', title: 'Ask HN: Who is hiring?' }],
      }})
      .mockResolvedValueOnce({ status: 200, data: {
        children: [{
          id: 42, text: '<p>Convex | Full-Stack Engineer | Remote<p>Backend platform. <a href="https://convex.dev/careers">Details</a>',
        }],
      }});

    const out = await hn.fetchCompanies();
    expect(out[0].website).toBe('convex.dev');
  });
});

describe('wwr.fetchCompanies now emits jobs', () => {
  it('returns candidates with jobs from each RSS item', async () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item>
        <title>Neon: Senior Backend Engineer</title>
        <link>https://weworkremotely.com/jobs/1</link>
        <description>&lt;p&gt;We are hiring for our platform team...&lt;/p&gt;</description>
        <region>Anywhere in the World</region>
      </item>
      <item>
        <title>Convex: Full-Stack Engineer</title>
        <link>https://weworkremotely.com/jobs/2</link>
        <description>&lt;p&gt;Join our small team...&lt;/p&gt;</description>
        <region>Remote</region>
      </item>
    </channel></rss>`;
    http.get.mockResolvedValueOnce({ status: 200, data: xml });

    const out = await wwr.fetchCompanies();
    expect(out.map(c => c.companyName)).toEqual(['Neon', 'Convex']);
    expect(out[0].jobs.length).toBe(1);
    expect(out[0].jobs[0].title).toBe('Senior Backend Engineer');
    expect(out[0].jobs[0].location).toBe('Anywhere in the World');
    expect(out[0].jobs[0].description).toContain('platform team');
    expect(out[0].jobs[0].externalJobId).toMatch(/^wwr:/);
  });

  it('merges multiple listings for the same company', async () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Attio: Backend Engineer</title><link>https://weworkremotely.com/a</link><description>desc a</description><region>UK</region></item>
      <item><title>Attio: Frontend Engineer</title><link>https://weworkremotely.com/b</link><description>desc b</description><region>UK</region></item>
    </channel></rss>`;
    http.get.mockResolvedValueOnce({ status: 200, data: xml });

    const out = await wwr.fetchCompanies();
    expect(out.length).toBe(1);
    expect(out[0].companyName).toBe('Attio');
    expect(out[0].jobs.length).toBe(2);
    expect(out[0].jobs.map(j => j.title)).toEqual(['Backend Engineer', 'Frontend Engineer']);
  });
});
