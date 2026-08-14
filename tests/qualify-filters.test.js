// tests/qualify-filters.test.js
// Unit tests for the Q1-Q5 hard filters.
import { describe, it, expect } from 'vitest';
import {
  q1_roleMatches, q2_remoteEligible, q3_currencyOK,
  q4_visaRelocation, q5_notPreviouslyContacted,
} from '../src/pipeline/qualify/filters.js';

const config = {
  stack: {
    keywords: ['software engineer', 'backend', 'node', 'python', 'typescript', 'react'],
    seniority_accept: ['senior', 'staff', 'principal'],
    seniority_reject: ['intern', 'junior', 'jr', 'graduate', 'entry'],
  },
  location: {
    allow: ['remote worldwide', 'worldwide', 'anywhere', 'emea', 'africa', 'fully remote'],
    deny: ['us only', 'united states only', 'remote (us)', 'eu citizens only'],
  },
  currency: {
    accept: ['USD', 'EUR', 'GBP'],
    hq_country_currency_map: { US: 'USD', GB: 'GBP', DE: 'EUR' },
    contractor_signal_words: ['deel', 'remote.com', 'oyster', 'employer of record'],
  },
};

/* ── Q1 role matches ────────────────────────────────────────── */

describe('Q1: role matches profile', () => {
  it('passes senior backend engineer with Node', () => {
    const job = { title: 'Senior Backend Engineer', description_text: 'Node.js and TypeScript' };
    expect(q1_roleMatches(job, config).pass).toBe(true);
  });

  it('rejects junior in title even if keywords match', () => {
    const job = { title: 'Junior Software Engineer', description_text: 'Node.js required' };
    const r = q1_roleMatches(job, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('seniority_below_target');
  });

  it('rejects when no stack keyword appears', () => {
    const job = { title: 'Product Manager', description_text: 'roadmap and stakeholders' };
    const r = q1_roleMatches(job, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('no_stack_keyword_match');
  });

  it('does not confuse "seniority" with "senior" in reject list check', () => {
    const job = { title: 'Backend Engineer', description_text: 'senior-level roadmap for the team' };
    // reject list contains 'jr' etc, not 'senior'. Should pass.
    expect(q1_roleMatches(job, config).pass).toBe(true);
  });
});

/* ── Q2 location ────────────────────────────────────────────── */

describe('Q2: remote-eligible from Nigeria (Track A)', () => {
  it('passes remote worldwide', () => {
    const job = { location_raw: 'Remote (Worldwide)', description_text: '', remote_scope: 'worldwide' };
    expect(q2_remoteEligible(job, config, 'A').pass).toBe(true);
  });

  it('rejects US only', () => {
    const job = { location_raw: 'Remote (US)', description_text: 'US only', remote_scope: 'us_only' };
    const r = q2_remoteEligible(job, config, 'A');
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('us only');
  });

  it('marks ambiguous "Remote" without scope as needs_review', () => {
    const job = { location_raw: 'Remote', description_text: '', remote_scope: 'unknown' };
    const r = q2_remoteEligible(job, config, 'A');
    expect(r.pass).toBe(false);
    expect(r.needsReview).toBe(true);
    expect(r.reason).toBe('location_ambiguous');
  });

  it('Track B skips this filter', () => {
    const job = { location_raw: 'Berlin (Onsite)', description_text: '', remote_scope: 'onsite' };
    expect(q2_remoteEligible(job, config, 'B').pass).toBe(true);
  });

  it('trusts remote_scope=africa even without an allow keyword hit', () => {
    const job = { location_raw: 'Africa', description_text: '', remote_scope: 'africa' };
    expect(q2_remoteEligible(job, config, 'A').pass).toBe(true);
  });
});

/* ── Q3 currency ────────────────────────────────────────────── */

describe('Q3: pays USD/EUR/GBP (Track A)', () => {
  const company = { hq_country: 'US' };

  it('passes on explicit USD currency signal', () => {
    const job = { currency_signal: 'USD', description_text: '$150k', comp_raw: null };
    expect(q3_currencyOK(job, company, config, 'A').pass).toBe(true);
  });

  it('passes on HQ country mapping when no explicit signal', () => {
    const job = { currency_signal: null, description_text: 'competitive', comp_raw: null };
    expect(q3_currencyOK(job, company, config, 'A').pass).toBe(true);
  });

  it('passes on EOR mention when nothing else matches', () => {
    const job = { currency_signal: null, description_text: 'We hire via Deel worldwide.', comp_raw: null };
    expect(q3_currencyOK(job, { hq_country: 'NG' }, config, 'A').pass).toBe(true);
  });

  it('marks needs_review when no signal at all', () => {
    const job = { currency_signal: null, description_text: 'competitive', comp_raw: null };
    const r = q3_currencyOK(job, { hq_country: null }, config, 'A');
    expect(r.pass).toBe(false);
    expect(r.needsReview).toBe(true);
  });

  it('Track B skips this filter', () => {
    const job = { currency_signal: null, description_text: '', comp_raw: null };
    expect(q3_currencyOK(job, {}, config, 'B').pass).toBe(true);
  });
});

/* ── Q4 visa (Track B only) ─────────────────────────────────── */

describe('Q4: visa/relocation (Track B)', () => {
  it('Track A skips', () => {
    expect(q4_visaRelocation({ description_text: '' }, 'A').pass).toBe(true);
  });
  it('Track B passes when visa sponsorship is mentioned', () => {
    expect(q4_visaRelocation({ description_text: 'We offer visa sponsorship.' }, 'B').pass).toBe(true);
  });
  it('Track B rejects when nothing relevant is mentioned', () => {
    expect(q4_visaRelocation({ description_text: 'Great team.' }, 'B').pass).toBe(false);
  });
});

/* ── Q5 not previously contacted ────────────────────────────── */

describe('Q5: not previously contacted', () => {
  it('passes when alreadyContacted is false', () => {
    expect(q5_notPreviouslyContacted(false).pass).toBe(true);
  });
  it('rejects when alreadyContacted is true', () => {
    const r = q5_notPreviouslyContacted(true);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('contacted_within_90_days');
  });
});
