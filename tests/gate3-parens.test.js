// tests/gate3-parens.test.js
// Real leak: Coder's "Staff Software Engineer (AI Governance)" got
// drafted because our trailing-parens strip removed "(AI Governance)"
// before the reject-list check ran. Fix: check paren content
// separately against REJECT_ROLE_MARKERS.
import { describe, it, expect } from 'vitest';
import { gate3_skillsetMatch, extractParenContent } from '../src/pipeline/qualify/filters.js';

const config = {
  stack: {
    keywords: ['software engineer', 'backend', 'node', 'python'],
    seniority_accept: ['senior', 'staff'], seniority_reject: ['intern', 'junior'],
    junior_override_min_annual: 0,
  },
  currency: { accept: ['USD', 'EUR', 'GBP'] },
};

describe('extractParenContent', () => {
  it('returns content inside trailing parens', () => {
    expect(extractParenContent('Staff Software Engineer (AI Governance)')).toBe('AI Governance');
    expect(extractParenContent('Backend Engineer (Europe/UK timezone)')).toBe('Europe/UK timezone');
    expect(extractParenContent('Senior Software Engineer (4-8 YOE)')).toBe('4-8 YOE');
  });
  it('returns null when title has no trailing parens', () => {
    expect(extractParenContent('Senior Backend Engineer')).toBeNull();
    expect(extractParenContent('Software Engineer, Backend')).toBeNull();
  });
});

describe('gate3_skillsetMatch: paren content is screened against reject list', () => {
  const j = (title) => ({ title, description_text: 'node' });

  it('rejects "Staff Software Engineer (AI Governance)" — the real Coder leak', () => {
    // "ai governance" is in REJECT_ROLE_MARKERS so the outer title check
    // catches it (title contains the paren content in raw form). Either
    // rejection path is acceptable — both give the same end behavior.
    const r = gate3_skillsetMatch(j('Staff Software Engineer (AI Governance)'), config);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/^(title_role_out_of_scope|paren_role_out_of_scope)/);
  });

  it('rejects "Software Engineer (Machine Learning)"', () => {
    expect(gate3_skillsetMatch(j('Software Engineer (Machine Learning)'), config).pass).toBe(false);
  });

  it('rejects "Software Engineer (Security Engineer)"', () => {
    expect(gate3_skillsetMatch(j('Software Engineer (Security Engineer)'), config).pass).toBe(false);
  });

  it('PASSES "Backend Engineer (Europe/UK timezone)" — timezone metadata is fine', () => {
    expect(gate3_skillsetMatch(j('Backend Engineer (Europe/UK timezone)'), config).pass).toBe(true);
  });

  it('PASSES "Senior Software Engineer (4-8 YOE)" — years-of-experience metadata is fine', () => {
    expect(gate3_skillsetMatch(j('Senior Software Engineer (4-8 YOE)'), config).pass).toBe(true);
  });

  it('PASSES "Senior Software Engineer (Remote)"', () => {
    expect(gate3_skillsetMatch(j('Senior Software Engineer (Remote)'), config).pass).toBe(true);
  });
});
