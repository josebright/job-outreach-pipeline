// tests/email-domain.test.js
// Node's URL parser is much looser than DNS: new URL('https://&') parses and
// reports hostname '&'. deriveDomain trusted that, so '&' became a company's
// mail domain and the pattern probe produced founders@& - six of which reached
// the approved queue and would every one of them have bounced.
import { describe, it, expect } from 'vitest';
import { isPlausibleDomain, normalizeCompanyDomain, isValidEmail } from '../src/pipeline/util/email-domain.js';

describe('isPlausibleDomain', () => {
  it('rejects the hostnames Node happily parses but DNS never would', () => {
    for (const h of ['&', '&amp;', '&nbsp;', 'localhost', 'foo_bar.com', '', null, 'a..b.com', '1.2.3.4']) {
      expect(isPlausibleDomain(h), String(h)).toBe(false);
    }
  });
  it('accepts real domains', () => {
    for (const h of ['acme.io', 'sub.acme.io', 'acme.co.uk', 'a-b.dev']) {
      expect(isPlausibleDomain(h), h).toBe(true);
    }
  });
  it('is case and trailing-dot insensitive', () => {
    expect(isPlausibleDomain('ACME.IO')).toBe(true);
    expect(isPlausibleDomain('acme.io.')).toBe(true);
  });
});

describe('normalizeCompanyDomain', () => {
  it('folds careers subdomains down to the apex', () => {
    // jobs.dropbox.com is a real hostname, so it passed every syntactic check -
    // but Hunter indexes no mail there, so Dropbox stayed size "unknown" and
    // walked through the 2-500 employee gate.
    expect(normalizeCompanyDomain('jobs.dropbox.com')).toBe('dropbox.com');
    expect(normalizeCompanyDomain('careers.acme.io')).toBe('acme.io');
    expect(normalizeCompanyDomain('apply.acme.co.uk')).toBe('acme.co.uk');
  });
  it('strips www', () => {
    expect(normalizeCompanyDomain('www.acme.io')).toBe('acme.io');
  });
  it('leaves a normal subdomain alone', () => {
    expect(normalizeCompanyDomain('eu.acme.io')).toBe('eu.acme.io');
  });
  it('never strips a two-label domain down to its TLD', () => {
    expect(normalizeCompanyDomain('careers.io')).toBe('careers.io');
    expect(normalizeCompanyDomain('jobs.com')).toBe('jobs.com');
  });
  it('returns null for junk', () => {
    expect(normalizeCompanyDomain('&')).toBeNull();
    expect(normalizeCompanyDomain('')).toBeNull();
  });
});

describe('isValidEmail', () => {
  it('rejects the exact address that reached the queue six times', () => {
    expect(isValidEmail('founders@&')).toBe(false);
  });
  it('rejects other malformed addresses', () => {
    for (const e of ['no-at', '@acme.io', 'a@', 'a b@acme.io', 'a@acme', '.a@acme.io', 'a..b@acme.io']) {
      expect(isValidEmail(e), e).toBe(false);
    }
  });
  it('accepts real addresses', () => {
    for (const e of ['contact@clera.io', 'ram.ravichandran@narvar.com', 'a+b@acme.co.uk']) {
      expect(isValidEmail(e), e).toBe(true);
    }
  });
});
