// tests/greenhouse.test.js
// Unit tests for the Greenhouse normalization helpers. Uses a small fixture
// rather than hitting the network.
import { describe, it, expect } from 'vitest';
import { classifyWorkplace, classifyRemoteScope, detectCurrency } from '../src/pipeline/ingest/ats/greenhouse.js';

describe('greenhouse classifiers', () => {
  it('detects fully remote from location string', () => {
    expect(classifyWorkplace('Remote', '')).toBe('remote');
    expect(classifyWorkplace('San Francisco, CA', '')).toBe('onsite');
    expect(classifyWorkplace('Berlin (Hybrid)', '')).toBe('hybrid');
  });

  it('detects remote scope keywords', () => {
    expect(classifyRemoteScope('Remote - Worldwide', '')).toBe('worldwide');
    expect(classifyRemoteScope('Remote (US)', '')).toBe('us_only');
    expect(classifyRemoteScope('Remote - EMEA', '')).toBe('emea');
    expect(classifyRemoteScope('Africa', '')).toBe('africa');
    expect(classifyRemoteScope('Remote', '')).toBe('unknown');
    expect(classifyRemoteScope('London', '')).toBe('onsite');
  });

  it('detects currency signals', () => {
    expect(detectCurrency('Salary $150,000 to $200,000 USD')).toBe('USD');
    expect(detectCurrency('€90k - €120k base')).toBe('EUR');
    expect(detectCurrency('£80,000-£100,000')).toBe('GBP');
    expect(detectCurrency('Competitive pay')).toBe(null);
  });
});
