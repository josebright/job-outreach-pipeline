// tests/typography.test.js
// Guards against the mojibake bug that leaked through on the first real
// Elastic send: Subject header carried an em dash but was declared as
// 7bit ASCII, so receiving clients rendered "—" as "Ã¢Â€Â\"".
import { describe, it, expect } from 'vitest';
import { sanitizeAsciiTypography } from '../src/pipeline/draft/llm.js';
import { encodeHeader, buildMime } from '../src/pipeline/send/gmail.js';

describe('sanitizeAsciiTypography', () => {
  it('replaces em dash with " - "', () => {
    expect(sanitizeAsciiTypography('Backend Engineer application — Uchenna'))
      .toBe('Backend Engineer application - Uchenna');
  });
  it('replaces en dash with " - "', () => {
    expect(sanitizeAsciiTypography('one – two')).toBe('one - two');
  });
  it('replaces curly quotes with straight quotes', () => {
    expect(sanitizeAsciiTypography('‘It’s a “test”'))
      .toBe("'It's a \"test\"");
  });
  it('replaces horizontal ellipsis with three dots', () => {
    expect(sanitizeAsciiTypography('Loading…')).toBe('Loading...');
  });
  it('collapses double spaces introduced by replacements', () => {
    expect(sanitizeAsciiTypography('word—word')).toBe('word - word');
  });
  it('leaves plain ASCII unchanged', () => {
    expect(sanitizeAsciiTypography('Hello world'))
      .toBe('Hello world');
  });
  it('returns empty string for empty input', () => {
    expect(sanitizeAsciiTypography('')).toBe('');
    expect(sanitizeAsciiTypography(null)).toBe(null);
  });
});

describe('encodeHeader (RFC 2047)', () => {
  it('returns plain ASCII unchanged', () => {
    expect(encodeHeader('Senior Backend Engineer application - Uchenna Ugwumadu'))
      .toBe('Senior Backend Engineer application - Uchenna Ugwumadu');
  });
  it('encodes non-ASCII with =?UTF-8?B? wrapper', () => {
    const out = encodeHeader('Bright Ugwumadu — Lagos');
    expect(out.startsWith('=?UTF-8?B?')).toBe(true);
    expect(out.endsWith('?=')).toBe(true);
    // Round-trip: the base64 content should decode back to the original.
    const b64 = out.slice('=?UTF-8?B?'.length, -2);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Bright Ugwumadu — Lagos');
  });
});

describe('buildMime', () => {
  it('sets Content-Transfer-Encoding: 8bit (not 7bit)', () => {
    const mime = buildMime({
      from: 'bright@capacitydey.org', fromName: 'Uchenna',
      to: 'test@example.com', subject: 'Plain subject', body: 'plain body',
    });
    expect(mime).toContain('Content-Transfer-Encoding: 8bit');
    expect(mime).not.toContain('Content-Transfer-Encoding: 7bit');
  });

  it('encodes a non-ASCII subject as an RFC 2047 encoded-word', () => {
    const mime = buildMime({
      from: 'bright@capacitydey.org', fromName: 'Uchenna',
      to: 'test@example.com',
      subject: 'Application — Uchenna', body: 'x',
    });
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  });

  it('encodes a non-ASCII From display name', () => {
    const mime = buildMime({
      from: 'jane@example.com',
      fromName: 'José Kim',    // "José Kim"
      to: 'test@example.com',
      subject: 'Hi', body: 'x',
    });
    // The display name is RFC 2047 encoded, sitting before the angle-addressed email.
    expect(mime).toMatch(/^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <jane@example\.com>/m);
  });

  it('leaves ASCII From display name in the quoted-string form', () => {
    const mime = buildMime({
      from: 'jane@example.com', fromName: 'Jane Kim',
      to: 'test@example.com', subject: 'Hi', body: 'x',
    });
    expect(mime).toMatch(/^From: "Jane Kim" <jane@example\.com>/m);
  });

  it('adds Reply-To only when it differs from From', () => {
    const withReply = buildMime({
      from: 'from@x.com', fromName: 'A', to: 't@x.com', subject: 's', body: 'b',
      replyTo: 'reply@y.com',
    });
    expect(withReply).toMatch(/^Reply-To: reply@y\.com/m);

    const same = buildMime({
      from: 'from@x.com', fromName: 'A', to: 't@x.com', subject: 's', body: 'b',
      replyTo: 'from@x.com',
    });
    expect(same).not.toContain('Reply-To:');
  });
});
