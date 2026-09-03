// tests/hunter-discover.test.js
// Unit tests for the Hunter /v2/discover aggregator.
// HTTP is mocked — no real API calls.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/pipeline/util/http.js', () => ({
  http: { get: vi.fn(), post: vi.fn() },
  hostLimiter: () => (fn) => fn(),
}));

vi.mock('../src/pipeline/config/loader.js', () => ({
  env: { HUNTER_API_KEY: 'test-key' },
}));

import { http } from '../src/pipeline/util/http.js';
import { fetchCompanies, normalizeBand } from '../src/pipeline/discover/aggregators/hunter-discover.js';

beforeEach(() => { vi.resetAllMocks(); });

describe('normalizeBand', () => {
  it('passes through canonical band strings', () => {
    expect(normalizeBand('11-50')).toBe('11-50');
    expect(normalizeBand('51-200')).toBe('51-200');
    expect(normalizeBand('201-500')).toBe('201-500');
  });
  it('normalizes underscore separator Hunter sometimes uses', () => {
    expect(normalizeBand('11_50')).toBe('11-50');
    expect(normalizeBand('51_200')).toBe('51-200');
  });
  it('maps numeric headcount to correct band', () => {
    expect(normalizeBand(25)).toBe('11-50');
    expect(normalizeBand(100)).toBe('51-200');
    expect(normalizeBand(300)).toBe('201-500');
  });
  it('returns null for null / 0 / out-of-range', () => {
    expect(normalizeBand(null)).toBeNull();
    expect(normalizeBand(0)).toBeNull();
    expect(normalizeBand(1000)).toBeNull();
  });
});

describe('fetchCompanies', () => {
  it('returns candidates from a successful response', async () => {
    http.post.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          companies: [
            { domain: 'linear.app', name: 'Linear', headcount: '11-50', country: 'US' },
            { domain: 'posthog.com', name: 'PostHog', headcount: '51-200', country: 'US' },
          ],
        },
      },
    });

    const out = await fetchCompanies({ pages: 1 });
    expect(out).toHaveLength(2);
    expect(out[0].companyName).toBe('Linear');
    expect(out[0].website).toBe('linear.app');
    expect(out[0].sizeBand).toBe('11-50');
    expect(out[0].source).toBe('hunter_discover');
    expect(out[0].hint).toBeNull();
  });

  it('deduplicates companies by domain', async () => {
    http.post.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          companies: [
            { domain: 'acme.com', name: 'Acme', headcount: '11-50' },
            { domain: 'acme.com', name: 'Acme Corp', headcount: '11-50' },
          ],
        },
      },
    });

    const out = await fetchCompanies({ pages: 1 });
    expect(out).toHaveLength(1);
  });

  it('stops pagination when response has fewer than 100 companies', async () => {
    // page 1: 2 results (< 100) → should not fetch page 2
    http.post.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          companies: [
            { domain: 'small.io', name: 'Small', headcount: '11-50' },
            { domain: 'mid.io',   name: 'Mid',   headcount: '51-200' },
          ],
        },
      },
    });

    await fetchCompanies({ pages: 3 });
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('returns empty and does not throw on 403 (tier restriction)', async () => {
    http.post.mockResolvedValueOnce({ status: 403, data: { errors: [{ details: 'Upgrade required' }] } });

    const out = await fetchCompanies({ pages: 1 });
    expect(out).toEqual([]);
  });

  it('returns empty and does not throw on network error', async () => {
    http.post.mockRejectedValueOnce(new Error('ECONNRESET'));

    const out = await fetchCompanies({ pages: 1 });
    expect(out).toEqual([]);
  });

  it('skips entries with no name or domain', async () => {
    http.post.mockResolvedValueOnce({
      status: 200,
      data: {
        data: {
          companies: [
            { domain: null, name: null, headcount: '11-50' },
            { domain: 'valid.com', name: 'Valid Co', headcount: '11-50' },
          ],
        },
      },
    });

    const out = await fetchCompanies({ pages: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].companyName).toBe('Valid Co');
  });

  it('returns empty array when HUNTER_API_KEY is not set', async () => {
    const { env } = await import('../src/pipeline/config/loader.js');
    const origKey = env.HUNTER_API_KEY;
    env.HUNTER_API_KEY = '';

    const out = await fetchCompanies({ pages: 1 });
    expect(out).toEqual([]);
    expect(http.post).not.toHaveBeenCalled();

    env.HUNTER_API_KEY = origKey;
  });
});
