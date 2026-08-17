// tests/typography.test.js
// Guards against the mojibake bug that leaked through on the first real
// Elastic send: Subject header carried an em dash but was declared as
// 7bit ASCII, so receiving clients rendered "—" as "Ã¢Â€Â\"".
import { describe, it, expect } from 'vitest';
import { sanitizeAsciiTypography, collapseHardWraps } from '../src/pipeline/draft/llm.js';
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

describe('collapseHardWraps', () => {
  it('joins soft-wrapped lines within a paragraph', () => {
    const input = 'I came across the role at Linear, and the\nframing around being the first hire\nstood out to me.';
    const out = collapseHardWraps(input);
    expect(out).toBe('I came across the role at Linear, and the framing around being the first hire stood out to me.');
  });

  it('keeps paragraph breaks (double newlines)', () => {
    const input = 'First paragraph is one long thought.\n\nSecond paragraph is another.';
    expect(collapseHardWraps(input)).toBe('First paragraph is one long thought.\n\nSecond paragraph is another.');
  });

  it('collapses within paragraphs but not across paragraphs', () => {
    const input = 'Para one\nwith wrap.\n\nPara two\nalso wrapped.';
    expect(collapseHardWraps(input)).toBe('Para one with wrap.\n\nPara two also wrapped.');
  });

  it('preserves line breaks in signature paragraphs (contain URLs)', () => {
    const input = 'Real body sentence here.\n\nUchenna Bright Ugwumadu\nhttps://brightugwumadu.vercel.app\nhttps://www.linkedin.com/in/josebright';
    const out = collapseHardWraps(input);
    expect(out).toContain('Uchenna Bright Ugwumadu\nhttps://brightugwumadu.vercel.app\nhttps://www.linkedin.com/in/josebright');
    expect(out.split('\n\n').length).toBe(2);
  });

  it('handles Windows CRLF line endings', () => {
    // Real paragraph text ends with a terminator; the merge logic uses
    // that to distinguish real breaks from LLM soft-wrap noise.
    const input = 'line one\r\nline two.\r\n\r\npara two.';
    expect(collapseHardWraps(input)).toBe('line one line two.\n\npara two.');
  });

  it('drops empty paragraphs', () => {
    const input = 'para one.\n\n\n\npara two.';
    expect(collapseHardWraps(input)).toBe('para one.\n\npara two.');
  });

  it('returns empty inputs unchanged', () => {
    expect(collapseHardWraps('')).toBe('');
    expect(collapseHardWraps(null)).toBe(null);
  });

  /* ── Sonnet's "blank line between every sentence" quirk ────── */

  it('MERGES faux paragraphs when the previous chunk does not end with . ? ! :', () => {
    // Real-world case from the /preview #76 screenshot: Claude emitted
    // each mid-sentence chunk as its own paragraph with blank lines
    // between, which mobile Gmail then renders as a jagged wall.
    const input = [
      'AI Gateway sitting between coding agents and providers',
      '',
      'like OpenAI or',
      '',
      'Anthropic - with audit trails, token tracking, and cost',
      '',
      'control - is',
      '',
      'exactly the kind of security boundary work I find worth',
      '',
      'getting right.',
    ].join('\n');
    const out = collapseHardWraps(input);
    // Should collapse into ONE paragraph (single continuous line).
    expect(out).not.toContain('\n\n');
    expect(out).toContain('AI Gateway sitting between coding agents and providers like OpenAI or Anthropic');
    expect(out.trim().endsWith('getting right.')).toBe(true);
  });

  it('keeps a real paragraph break when the previous chunk ends with a period', () => {
    const input = 'First real thought.\n\nSecond real thought.';
    expect(collapseHardWraps(input)).toBe('First real thought.\n\nSecond real thought.');
  });

  it('mixed case: keeps real breaks, merges faux breaks', () => {
    const input = [
      'Token cost governance is what most teams miss',   // no terminator → faux break
      '',
      'and I hit it at Paystack.',                        // → merged with previous
      '',
      'On stack, TypeScript and Postgres overlap.',       // ends "." → real break holds
      '',
      'Worth 15 min this week?',                          // ends "?" → real break holds
    ].join('\n');
    const out = collapseHardWraps(input);
    const paras = out.split('\n\n');
    expect(paras.length).toBe(3);
    expect(paras[0]).toBe('Token cost governance is what most teams miss and I hit it at Paystack.');
    expect(paras[1]).toBe('On stack, TypeScript and Postgres overlap.');
    expect(paras[2]).toBe('Worth 15 min this week?');
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
