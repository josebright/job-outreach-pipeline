// tests/domain-guess.test.js
import { describe, it, expect } from 'vitest';
import { candidatesFor } from '../src/pipeline/enrich/domain-guess.js';

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
