// tests/recency.test.js
import { describe, it, expect } from 'vitest';
import { checkRecency } from '../src/pipeline/qualify/recency.js';

const NOW = new Date('2026-08-16T12:00:00Z');

describe('checkRecency', () => {
  it('fresh when age is under the window', () => {
    const r = checkRecency('2026-08-14T00:00:00Z', 30, NOW);
    expect(r.fresh).toBe(true);
    expect(r.ageDays).toBe(2);
  });

  it('fresh at the exact boundary', () => {
    const r = checkRecency('2026-07-17T12:00:00Z', 30, NOW);   // exactly 30 days
    expect(r.fresh).toBe(true);
    expect(r.ageDays).toBe(30);
  });

  it('stale one day past the window', () => {
    const r = checkRecency('2026-07-16T00:00:00Z', 30, NOW);   // 31+ days
    expect(r.fresh).toBe(false);
    expect(r.ageDays).toBeGreaterThan(30);
  });

  it('missing date is treated as fresh (some ATSes do not return one)', () => {
    const r = checkRecency(null, 30, NOW);
    expect(r.fresh).toBe(true);
    expect(r.ageDays).toBeNull();
  });

  it('unparseable date is treated as fresh', () => {
    const r = checkRecency('not-a-date', 30, NOW);
    expect(r.fresh).toBe(true);
    expect(r.ageDays).toBeNull();
  });
});
