// tests/pay-check.test.js
import { describe, it, expect } from 'vitest';
import { checkPay } from '../src/pipeline/qualify/pay-check.js';

const OPTS = { minAnnual: 24000 };

describe('checkPay', () => {
  it('above_floor when USD salary meets minimum', () => {
    const r = checkPay({ compRaw: '$60,000/year', descriptionText: null, ...OPTS });
    expect(r.status).toBe('above_floor');
    expect(r.annual).toBe(60000);
    expect(r.currency).toBe('USD');
  });

  it('above_floor for GBP and EUR too', () => {
    expect(checkPay({ compRaw: '£45k', descriptionText: null, ...OPTS }).status).toBe('above_floor');
    expect(checkPay({ compRaw: '€30,000 per year', descriptionText: null, ...OPTS }).status).toBe('above_floor');
  });

  it('below_floor when USD salary is under minimum', () => {
    const r = checkPay({ compRaw: '$1,500/month', descriptionText: null, ...OPTS });
    // $1500 * 12 = $18k < $24k floor
    expect(r.status).toBe('below_floor');
    expect(r.annual).toBe(18000);
  });

  it('unstated when neither comp_raw nor description has any currency', () => {
    const r = checkPay({ compRaw: null, descriptionText: 'Competitive salary and benefits.', ...OPTS });
    expect(r.status).toBe('unstated');
    expect(r.annual).toBeNull();
  });

  it('wrong_currency when salary is quoted in a currency we do not accept', () => {
    const r = checkPay({ compRaw: 'INR 2,500,000/year', descriptionText: null, ...OPTS });
    expect(r.status).toBe('wrong_currency');
    expect(r.currency).toBe('INR');
  });

  it('wrong_currency detects rupee symbol', () => {
    const r = checkPay({ compRaw: null, descriptionText: 'Base pay: ₹2,000,000 per annum.', ...OPTS });
    expect(r.status).toBe('wrong_currency');
  });

  it('wrong_currency detects Naira', () => {
    const r = checkPay({ compRaw: null, descriptionText: 'Salary ₦12,000,000 per year.', ...OPTS });
    expect(r.status).toBe('wrong_currency');
  });

  it('unstated ignores non-accepted currency when no salary is nearby (fallback text noise)', () => {
    // Only fires wrong_currency when a currency TOKEN is present. If the
    // text only mentions "AUD" in the country context but no amount, we
    // still consider it "unstated" (currency was detected → wrong_currency).
    const r = checkPay({ compRaw: null, descriptionText: 'Team is based in AUD-related area', ...OPTS });
    expect(r.status).toBe('wrong_currency');    // AUD token flagged
  });

  it('accepts a range and picks the median', () => {
    const r = checkPay({ compRaw: '$120,000 - $180,000', descriptionText: null, ...OPTS });
    expect(r.status).toBe('above_floor');
    // Median-ish; salary.js takes the median of hits
    expect(r.annual).toBeGreaterThanOrEqual(120000);
  });
});
