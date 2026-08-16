// tests/hunter-helpers.test.js
// Covers the pure helpers added when we adopted Hunter's own recommended
// small-company workflow (email-count pre-check, companies/find backfill,
// accept_all downgrade).
import { describe, it, expect } from 'vitest';
import { mapHunterStatus, employeesToBand } from '../src/pipeline/enrich/hunter.js';

describe('mapHunterStatus', () => {
  it('maps deliverable/valid to verified', () => {
    expect(mapHunterStatus('deliverable')).toBe('verified');
    expect(mapHunterStatus('valid')).toBe('verified');
  });

  it('maps undeliverable/disposable to invalid', () => {
    expect(mapHunterStatus('undeliverable')).toBe('invalid');
    expect(mapHunterStatus('disposable')).toBe('invalid');
  });

  it('maps accept_all to invalid (Hunter\'s own warning against sending)', () => {
    expect(mapHunterStatus('accept_all')).toBe('invalid');
    // Case-insensitive.
    expect(mapHunterStatus('ACCEPT_ALL')).toBe('invalid');
  });

  it('maps webmail/risky/unknown to risky (never dropped silently)', () => {
    expect(mapHunterStatus('webmail')).toBe('risky');
    expect(mapHunterStatus('risky')).toBe('risky');
    expect(mapHunterStatus('unknown')).toBe('risky');
  });

  it('maps null/empty to risky', () => {
    expect(mapHunterStatus(null)).toBe('risky');
    expect(mapHunterStatus('')).toBe('risky');
  });
});

describe('employeesToBand', () => {
  it('converts small counts to matching bands', () => {
    expect(employeesToBand(3)).toBe('1-10');
    expect(employeesToBand(10)).toBe('1-10');
    expect(employeesToBand(11)).toBe('11-50');
    expect(employeesToBand(50)).toBe('11-50');
    expect(employeesToBand(51)).toBe('51-200');
    expect(employeesToBand(200)).toBe('51-200');
    expect(employeesToBand(201)).toBe('201-500');
    expect(employeesToBand(500)).toBe('201-500');
  });

  it('converts mid+ counts to matching bands', () => {
    expect(employeesToBand(501)).toBe('501-1000');
    expect(employeesToBand(1000)).toBe('501-1000');
    expect(employeesToBand(2000)).toBe('1000+');
    expect(employeesToBand(50000)).toBe('1000+');
  });

  it('returns null for unusable input', () => {
    expect(employeesToBand(null)).toBeNull();
    expect(employeesToBand(undefined)).toBeNull();
    expect(employeesToBand(0)).toBeNull();
    expect(employeesToBand(NaN)).toBeNull();
    expect(employeesToBand('not-a-number')).toBeNull();
  });

  it('accepts numeric strings', () => {
    expect(employeesToBand('25')).toBe('11-50');
  });
});
