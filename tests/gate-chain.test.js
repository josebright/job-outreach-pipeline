// tests/gate-chain.test.js
// Unit tests for each gate in the priority-ordered chain.
import { describe, it, expect } from 'vitest';
import {
  gate1_remoteFromNigeria, gate2_payMinimum, gate3_skillsetMatch,
  gate4_companySize, gate5_notPreviouslyContacted, gate6_recentPosting,
} from '../src/pipeline/qualify/filters.js';

const config = {
  gates: { pay_minimum_annual: 24000, max_posting_age_days: 30 },
  stack: {
    keywords: ['software engineer', 'backend', 'node', 'python', 'typescript'],
    seniority_accept: ['senior', 'staff', 'principal'],
    seniority_reject: ['intern', 'junior', 'jr', 'new grad'],
    junior_override_min_annual: 36000,
  },
  location: {
    allow: ['worldwide', 'remote worldwide', 'anywhere', 'emea', 'africa', 'fully remote', 'global'],
    deny: ['us only', 'united states only', 'eu citizens only', 'remote (us)'],
  },
  currency: { accept: ['USD', 'EUR', 'GBP'] },
  scoring: { reject_size_bands: ['501-1000', '1000+', '5001-10000', '10001+', '10000+'] },
};

function isoDaysAgo(d) {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
}

/* ── Gate 1: remote-from-Nigeria ──────────────────────────── */

describe('gate1_remoteFromNigeria', () => {
  it('passes remote worldwide', () => {
    const j = { location_raw: 'Remote (Worldwide)', description_text: '', remote_scope: 'worldwide' };
    expect(gate1_remoteFromNigeria(j, config).pass).toBe(true);
  });

  it('rejects US only', () => {
    const j = { location_raw: 'Remote (US)', description_text: 'US only', remote_scope: 'us_only' };
    const r = gate1_remoteFromNigeria(j, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/remote_(denied|scope)/);
  });

  it('trusts remote_scope=africa even without a keyword hit', () => {
    const j = { location_raw: 'Africa', description_text: '', remote_scope: 'africa' };
    expect(gate1_remoteFromNigeria(j, config).pass).toBe(true);
  });

  it('charitable-passes bare "Remote" when no US-only signal is present', () => {
    // Was previously needs_review. Change: gate 1 is now more permissive
    // for the plain "Remote" case so we don't bleed ~96% of jobs into
    // a never-drafted needs_review bucket. Deny list still catches
    // US-only postings. See qualify/filters.js note.
    const j = { location_raw: 'Remote', description_text: '', remote_scope: 'unknown' };
    expect(gate1_remoteFromNigeria(j, config).pass).toBe(true);
  });

  it('still needs_review when there is NO remote signal anywhere', () => {
    const j = { location_raw: 'Berlin', description_text: 'in-office 3 days/week', remote_scope: 'unknown' };
    const r = gate1_remoteFromNigeria(j, config);
    expect(r.pass).toBe(false);
    expect(r.needsReview).toBe(true);
  });

  it('bare "Remote" still fails if description contains a US-only signal', () => {
    // The test config's deny list contains "us only" — use that phrase.
    // Real config has richer deny (US timezone, must reside in, N. America
    // only, etc.); those get end-to-end coverage via the integration test.
    const j = {
      location_raw: 'Remote',
      description_text: 'US only. Must be authorized to work in the U.S.',
      remote_scope: 'unknown',
    };
    const r = gate1_remoteFromNigeria(j, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/remote_(denied|scope)/);
  });
});

/* ── Gate 2: pay minimum ───────────────────────────────────── */

