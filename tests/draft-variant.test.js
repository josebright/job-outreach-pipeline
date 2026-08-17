// tests/draft-variant.test.js
// Coverage for the deterministic variant picker. Two properties matter:
//   1. Same input → same output every call (no A/B contamination within a company).
//   2. Distribution across many slugs matches the intended weighting.
import { describe, it, expect } from 'vitest';
import { pickDraftVariant, hashSlug } from '../src/pipeline/draft/variant.js';

describe('pickDraftVariant: determinism', () => {
  it('same slug + size always maps to the same variant', () => {
    const a = pickDraftVariant('modal', '11-50');
    const b = pickDraftVariant('modal', '11-50');
    const c = pickDraftVariant('modal', '11-50');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns one of the three known variants', () => {
    const valid = new Set(['V1_OBSERVATION', 'V2_QUESTION', 'V3_DIRECT']);
    for (const slug of ['a', 'b', 'c', 'd', 'e', 'foo', 'bar', 'baz']) {
      expect(valid.has(pickDraftVariant(slug, '51-200'))).toBe(true);
    }
  });

  it('handles missing slug + missing size gracefully', () => {
    expect(pickDraftVariant(null, null)).toMatch(/^V[123]_/);
    expect(pickDraftVariant('', undefined)).toMatch(/^V[123]_/);
  });
});

describe('pickDraftVariant: size-based weighting', () => {
  // Given ~200 random slugs, small companies should bias toward V2_QUESTION
  // (50% target), mid+ should be evenly split. These bounds are wide
  // because it's a real hash — we only want to catch grossly-broken routing.

  function distribution(band, slugs) {
    const counts = { V1_OBSERVATION: 0, V2_QUESTION: 0, V3_DIRECT: 0 };
    for (const s of slugs) counts[pickDraftVariant(s, band)]++;
    return counts;
  }
  function slugs(n) {
    return Array.from({ length: n }, (_, i) => `co-${i}-${(i * 7919) % 997}`);
  }

  it('small (<=50) bands bias toward V2_QUESTION (target ~50%)', () => {
    const c = distribution('11-50', slugs(200));
    const total = c.V1_OBSERVATION + c.V2_QUESTION + c.V3_DIRECT;
    // Expect V2 to be the dominant bucket — at least 40% and clearly ahead of the other two.
    expect(c.V2_QUESTION / total).toBeGreaterThan(0.4);
    expect(c.V2_QUESTION).toBeGreaterThan(c.V1_OBSERVATION);
    expect(c.V2_QUESTION).toBeGreaterThan(c.V3_DIRECT);
  });

  it('mid+ (201-500) bands rotate ~evenly across all three', () => {
    const c = distribution('201-500', slugs(300));
    const total = 300;
    // Each bucket ~1/3 (loose bound: 20-45%)
    for (const v of ['V1_OBSERVATION', 'V2_QUESTION', 'V3_DIRECT']) {
      const share = c[v] / total;
      expect(share).toBeGreaterThan(0.20);
      expect(share).toBeLessThan(0.45);
    }
  });

  it('unknown size falls back to even 3-way rotation', () => {
    const c = distribution(null, slugs(300));
    for (const v of ['V1_OBSERVATION', 'V2_QUESTION', 'V3_DIRECT']) {
      expect(c[v]).toBeGreaterThan(50);
    }
  });
});

describe('hashSlug', () => {
  it('is deterministic', () => {
    expect(hashSlug('modal')).toBe(hashSlug('modal'));
  });
  it('returns a non-negative integer', () => {
    for (const s of ['a', 'longer-slug-name', 'x', '']) {
      const h = hashSlug(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(h)).toBe(true);
    }
  });
  it('different slugs generally give different hashes', () => {
    // Not required by contract but caught if we accidentally reduce entropy.
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(hashSlug(`slug-${i}`));
    expect(seen.size).toBeGreaterThan(40);
  });
});
