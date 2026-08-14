// tests/reply-detect.test.js
// Coverage for QA 1.2 (DSN body parsing) + QA 2.1 (from+subject fallback
// matching + normalized subject).
import { describe, it, expect } from 'vitest';
import {
  parseDsnBody, parseEmailAddress, normalizeSubject,
} from '../src/pipeline/send/reply-detect.js';

describe('parseDsnBody: bounce recipient extraction', () => {
  it('picks up Final-Recipient headers first', () => {
    const body = `
      This is an automatically generated Delivery Status Notification.
      Reporting-MTA: dns; smtp.google.com
      Final-Recipient: rfc822; user@acme.io
      Action: failed
      Status: 5.1.1
      Diagnostic-Code: smtp; 550 5.1.1 Recipient address rejected
    `;
    expect(parseDsnBody(body)).toEqual(['user@acme.io']);
  });

  it('falls back to SMTP-style rejected addresses in angle brackets', () => {
    const body = `
      The following message to <bob@example.com> was undeliverable.
      Diagnostic: 550 5.1.1 <bob@example.com>: Recipient address rejected: User unknown
    `;
    expect(parseDsnBody(body)).toContain('bob@example.com');
  });

  it('filters out our own sending domain', () => {
    const body = `
      From: mailer-daemon@googlemail.com
      Final-Recipient: rfc822; bright@capacitydey.org
      An unrelated user@somewhere.io was mentioned
    `;
    // capacitydey.org is ours; user@somewhere.io is picked up in the
    // loose fallback because there was no Final-Recipient for anyone else.
    const found = parseDsnBody(body);
    expect(found).not.toContain('bright@capacitydey.org');
  });

  it('filters out mailer-daemon / postmaster local parts', () => {
    const body = `
      mailer-daemon@googlemail.com wrote:
      Final-Recipient: rfc822; postmaster@somewhere.com
      Failed recipient: real-user@target.com
    `;
    // With a Final-Recipient present we only return that; but it's postmaster,
    // which our filter drops. Then the loose fallback picks up real-user.
    const out = parseDsnBody(body);
    expect(out).not.toContain('postmaster@somewhere.com');
    expect(out).not.toContain('mailer-daemon@googlemail.com');
  });

  it('returns [] for empty input', () => {
    expect(parseDsnBody('')).toEqual([]);
    expect(parseDsnBody(null)).toEqual([]);
  });
});

describe('parseEmailAddress', () => {
  it('extracts email from "Name <addr>" format', () => {
    expect(parseEmailAddress('"Sarah Kim" <sarah@acme.io>')).toBe('sarah@acme.io');
  });
  it('extracts bare email', () => {
    expect(parseEmailAddress('bare@example.com')).toBe('bare@example.com');
  });
  it('returns null for junk', () => {
    expect(parseEmailAddress('no email here')).toBeNull();
    expect(parseEmailAddress('')).toBeNull();
  });
});

describe('normalizeSubject', () => {
  it('strips Re:/Fwd: prefixes case-insensitively', () => {
    expect(normalizeSubject('Re: Senior Backend application')).toBe('senior backend application');
    expect(normalizeSubject('FWD:  Re: Backend')).toBe('backend');
    expect(normalizeSubject('AW: Applications')).toBe('applications');
  });
  it('collapses whitespace and lowercases', () => {
    expect(normalizeSubject('  Foo   Bar\tBaz\n')).toBe('foo bar baz');
  });
  it('returns empty string for empty input', () => {
    expect(normalizeSubject('')).toBe('');
    expect(normalizeSubject(null)).toBe('');
  });
});