describe('gate2_payMinimum', () => {
  it('passes when USD salary is above floor', () => {
    const j = { comp_raw: '$60,000/year', description_text: null };
    expect(gate2_payMinimum(j, config).pass).toBe(true);
  });

  it('fails when USD salary is below floor', () => {
    const j = { comp_raw: '$1,500/month', description_text: null };
    const r = gate2_payMinimum(j, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('pay_below_floor');
  });

  it('passes when salary is unstated (small startups rarely disclose)', () => {
    const j = { comp_raw: null, description_text: 'Competitive salary and equity.' };
    expect(gate2_payMinimum(j, config).pass).toBe(true);
  });

  it('fails when salary is quoted in a currency we do not accept', () => {
    const j = { comp_raw: 'INR 2,500,000/year', description_text: null };
    const r = gate2_payMinimum(j, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('pay_wrong_currency');
  });
});

/* ── Gate 3: skillset match ────────────────────────────────── */

describe('gate3_skillsetMatch', () => {
  it('passes a senior backend engineer with matching stack', () => {
    const j = { title: 'Senior Backend Engineer', description_text: 'Node.js and TypeScript' };
    expect(gate3_skillsetMatch(j, config).pass).toBe(true);
  });

  it('rejects "Manager, Software Engineering" (management, not IC)', () => {
    const j = { title: 'Manager, Software Engineering (Account Management)', description_text: 'Node.js' };
    const r = gate3_skillsetMatch(j, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('title_role_out_of_scope');
  });

  it('rejects "Software Engineer, Machine Learning"', () => {
    const j = { title: 'Software Engineer, Machine Learning Platform', description_text: 'Python' };
    const r = gate3_skillsetMatch(j, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('title_role_out_of_scope');
  });

  it('rejects "Software Engineer - Infrastructure"', () => {
    const j = { title: 'Software Engineer - Infrastructure', description_text: 'Node' };
    expect(gate3_skillsetMatch(j, config).pass).toBe(false);
  });

  it('rejects "Software Engineer - Auth"', () => {
    const j = { title: 'Software Engineer - Auth', description_text: 'Node' };
    expect(gate3_skillsetMatch(j, config).pass).toBe(false);
  });

  it('rejects "Security Software Engineer"', () => {
    const j = { title: 'Security Software Engineer', description_text: 'Node' };
    expect(gate3_skillsetMatch(j, config).pass).toBe(false);
  });

  it('rejects "Staff AI Software Engineer"', () => {
    const j = { title: 'Staff AI Software Engineer', description_text: 'Python' };
    expect(gate3_skillsetMatch(j, config).pass).toBe(false);
  });

  it('rejects "New Grad" role regardless of salary override', () => {
    const j = {
      title: 'Software Engineer, Machine Learning Platform, New Grad',
      description_text: 'Node. Salary $80,000 USD.',
      comp_raw: '$80,000 USD',
    };
    // Even if the salary would clear the junior override, "new grad"
    // structurally doesn't fit a senior applicant.
    const r = gate3_skillsetMatch(j, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/new_grad|role_out_of_scope/);
  });

  it('junior override still works for legit senior-pay junior roles', () => {
    const j = {
      title: 'Junior Backend Engineer',
      description_text: 'Node.js. Salary $60,000 USD.',
      comp_raw: '$60,000 USD',
    };
    expect(gate3_skillsetMatch(j, config).pass).toBe(true);
  });

  it('rejects "Engineering Manager"', () => {
    const j = { title: 'Engineering Manager', description_text: 'Node' };
    expect(gate3_skillsetMatch(j, config).pass).toBe(false);
  });

  it('rejects "Chemical Engineer" with no ROLE_MARKER hit', () => {
    const j = { title: 'Chemical Engineer', description_text: 'refinery operations' };
    const r = gate3_skillsetMatch(j, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('title_not_engineering');
  });
});

/* ── Gate 4: company size ──────────────────────────────────── */

describe('gate4_companySize', () => {
  it('passes 11-50', () => {
    expect(gate4_companySize({ size_band: '11-50' }, config).pass).toBe(true);
  });
  it('passes 201-500', () => {
    expect(gate4_companySize({ size_band: '201-500' }, config).pass).toBe(true);
  });
  it('rejects 501-1000', () => {
    expect(gate4_companySize({ size_band: '501-1000' }, config).pass).toBe(false);
  });
  it('rejects 1000+', () => {
    expect(gate4_companySize({ size_band: '1000+' }, config).pass).toBe(false);
  });
  it('passes unknown (companies/find fills at draft time)', () => {
    expect(gate4_companySize({}, config).pass).toBe(true);
  });
});

/* ── Gate 5: not previously contacted ─────────────────────── */

describe('gate5_notPreviouslyContacted', () => {
  it('passes when not contacted', () => {
    expect(gate5_notPreviouslyContacted(false).pass).toBe(true);
  });
  it('rejects when contacted', () => {
    const r = gate5_notPreviouslyContacted(true);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('contacted_within_90_days');
  });
});

/* ── Gate 6: posting recency ──────────────────────────────── */

describe('gate6_recentPosting', () => {
  it('passes a fresh posting', () => {
    const j = { posted_at: isoDaysAgo(5) };
    expect(gate6_recentPosting(j, config).pass).toBe(true);
  });
  it('rejects a stale posting', () => {
    const j = { posted_at: isoDaysAgo(60) };
    const r = gate6_recentPosting(j, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('posting_stale');
  });
  it('passes when posted_at is missing (some ATSes omit it)', () => {
    expect(gate6_recentPosting({}, config).pass).toBe(true);
  });
});
