// tests/hook-evidence.test.js
// Anti-hallucination check for LLM drafts. Per PRD Module 5.
import { describe, it, expect } from 'vitest';
import { verifyHookEvidence } from '../src/pipeline/draft/index.js';

describe('verifyHookEvidence', () => {
  const posting = `
    About the role
    We are hiring a senior backend engineer to help scale our
    payments   infrastructure   across Latin America and Africa.
    Stack: Node, TypeScript, PostgreSQL, Kafka.
  `;

  it('accepts a verbatim quote', () => {
    expect(verifyHookEvidence({
      hookEvidence: 'scale our payments infrastructure across Latin America and Africa',
      sourceText: posting,
    })).toBe(true);
  });

  it('tolerates whitespace differences', () => {
    expect(verifyHookEvidence({
      hookEvidence: 'scale our\tpayments  infrastructure',
      sourceText: posting,
    })).toBe(true);
  });

  it('rejects hallucinated content', () => {
    expect(verifyHookEvidence({
      hookEvidence: 'building AI copilots for enterprise customers',
      sourceText: posting,
    })).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(verifyHookEvidence({ hookEvidence: '', sourceText: posting })).toBe(false);
    expect(verifyHookEvidence({ hookEvidence: 'x', sourceText: '' })).toBe(false);
  });
});
