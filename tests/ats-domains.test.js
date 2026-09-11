// tests/ats-domains.test.js
// The ATS/job-board blocklist that keeps pattern-probe addresses like
// founders@api.smartrecruiters.com out of both enrichment and the send path.
import { describe, it, expect } from 'vitest';
import { isAtsHost, isAtsEmail, ATS_DOMAINS } from '../src/pipeline/util/ats-domains.js';

describe('isAtsHost', () => {
  it('matches the bare registrable domain', () => {
    expect(isAtsHost('smartrecruiters.com')).toBe(true);
    expect(isAtsHost('greenhouse.io')).toBe(true);
    expect(isAtsHost('lever.co')).toBe(true);
  });

  it('matches subdomains — this is the case that leaked into production', () => {
    // api.smartrecruiters.com is what the SmartRecruiters adapter stores as
    // the job URL (raw.ref), and it became the "company domain" for both
    // Cint and ServiceNow.
    expect(isAtsHost('api.smartrecruiters.com')).toBe(true);
    expect(isAtsHost('jobs.smartrecruiters.com')).toBe(true);
    expect(isAtsHost('boards.greenhouse.io')).toBe(true);
    expect(isAtsHost('job-boards.greenhouse.io')).toBe(true);
    expect(isAtsHost('api.lever.co')).toBe(true);
    expect(isAtsHost('jobs.lever.co')).toBe(true);
    expect(isAtsHost('api.ashbyhq.com')).toBe(true);
    expect(isAtsHost('apply.workable.com')).toBe(true);
  });

  it('covers every ATS platform listed in config.discover.ats_platforms', () => {
    for (const d of ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'smartrecruiters.com']) {
      expect(ATS_DOMAINS).toContain(d);
      expect(isAtsHost(`api.${d}`)).toBe(true);
    }
  });

  it('normalizes case, www. and a trailing dot', () => {
    expect(isAtsHost('WWW.Smartrecruiters.COM')).toBe(true);
    expect(isAtsHost('api.smartrecruiters.com.')).toBe(true);
  });

  it('does NOT match real employer domains', () => {
    expect(isAtsHost('clera.io')).toBe(false);
    expect(isAtsHost('narvar.com')).toBe(false);
    expect(isAtsHost('checkly.app')).toBe(false);
    expect(isAtsHost('acme.io')).toBe(false);
  });

  it('does not match a domain that merely contains an ATS name', () => {
    // Suffix match, not substring — "notgreenhouse.io" is a different domain.
    expect(isAtsHost('notgreenhouse.io')).toBe(false);
    expect(isAtsHost('mysmartrecruiters.com')).toBe(false);
  });

  it('handles null / empty input', () => {
    expect(isAtsHost(null)).toBe(false);
    expect(isAtsHost('')).toBe(false);
    expect(isAtsHost(undefined)).toBe(false);
  });
});

describe('isAtsEmail', () => {
  it('flags the exact addresses sitting in the approved queue', () => {
    expect(isAtsEmail('founders@api.smartrecruiters.com')).toBe(true);
  });

  it('allows real employer addresses', () => {
    expect(isAtsEmail('contact@clera.io')).toBe(false);
    expect(isAtsEmail('ram.ravichandran@narvar.com')).toBe(false);
    expect(isAtsEmail('founders@checkly.app')).toBe(false);
  });

  it('uses the last @ so plus-addressing and quoted locals do not fool it', () => {
    expect(isAtsEmail('a@b@api.smartrecruiters.com')).toBe(true);
    expect(isAtsEmail('user+tag@api.smartrecruiters.com')).toBe(true);
  });

  it('handles malformed input', () => {
    expect(isAtsEmail('not-an-email')).toBe(false);
    expect(isAtsEmail(null)).toBe(false);
    expect(isAtsEmail('')).toBe(false);
  });
});
