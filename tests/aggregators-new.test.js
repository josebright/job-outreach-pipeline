// tests/aggregators-new.test.js
// Coverage for the three new aggregators (HN, YC, WWR). Pure-parser
// tests use the exported helpers; fetch-loop tests mock the shared
// http client.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/pipeline/util/http.js', () => ({
  http: { get: vi.fn() },
  hostLimiter: () => (fn) => fn(),
}));

import { http } from '../src/pipeline/util/http.js';
import * as hn  from '../src/pipeline/discover/aggregators/hn.js';
import * as yc  from '../src/pipeline/discover/aggregators/yc.js';
import * as wwr from '../src/pipeline/discover/aggregators/wwr.js';

beforeEach(() => {
  // resetAllMocks: clears call history AND the queued mockResolvedValueOnce
  // implementations. clearAllMocks alone leaves the queue behind and later
  // tests consume earlier tests' mocks.
  vi.resetAllMocks();
});

/* ─── HN "Who is hiring" parser ────────────────────────────── */

describe('hn.parseHiringComment', () => {
  it('extracts company from a standard "Company | Role | Remote" comment', () => {
    const c = hn.parseHiringComment('<p>Vercel | Senior Frontend Engineer | REMOTE | Stack: React, Next.js');
    expect(c.companyName).toBe('Vercel');
    expect(c.title).toContain('Frontend Engineer');
    expect(c.location).toMatch(/REMOTE|Remote/i);
  });

  it('handles em dash and en dash separators', () => {
    expect(hn.parseHiringComment('<p>Linear — Senior Software Engineer — Remote').companyName).toBe('Linear');
    expect(hn.parseHiringComment('<p>PostHog – Backend Engineer – Remote').companyName).toBe('PostHog');
  });

  it('handles colon "Company: Role" format', () => {
    expect(hn.parseHiringComment('<p>Resend: Product Engineer, Remote').companyName).toBe('Resend');
  });

  it('strips leading empty <p> tags', () => {
    expect(hn.parseHiringComment('<p></p><p>Modal | ML Ops Engineer | REMOTE').companyName).toBe('Modal');
  });

  it('rejects meta comments that are not company posts', () => {
    expect(hn.parseHiringComment('<p>Please respect the format...')).toBeNull();
    expect(hn.parseHiringComment('<p>&gt; Company X | ...')).toBeNull();
  });

  it('rejects lines that are just a sentence (no separator, many words)', () => {
    expect(hn.parseHiringComment('<p>We are hiring engineers to work on our new product')).toBeNull();
  });

  it('rejects an empty comment', () => {
    expect(hn.parseHiringComment('')).toBeNull();
    expect(hn.parseHiringComment(null)).toBeNull();
  });
});

describe('hn.fetchCompanies', () => {
  it('finds the latest hiring story then walks its comment tree', async () => {
    // 1) search returns a fake latest hiring story
    http.get
      .mockResolvedValueOnce({ status: 200, data: {
        hits: [{ objectID: '999', title: 'Ask HN: Who is hiring? (August 2026)' }],
      }})
      // 2) item fetch returns two top-level comments
      .mockResolvedValueOnce({ status: 200, data: {
        children: [
          { text: '<p>Modal | Backend Engineer | REMOTE — <a href="https://jobs.ashbyhq.com/modal">apply</a>' },
          { text: '<p>Some Very Long Sentence That Should Get Dropped Because It Does Not Look Like A Company' },
          { text: '<p>Cursor - Senior Software Engineer - Remote' },
        ],
      }});

    const out = await hn.fetchCompanies();
    expect(out.map(o => o.companyName)).toEqual(['Modal', 'Cursor']);
    // ATS URL extraction wins for the Modal comment
    expect(out[0].hint).toEqual({ ats: 'ashby', slug: 'modal' });
  });
});

/* ─── YC public directory ──────────────────────────────────── */

