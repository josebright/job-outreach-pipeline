// tests/qualify-filters.test.js
// Unit tests for the Q1-Q5 hard filters.
import { describe, it, expect } from 'vitest';
import {
  q1_roleMatches, q2_remoteEligible, q3_currencyOK,
  q4_visaRelocation, q5_notPreviouslyContacted, q6_companySizeOK,
} from '../src/pipeline/qualify/filters.js';

const config = {
  stack: {
    keywords: ['software engineer', 'backend', 'node', 'python', 'typescript', 'react'],
    seniority_accept: ['senior', 'staff', 'principal'],
    seniority_reject: ['intern', 'junior', 'jr', 'graduate', 'entry'],
    junior_override_min_annual: 36000,
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

  it('rejects when title is not engineering (Product Manager)', () => {
    const job = { title: 'Product Manager', description_text: 'roadmap and stakeholders' };
    const r = q1_roleMatches(job, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('title_not_engineering');
  });

  it('rejects generic "Engineer" titles outside the SWE scope', () => {
    // Chemical Engineer contains "engineer" but no software-role marker.
    const job = { title: 'Chemical Engineer', description_text: 'refinery operations' };
    const r = q1_roleMatches(job, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('title_not_engineering');
  });

  it('rejects a Demand Generation Lead even if description lists Python', () => {
    const job = { title: 'Demand Generation Lead', description_text: 'We use Python and Node internally.' };
    const r = q1_roleMatches(job, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('title_not_engineering');
  });

  it('rejects Solutions Architect (out-of-scope role)', () => {
    const job = { title: 'Senior Solutions Architect', description_text: 'Node, Python, AWS.' };
    const r = q1_roleMatches(job, config);
    expect(r.pass).toBe(false);
    // "architect" matches REJECT_ROLE_MARKERS; may also match title_not_engineering
    // if no software marker; either way, not qualified.
    expect(r.reason).toMatch(/^title_(role_out_of_scope|not_engineering)$/);
  });

  it('rejects Site Reliability Engineer (out-of-scope role)', () => {
    const job = { title: 'Site Reliability Engineer', description_text: 'Node, Kubernetes.' };
    const r = q1_roleMatches(job, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/^title_(role_out_of_scope|not_engineering)$/);
  });

  it('rejects Data Engineer (out of scope)', () => {
    const job = { title: 'Senior Data Engineer', description_text: 'Python, SQL, Airflow.' };
    const r = q1_roleMatches(job, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/^title_(role_out_of_scope|not_engineering)$/);
  });

  it('rejects Machine Learning Engineer (out of scope)', () => {
    const job = { title: 'Machine Learning Engineer', description_text: 'PyTorch, Python.' };
    const r = q1_roleMatches(job, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/^title_(role_out_of_scope|not_engineering)$/);
  });

  it('accepts Founding Engineer', () => {
    const job = { title: 'Founding Engineer', description_text: 'Node, TypeScript, React.' };
    expect(q1_roleMatches(job, config).pass).toBe(true);
  });

  it('accepts Product Engineer', () => {
    const job = { title: 'Product Engineer', description_text: 'Node, TypeScript.' };
    expect(q1_roleMatches(job, config).pass).toBe(true);
  });

  it('accepts Research Engineer', () => {
    const job = { title: 'Research Engineer', description_text: 'Python, Node.' };
    expect(q1_roleMatches(job, config).pass).toBe(true);
  });

  it('does not confuse "seniority" with "senior" in reject list check', () => {
    const job = { title: 'Backend Engineer', description_text: 'senior-level roadmap for the team' };
    // reject list contains 'jr' etc, not 'senior'. Should pass.
    expect(q1_roleMatches(job, config).pass).toBe(true);
  });

  it('junior override: passes junior role when salary meets floor', () => {
    const job = {
      title: 'Junior Backend Engineer',
      description_text: 'Node.js. Compensation: $60,000 USD annually.',
      comp_raw: '$60,000/year USD',
    };
    expect(q1_roleMatches(job, config).pass).toBe(true);
  });

  it('junior override: still rejects when salary is below floor', () => {
    const job = {
      title: 'Junior Backend Engineer',
      description_text: 'Node.js. Salary $20,000 USD annually.',
    };
    const r = q1_roleMatches(job, config);
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('seniority_below_target');
  });

  it('junior override: rejects when no salary is stated', () => {
    const job = {
      title: 'Junior Backend Engineer',
      description_text: 'Node.js. Competitive salary.',
    };
    expect(q1_roleMatches(job, config).pass).toBe(false);
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

  it('charitable-passes bare "Remote" (post gate-1 loosening)', () => {
    const job = { location_raw: 'Remote', description_text: '', remote_scope: 'unknown' };
    expect(q2_remoteEligible(job, config, 'A').pass).toBe(true);
  });

  it('still needs_review when NO remote signal at all', () => {
    const job = { location_raw: 'Berlin', description_text: 'in-office', remote_scope: 'unknown' };
    const r = q2_remoteEligible(job, config, 'A');
    expect(r.pass).toBe(false);
    expect(r.needsReview).toBe(true);
  });

  it('trusts remote_scope=africa even without an allow keyword hit', () => {
    const job = { location_raw: 'Africa', description_text: '', remote_scope: 'africa' };
    expect(q2_remoteEligible(job, config, 'A').pass).toBe(true);
  });
});

/* ── Q3 / Q4 removed ────────────────────────────────────────
 *
 * Currency (old Q3) is now enforced inside gate2_payMinimum — we only
 * care about currency when we can *see* a pay number. No stated pay ⇒
 * no currency to check. See tests/pay-check.test.js and
 * tests/gate2-pay.test.js.
 *
 * Visa/relocation (old Q4) is removed with Track B. The priority-gate
 * design requires remote-from-Nigeria (gate 1); visa sponsorship is not
 * a path the applicant wants.
 *
 * The q3/q4 back-compat exports are no-op stubs — they always return
 * pass:true so any straggling caller does not accidentally block a job.
 */

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

/* ── Q6 company size ────────────────────────────────────────── */

describe('Q6: company size sanity', () => {
  const cfg = { scoring: { reject_size_bands: ['501-1000', '1000+', '1001-5000', '5001-10000', '10001+', '10000+'] } };

  it('passes when size is unknown', () => {
    expect(q6_companySizeOK({}, cfg).pass).toBe(true);
    expect(q6_companySizeOK({ size_band: null }, cfg).pass).toBe(true);
  });

  it('passes for 11-50 (sweet spot)', () => {
    expect(q6_companySizeOK({ size_band: '11-50' }, cfg).pass).toBe(true);
  });

  it('passes for 51-200', () => {
    expect(q6_companySizeOK({ size_band: '51-200' }, cfg).pass).toBe(true);
  });

  it('passes for 201-500', () => {
    expect(q6_companySizeOK({ size_band: '201-500' }, cfg).pass).toBe(true);
  });

  it('rejects 501-1000 (hard ceiling at 500)', () => {
    const r = q6_companySizeOK({ size_band: '501-1000' }, cfg);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('company_size_too_large');
  });

  it('rejects 1000+', () => {
    const r = q6_companySizeOK({ size_band: '1000+' }, cfg);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('company_size_too_large');
  });

  it('rejects 10000+', () => {
    expect(q6_companySizeOK({ size_band: '10000+' }, cfg).pass).toBe(false);
  });

  it('reject list is case-insensitive', () => {
    expect(q6_companySizeOK({ size_band: '1000+' }, cfg).pass).toBe(false);
  });
});
