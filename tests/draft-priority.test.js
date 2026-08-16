// tests/draft-priority.test.js
// Draft ordering: 2-100 companies come first, then 101-500, then unknown.
// Within each tier, higher score wins.
import { describe, it, expect } from 'vitest';
import { sizeTier } from '../src/pipeline/draft/index.js';

describe('sizeTier', () => {
  it('treats 2-10 as tier 1 (priority)', () => {
    expect(sizeTier('2-10')).toBe(1);
  });
  it('treats 11-50 as tier 1', () => {
    expect(sizeTier('11-50')).toBe(1);
  });
  it('treats 51-100 as tier 1', () => {
    expect(sizeTier('51-100')).toBe(1);
  });
  it('treats 51-200 as tier 3 (crosses 100)', () => {
    expect(sizeTier('51-200')).toBe(3);
  });
  it('treats 101-500 as tier 3 (mid)', () => {
    expect(sizeTier('101-500')).toBe(3);
  });
  it('treats 201-500 as tier 3', () => {
    expect(sizeTier('201-500')).toBe(3);
  });
  it('treats unknown/null as tier 2 (charitable)', () => {
    expect(sizeTier(null)).toBe(2);
    expect(sizeTier(undefined)).toBe(2);
    expect(sizeTier('')).toBe(2);
  });
  it('reads open-ended bands from the low end', () => {
    expect(sizeTier('50+')).toBe(1);
    expect(sizeTier('101+')).toBe(3);
  });
  it('recognises small-word bands', () => {
    expect(sizeTier('small')).toBe(1);
    expect(sizeTier('seed')).toBe(1);
  });
  it('orders correctly: tier 1 < tier 2 < tier 3', () => {
    // Sanity: sort a mixed list and verify tier 1 hits first.
    const rows = [
      { size_band: '201-500', score: 90 },
      { size_band: '11-50',   score: 30 },
      { size_band: null,      score: 50 },
    ];
    rows.sort((a, b) => {
      const ta = sizeTier(a.size_band), tb = sizeTier(b.size_band);
      if (ta !== tb) return ta - tb;
      return (b.score || 0) - (a.score || 0);
    });
    expect(rows.map(r => r.size_band)).toEqual(['11-50', null, '201-500']);
  });
});
