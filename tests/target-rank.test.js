// tests/target-rank.test.js
// Covers the ranking-based Hunter targeting introduced when the strict
// title filter was dropped (was throwing away the majority of Hunter's
// small-startup results).
import { describe, it, expect } from 'vitest';
import {
  rankPerson, roleTypeForTitle, queriesFor, isSmallCo,
} from '../src/pipeline/enrich/target.js';

describe('rankPerson', () => {
  it('ranks founders highest at small companies', () => {
    const r = rankPerson({ position: 'Co-Founder & CEO' }, { isSmall: true });
    expect(r).toBe(100);
  });

  it('ranks founders lower at large companies (they never read cold email)', () => {
    const r = rankPerson({ position: 'CEO' }, { isSmall: false });
    expect(r).toBe(60);
  });

  it('ranks VP Engineering highly regardless of size', () => {
    expect(rankPerson({ position: 'VP of Engineering' }, { isSmall: false })).toBe(80);
    expect(rankPerson({ position: 'Head of Engineering' }, { isSmall: true })).toBe(80);
  });

  it('ranks Engineering Manager mid-tier', () => {
    expect(rankPerson({ position: 'Engineering Manager' })).toBe(60);
  });

  it('ranks recruiter titles lower than eng leadership', () => {
    expect(rankPerson({ position: 'Technical Recruiter' })).toBeLessThan(
      rankPerson({ position: 'VP Engineering' })
    );
  });

  it('ranks senior IC engineers modestly', () => {
    expect(rankPerson({ position: 'Staff Software Engineer' })).toBe(25);
  });

  it('gives everyone at least a floor score (never 0)', () => {
    expect(rankPerson({ position: 'Product Manager' })).toBeGreaterThan(0);
  });

  it('uses Hunter seniority as a tiebreaker for unknown titles', () => {
    // Bare title "Manager" → floor 10, but exec seniority nudges it up.
    const base = rankPerson({ position: 'Manager', seniority: null });
    const exec = rankPerson({ position: 'Manager', seniority: 'executive' });
    expect(exec).toBeGreaterThan(base);
  });
});

describe('roleTypeForTitle', () => {
  it('classifies founder titles', () => {
    expect(roleTypeForTitle('CEO & Founder')).toBe('founder');
    expect(roleTypeForTitle('CTO')).toBe('founder');
  });
  it('classifies engineering leaders', () => {
    expect(roleTypeForTitle('VP of Engineering')).toBe('eng_leader');
    expect(roleTypeForTitle('Engineering Manager')).toBe('eng_leader');
  });
  it('classifies recruiters', () => {
    expect(roleTypeForTitle('Technical Recruiter')).toBe('recruiter');
    expect(roleTypeForTitle('Head of Talent')).toBe('recruiter');
  });
  it('defaults ambiguous engineering titles to engineer', () => {
    expect(roleTypeForTitle('Senior Software Engineer')).toBe('engineer');
  });
});

describe('isSmallCo', () => {
  it('treats unknown size as small (seed-stage assumption)', () => {
    expect(isSmallCo({})).toBe(true);
    expect(isSmallCo({ size_band: null })).toBe(true);
  });
  it('recognises small size bands', () => {
    expect(isSmallCo({ size_band: '11-50' })).toBe(true);
    expect(isSmallCo({ size_band: '1-10' })).toBe(true);
    expect(isSmallCo({ size_band: '2-10' })).toBe(true);
  });
  it('recognises mid+ as not small', () => {
    expect(isSmallCo({ size_band: '51-200' })).toBe(false);
    expect(isSmallCo({ size_band: '201-500' })).toBe(false);
  });
});

describe('queriesFor', () => {
  it('for small companies, execs come first', () => {
    const qs = queriesFor({ size_band: '11-50' });
    expect(qs[0].seniority).toBe('executive');
  });

  it('for mid+ companies, engineering department comes first', () => {
    const qs = queriesFor({ size_band: '201-500' });
    expect(qs[0].department).toBe('engineering');
  });

  it('always ends with an unfiltered catch-all so we never leave a domain empty', () => {
    const qs = queriesFor({ size_band: '11-50' });
    const last = qs[qs.length - 1];
    expect(last.seniority).toBeNull();
    expect(last.department).toBeNull();
  });
});