describe('yc.teamSizeToBand', () => {
  it('converts integer counts to bands matching the rest of the pipeline', () => {
    expect(yc.teamSizeToBand(3)).toBe('1-10');
    expect(yc.teamSizeToBand(25)).toBe('11-50');
    expect(yc.teamSizeToBand(150)).toBe('51-200');
    expect(yc.teamSizeToBand(400)).toBe('201-500');
    expect(yc.teamSizeToBand(750)).toBe('501-1000');
    expect(yc.teamSizeToBand(5000)).toBe('1000+');
  });
  it('returns null for 0 / null / undefined', () => {
    expect(yc.teamSizeToBand(0)).toBeNull();
    expect(yc.teamSizeToBand(null)).toBeNull();
    expect(yc.teamSizeToBand(undefined)).toBeNull();
  });
});

describe('yc.fetchCompanies', () => {
  it('filters out companies > maxTeamSize (default 500)', async () => {
    http.get.mockResolvedValueOnce({ status: 200, data: {
      companies: [
        { name: 'SmallCo', teamSize: 8,  website: 'https://smallco.com', status: 'Active' },
        { name: 'MidCo',   teamSize: 120, website: 'https://midco.com',  status: 'Active' },
        { name: 'HugeCo',  teamSize: 2000, website: 'https://hugeco.com', status: 'Active' },
      ],
    }})
    .mockResolvedValueOnce({ status: 200, data: { companies: [] } });   // page 2

    const out = await yc.fetchCompanies();
    expect(out.map(o => o.companyName)).toEqual(['SmallCo', 'MidCo']);
    // sizeBand is passed through so discover can seed it with hunter-trust
    expect(out[0].sizeBand).toBe('1-10');
    expect(out[1].sizeBand).toBe('51-200');
  });

  it('includes companies with unknown teamSize (0) — gate 4 handles unknowns', async () => {
    http.get.mockResolvedValueOnce({ status: 200, data: {
      companies: [{ name: 'MysteryCo', teamSize: 0, website: 'https://mystery.co', status: 'Active' }],
    }})
    .mockResolvedValueOnce({ status: 200, data: { companies: [] } });
    const out = await yc.fetchCompanies();
    expect(out.length).toBe(1);
    expect(out[0].sizeBand).toBeNull();
  });

  it('skips inactive / non-Active companies when onlyActive is true (default)', async () => {
    http.get.mockResolvedValueOnce({ status: 200, data: {
      companies: [
        { name: 'DeadCo',  teamSize: 5, status: 'Dead' },
        { name: 'AliveCo', teamSize: 5, status: 'Active' },
      ],
    }})
    .mockResolvedValueOnce({ status: 200, data: { companies: [] } });
    const out = await yc.fetchCompanies();
    expect(out.map(o => o.companyName)).toEqual(['AliveCo']);
  });
});

/* ─── We Work Remotely ────────────────────────────────────── */

describe('wwr.parseCompanyFromTitle', () => {
  it('splits "Company: Role" on the first colon', () => {
    expect(wwr.parseCompanyFromTitle('Stripe: GTM Operations Process Architect')).toBe('Stripe');
    expect(wwr.parseCompanyFromTitle('Basecamp: Senior Ruby Developer')).toBe('Basecamp');
  });
  it('returns null when there is no colon', () => {
    expect(wwr.parseCompanyFromTitle('Senior Ruby Developer at Basecamp')).toBeNull();
  });
  it('rejects absurdly long names (probably a run-on title)', () => {
    expect(wwr.parseCompanyFromTitle('a: b')).toBeNull();
    expect(wwr.parseCompanyFromTitle('x'.repeat(80) + ': role')).toBeNull();
  });
});

describe('wwr.fetchCompanies', () => {
  it('parses an RSS feed with a couple of items', async () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Convex: Senior Full-Stack Engineer</title><link>https://weworkremotely.com/x</link></item>
      <item><title>Not a valid title</title><link>https://weworkremotely.com/y</link></item>
      <item><title>Neon: Backend Engineer</title><link>https://weworkremotely.com/z</link></item>
    </channel></rss>`;
    http.get.mockResolvedValueOnce({ status: 200, data: xml });

    const out = await wwr.fetchCompanies();
    expect(out.map(o => o.companyName)).toEqual(['Convex', 'Neon']);
  });

  it('returns empty on a non-200 response', async () => {
    http.get.mockResolvedValueOnce({ status: 502, data: '' });
    const out = await wwr.fetchCompanies();
    expect(out).toEqual([]);
  });
});
