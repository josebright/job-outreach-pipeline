// tests/salary.test.js
import { describe, it, expect } from 'vitest';
import { extractAnnualSalary } from '../src/pipeline/qualify/salary.js';

const D = (text) => extractAnnualSalary({ descriptionText: text });

describe('extractAnnualSalary', () => {
  it('parses "$150,000 - $200,000 USD"', () => {
    const r = D('Salary range: $150,000 - $200,000 USD');
    expect(r.currency).toBe('USD');
    expect(r.annual).toBeGreaterThanOrEqual(150000);
    expect(r.annual).toBeLessThanOrEqual(200000);
  });

  it('parses "$150k"', () => {
    expect(D('Base $150k').annual).toBe(150000);
  });

  it('parses "€90k - €120k base"', () => {
    const r = D('Comp: €90k - €120k base');
    expect(r.currency).toBe('EUR');
    expect(r.annual).toBeGreaterThanOrEqual(90000);
  });

  it('parses "£80,000-£100,000"', () => {
    const r = D('Salary £80,000-£100,000');
    expect(r.currency).toBe('GBP');
  });

  it('parses monthly rates and converts to annual', () => {
    const r = D('We pay $5,000/month');
    expect(r.annual).toBe(60000);
    expect(r.monthly).toBe(5000);
  });

  it('parses hourly rates and converts to annual', () => {
    const r = D('Rate: $50/hour');
    expect(r.annual).toBe(50 * 40 * 52);
  });

  it('returns null for competitive/undisclosed', () => {
    expect(D('Competitive salary based on experience')).toBeNull();
  });

  it('ignores currencies not in the accepted list', () => {
    expect(extractAnnualSalary({ descriptionText: '¥8,000,000', acceptedCurrencies: ['USD', 'EUR', 'GBP'] })).toBeNull();
  });

  it('prefers comp_raw over description when both have amounts', () => {
    const r = extractAnnualSalary({
      compRaw: 'USD 180000',
      descriptionText: 'Also see $200,000 mentioned elsewhere',
    });
    expect(r.annual).toBe(180000);
  });
});
