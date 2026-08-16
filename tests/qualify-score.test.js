// tests/qualify-score.test.js
// Unit tests for the soft scoring function (post priority-gate rewrite).
// remote_worldwide, explicit_salary, and recent_post_days are gone —
// they became hard gates. What remains is what discriminates *within*
// the pool that already passed every gate.
import { describe, it, expect } from 'vitest';
import { scoreJob } from '../src/pipeline/qualify/score.js';

const config = {
  gates: { pay_minimum_annual: 24000, max_posting_age_days: 30 },
  stack: {
    keywords: ['software engineer', 'backend', 'node', 'python', 'typescript', 'react', 'automation'],
  },
  currency: {
    accept: ['USD', 'EUR', 'GBP'],
    contractor_signal_words: ['deel', 'remote.com', 'employer of record'],
  },
  scoring: {
    threshold: 40,
    weights: {
      nigeria_presence: 30,
      pay_amount_bonus: 15,
      recency_bonus: 15,
      stack_overlap: 10,
      company_size_sweet_spot: 20,
      seed_stage_bonus: 5,
      eor_mention: 5,
    },
  },
};

function isoDaysAgo(d) {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
}

describe('scoreJob', () => {
  it('a maximum-scoring job hits the ceiling near 100', () => {
    const job = {
      title: 'Senior Backend Engineer',
      description_text: 'Node, TypeScript, Python, React. We hire via Deel worldwide. Salary $150k-$200k.',
      comp_raw: '$150,000 - $200,000 USD',
      posted_at: isoDaysAgo(3),
    };
    const company = { nigeria_presence: 1, size_band: '11-50' };
    const { score, breakdown } = scoreJob(job, company, config);
    // 30 + 15 (pay ratio ~6-8x floor, capped) + 15 (recent) + 10 + 20 + 5 + 5 = 100
    expect(score).toBeGreaterThanOrEqual(90);
    expect(breakdown.nigeria_presence).toBe(30);
    expect(breakdown.pay_amount_bonus).toBe(15);
    expect(breakdown.recency_bonus).toBe(15);
    expect(breakdown.stack_overlap).toBe(10);
    expect(breakdown.company_size_sweet_spot).toBe(20);
    expect(breakdown.seed_stage_bonus).toBe(5);
    expect(breakdown.eor_mention).toBe(5);
  });

  it('a bare-minimum job scores 0', () => {
    const job = {
      title: 'Backend',
      description_text: 'Backend role.',
      comp_raw: null,
      posted_at: isoDaysAgo(60),
    };
    const company = { nigeria_presence: 0, size_band: null };
    const { score } = scoreJob(job, company, config);
    expect(score).toBe(0);
  });

  it('recency_bonus is a sliding scale within the 30-day window', () => {
    const empty = { nigeria_presence: 0 };
    const mk = d => ({ posted_at: isoDaysAgo(d), description_text: '', title: '', comp_raw: null });
    // Full weight (15) at ≤ 7 days
    expect(scoreJob(mk(3),  empty, config).breakdown.recency_bonus).toBe(15);
    // ~66% at 8-14 days
    expect(scoreJob(mk(10), empty, config).breakdown.recency_bonus).toBe(10);
    // ~33% at 15-21 days
    expect(scoreJob(mk(20), empty, config).breakdown.recency_bonus).toBe(5);
    // Fades to ~15% at 22-30 days but still fresh
    expect(scoreJob(mk(28), empty, config).breakdown.recency_bonus).toBe(2);
    // Stale (>30) => no bonus (gate 6 would also drop it)
    expect(scoreJob(mk(40), empty, config).breakdown.recency_bonus).toBeUndefined();
  });

  it('pay_amount_bonus is a sliding scale above the floor', () => {
    const empty = { nigeria_presence: 0 };
    const mk = usd => ({
      title: '', description_text: `Salary $${usd.toLocaleString()} USD annually.`,
      comp_raw: `$${usd.toLocaleString()} USD`,
      posted_at: isoDaysAgo(60),   // outside recency, so recency doesn't contaminate
    });
    // At the floor ($24k) → 25% of cap
    expect(scoreJob(mk(24000), empty, config).breakdown.pay_amount_bonus).toBe(4);
    // 2x floor ($48k) → 50%
    expect(scoreJob(mk(50000), empty, config).breakdown.pay_amount_bonus).toBe(8);
    // 3x ($72k) → 75%
    expect(scoreJob(mk(75000), empty, config).breakdown.pay_amount_bonus).toBe(11);
    // 4x+ ($96k+) → full
    expect(scoreJob(mk(120000), empty, config).breakdown.pay_amount_bonus).toBe(15);
    // Below floor → nothing (gate 2 would also drop it)
    expect(scoreJob(mk(20000), empty, config).breakdown.pay_amount_bonus).toBeUndefined();
  });

  it('stack overlap requires at least 3 keyword matches', () => {
    const two = { title: 'Node engineer', description_text: 'TypeScript', comp_raw: null };
    const three = { title: 'Node TypeScript engineer', description_text: 'Python automation', comp_raw: null };
    expect(scoreJob(two, {}, config).breakdown.stack_overlap).toBeUndefined();
    expect(scoreJob(three, {}, config).breakdown.stack_overlap).toBe(10);
  });

  it('company_size_sweet_spot ignores giant or tiny companies', () => {
    const job = { title: '', description_text: '', comp_raw: null };
    expect(scoreJob(job, { size_band: '1-10' }, config).breakdown.company_size_sweet_spot).toBeUndefined();
    expect(scoreJob(job, { size_band: '1000+' }, config).breakdown.company_size_sweet_spot).toBeUndefined();
    expect(scoreJob(job, { size_band: '51-200' }, config).breakdown.company_size_sweet_spot).toBe(20);
  });

  it('seed_stage_bonus rewards 2-50 employees', () => {
    const job = { title: '', description_text: '', comp_raw: null };
    expect(scoreJob(job, { size_band: '11-50' }, config).breakdown.seed_stage_bonus).toBe(5);
    expect(scoreJob(job, { size_band: '51-200' }, config).breakdown.seed_stage_bonus).toBeUndefined();
  });
});
