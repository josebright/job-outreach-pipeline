// tests/qualify-score.test.js
// Unit tests for the soft scoring function.
import { describe, it, expect } from 'vitest';
import { scoreJob } from '../src/pipeline/qualify/score.js';

const config = {
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
      explicit_salary: 15,
      remote_worldwide: 15,
      recent_post_days: 15,
      stack_overlap: 10,
      company_size_sweet_spot: 10,
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
      currency_signal: 'USD',
      remote_scope: 'worldwide',
      posted_at: isoDaysAgo(3),
    };
    const company = { nigeria_presence: 1, size_band: '51-200' };
    const { score, breakdown } = scoreJob(job, company, config);
    expect(score).toBeGreaterThanOrEqual(90);
    expect(breakdown.nigeria_presence).toBe(30);
    expect(breakdown.explicit_salary).toBe(15);
    expect(breakdown.remote_worldwide).toBe(15);
    expect(breakdown.recent_post_days).toBe(15);
    expect(breakdown.stack_overlap).toBe(10);
    expect(breakdown.company_size_sweet_spot).toBe(10);
    expect(breakdown.eor_mention).toBe(5);
  });

  it('a bare-minimum job scores 0', () => {
    const job = {
      title: 'Backend',
      description_text: 'Backend role.',
      comp_raw: null,
      currency_signal: null,
      remote_scope: 'unknown',
      posted_at: isoDaysAgo(60),
    };
    const company = { nigeria_presence: 0, size_band: null };
    const { score } = scoreJob(job, company, config);
    expect(score).toBe(0);
  });

  it('awards recent_post only within 14 days', () => {
    const jobRecent = { posted_at: isoDaysAgo(5), description_text: '', title: '', remote_scope: 'unknown' };
    const jobOld    = { posted_at: isoDaysAgo(30), description_text: '', title: '', remote_scope: 'unknown' };
    const empty = { nigeria_presence: 0 };
    expect(scoreJob(jobRecent, empty, config).breakdown.recent_post_days).toBe(15);
    expect(scoreJob(jobOld, empty, config).breakdown.recent_post_days).toBeUndefined();
  });

  it('stack overlap requires at least 3 keyword matches', () => {
    const two = { title: 'Node engineer', description_text: 'TypeScript', remote_scope: 'unknown' };
    const three = { title: 'Node TypeScript engineer', description_text: 'Python automation', remote_scope: 'unknown' };
    expect(scoreJob(two, {}, config).breakdown.stack_overlap).toBeUndefined();
    expect(scoreJob(three, {}, config).breakdown.stack_overlap).toBe(10);
  });

  it('company_size_sweet_spot ignores giant or tiny companies', () => {
    const job = { title: '', description_text: '', remote_scope: 'unknown' };
    expect(scoreJob(job, { size_band: '1-10' }, config).breakdown.company_size_sweet_spot).toBeUndefined();
    expect(scoreJob(job, { size_band: '1000+' }, config).breakdown.company_size_sweet_spot).toBeUndefined();
    expect(scoreJob(job, { size_band: '51-200' }, config).breakdown.company_size_sweet_spot).toBe(10);
  });
});
