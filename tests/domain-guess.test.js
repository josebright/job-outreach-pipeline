// tests/domain-guess.test.js
import { describe, it, expect } from 'vitest';
import { candidatesFor, guessDomain } from '../src/pipeline/enrich/domain-guess.js';

// Build a fake dns resolver that returns canned answers per host.
// { hostA: { a: bool, mx: bool } }
function fakeResolver(map) {
  return {
    async resolve4(host) {
      if (map[host]?.a) return ['127.0.0.1'];
      const err = new Error('ENOTFOUND'); err.code = 'ENOTFOUND'; throw err;
    },
    async resolveMx(host) {
      if (map[host]?.mx) return [{ exchange: 'mx.example.com', priority: 10 }];
      // Real Node throws NODATA for an existing domain with no MX; simulate.
      const err = new Error('ENODATA'); err.code = 'ENODATA'; throw err;
    },
  };
}

describe('candidatesFor', () => {
  it('generates <slug>.<tld> for each supported TLD', () => {
    const hosts = candidatesFor({ slug: 'modal-labs' });
    expect(hosts).toContain('modal-labs.com');
    expect(hosts).toContain('modal-labs.io');
    expect(hosts).toContain('modal-labs.ai');
    expect(hosts).toContain('modal-labs.co');
  });

  it('also generates de-dashed variants', () => {
    const hosts = candidatesFor({ slug: 'modal-labs' });
    expect(hosts).toContain('modallabs.com');
  });

  it('also generates candidates from the first token of the display name', () => {
    const hosts = candidatesFor({ slug: 'modal-labs', name: 'Modal Labs' });
    expect(hosts).toContain('modal.com');
  });

  it('returns nothing for empty input', () => {
    expect(candidatesFor({})).toEqual([]);
    expect(candidatesFor({ slug: '' })).toEqual([]);
  });

  it('skips slugs that would produce garbage guesses', () => {
    expect(candidatesFor({ slug: 'careers' })).toEqual([]);
    expect(candidatesFor({ slug: 'jobs' })).toEqual([]);
  });

  it('preserves order: known-good TLDs (.com, .io, .ai) come before .xyz', () => {
    const hosts = candidatesFor({ slug: 'foo' });
    expect(hosts.indexOf('foo.com')).toBeLessThan(hosts.indexOf('foo.xyz'));
  });
});

describe('guessDomain (A + MX gate)', () => {
  it('returns the first candidate with both A and MX records', async () => {
    const resolver = fakeResolver({
      'modal.com':   { a: true,  mx: true  },
      'modal.io':    { a: true,  mx: true  },
    });
    const out = await guessDomain({ slug: 'modal-labs', name: 'Modal Labs' }, { resolver });
    // modal-labs.* comes first in candidatesFor; but none of those resolve
    // in this map, so it should walk down to modallabs then modal.
    expect(out).toBe('modal.com');
  });

  it('skips a parked domain (A record but no MX)', async () => {
    const resolver = fakeResolver({
      'parked.com':  { a: true,  mx: false },     // parked / squatted
      'parked.io':   { a: true,  mx: true  },     // real mail domain
    });
    const out = await guessDomain({ slug: 'parked' }, { resolver });
    expect(out).toBe('parked.io');
  });

  it('returns null when every candidate is a park or NXDOMAIN', async () => {
    const resolver = fakeResolver({
      'ghost.com':   { a: true,  mx: false },
      'ghost.io':    { a: false, mx: false },
    });
    const out = await guessDomain({ slug: 'ghost' }, { resolver });
    expect(out).toBeNull();
  });

  it('returns null for a slug that would produce garbage guesses', async () => {
    const resolver = fakeResolver({});
    const out = await guessDomain({ slug: 'careers' }, { resolver });
    expect(out).toBeNull();
  });
});
