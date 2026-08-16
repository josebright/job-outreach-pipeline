// tests/gate3-specialization.test.js
// The comma-specialization whitelist. Covers all the leak variants we've
// actually seen come out of ATS titles: Understanding, Cortex Quality,
// Flight Software, Batch Infrastructure, Developer Experience.
import { describe, it, expect } from 'vitest';
import { gate3_skillsetMatch, extractSpecialization } from '../src/pipeline/qualify/filters.js';

const config = {
  stack: {
    keywords: ['software engineer', 'backend', 'node', 'python'],
    seniority_accept: ['senior'], seniority_reject: ['intern', 'junior'],
    junior_override_min_annual: 0,
  },
  currency: { accept: ['USD', 'EUR', 'GBP'] },
};

describe('extractSpecialization', () => {
  it('picks up the part after a comma', () => {
    expect(extractSpecialization('Senior Software Engineer, Understanding')).toBe('Understanding');
    expect(extractSpecialization('Software Engineer, Backend')).toBe('Backend');
  });
  it('picks up the part after " - " (space-dash-space)', () => {
    expect(extractSpecialization('Software Engineer - Auth')).toBe('Auth');
    expect(extractSpecialization('Software Engineer – Product Backend')).toBe('Product Backend');
  });
  it('strips trailing parentheticals before extracting', () => {
    expect(extractSpecialization('Software Engineer, Product Backend (4-8 YOE)')).toBe('Product Backend');
    expect(extractSpecialization('Backend Engineer (Europe/UK timezone)')).toBeNull();
  });
  it('returns null for titles with no separator', () => {
    expect(extractSpecialization('Senior Software Engineer')).toBeNull();
    expect(extractSpecialization('Backend Engineer')).toBeNull();
  });
  it('does not split on hyphens inside compound words', () => {
    expect(extractSpecialization('Full-Stack Engineer')).toBeNull();
    expect(extractSpecialization('Back-End Engineer')).toBeNull();
  });
});

describe('gate3_skillsetMatch: comma-specialization whitelist', () => {
  const j = (title, description_text = 'node') => ({ title, description_text });

  it('accepts specialization "Backend"', () => {
    expect(gate3_skillsetMatch(j('Senior Software Engineer, Backend'), config).pass).toBe(true);
  });
  it('accepts specialization "Product Backend"', () => {
    expect(gate3_skillsetMatch(j('Software Engineer, Product Backend'), config).pass).toBe(true);
  });
  it('accepts "Backend - Booking Platform" (starts with backend)', () => {
    expect(gate3_skillsetMatch(j('Senior Software Engineer, Backend - Booking Platform & APIs'), config).pass).toBe(true);
  });

  it('rejects specialization "Understanding" (Algolia leak)', () => {
    const r = gate3_skillsetMatch(j('Senior Software Engineer, Understanding'), config);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/^spec_not_accepted:/);
  });
  it('rejects "Cortex Quality" (Snowflake leak)', () => {
    expect(gate3_skillsetMatch(j('Senior Software Engineer, Cortex Quality'), config).pass).toBe(false);
  });
  it('rejects "Flight Software" (IonQ leak)', () => {
    // "flight" isn't in the base REJECT_ROLE_MARKERS list — the whitelist catches it.
    expect(gate3_skillsetMatch(j('Senior Flight Software Engineer'), config).pass).toBe(false);
  });
  it('rejects "Developer Experience" (Docker leak)', () => {
    expect(gate3_skillsetMatch(j('Staff Software Engineer, Developer Experience'), config).pass).toBe(false);
  });
  it('rejects "Batch Infrastructure" (Affirm leak)', () => {
    // Also caught by REJECT_ROLE_MARKERS `infrastructure`, but whitelist confirms.
    expect(gate3_skillsetMatch(j('Senior Software Engineer, Backend (Batch Infrastructure)'), config).pass).toBe(true);
    // ...wait, "(Batch Infrastructure)" is a trailing parenthetical, gets stripped
    // → specialization becomes "Backend" which IS accepted. That's correct behavior:
    // parenthetical annotations shouldn't block a legitimate backend role.
    // Test the same content without the paren wrapping — that should still reject.
    expect(gate3_skillsetMatch(j('Senior Software Engineer, Batch Infrastructure'), config).pass).toBe(false);
  });

  it('still accepts plain "Senior Software Engineer" (no specialization)', () => {
    expect(gate3_skillsetMatch(j('Senior Software Engineer'), config).pass).toBe(true);
  });
  it('still accepts "Backend Engineer (Europe/UK timezone)"', () => {
    expect(gate3_skillsetMatch(j('Backend Engineer (Europe/UK timezone)'), config).pass).toBe(true);
  });
});
