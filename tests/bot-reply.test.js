// tests/bot-reply.test.js
// The bot used to fail silently: bot.catch logged the error and returned, so
// a thrown handler or a rejected Telegram call produced no reply at all. And
// /list grows ~140 chars per queued draft against Telegram's 4096-char limit,
// so the queue view would vanish once it got long enough.
import { describe, it, expect } from 'vitest';
import { chunkMessage } from '../src/pipeline/bot/index.js';

describe('chunkMessage', () => {
  it('leaves a short message as a single chunk', () => {
    expect(chunkMessage('hello')).toEqual(['hello']);
  });

  it('never emits a chunk over the limit', () => {
    const line = 'x'.repeat(100);
    const text = Array.from({ length: 200 }, () => line).join('\n');
    const parts = chunkMessage(text, 3500);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(3500);
  });

  it('splits on line boundaries so no chunk lands mid-tag', () => {
    const text = Array.from({ length: 400 }, (_, i) => `<b>row ${i}</b>`).join('\n');
    for (const p of chunkMessage(text, 500)) {
      const opens = (p.match(/<b>/g) || []).length;
      const closes = (p.match(/<\/b>/g) || []).length;
      expect(opens).toBe(closes);
    }
  });

  it('hard-splits a single line that exceeds the limit on its own', () => {
    const parts = chunkMessage('y'.repeat(900), 100);
    expect(parts.length).toBe(9);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
  });

  it('loses no content', () => {
    const text = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n');
    expect(chunkMessage(text, 200).join('\n')).toBe(text);
  });

  it('handles empty and nullish input', () => {
    expect(chunkMessage('')).toEqual(['']);
    expect(chunkMessage(null)).toEqual(['']);
  });
});

describe('a realistic /list payload', () => {
  it('a 40-draft queue exceeds the raw Telegram limit and must be chunked', () => {
    // ~142 chars per draft. This is the case that returned nothing.
    const draft = (i) =>
      `#${i} [pending]\n  Company${i} score=40\n` +
      `  to: founders@company${i}.com [verified] (founder)\n` +
      `  Senior Backend Engineer - Uchenna Bright Ugwumadu\n`;
    const text = '<b>Drafts queue</b>\n\n' + Array.from({ length: 40 }, (_, i) => draft(i)).join('\n');
    expect(text.length).toBeGreaterThan(4096);
    for (const p of chunkMessage(text)) expect(p.length).toBeLessThanOrEqual(3500);
  });
});
