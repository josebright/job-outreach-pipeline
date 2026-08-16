// tests/roles.test.js
import { describe, it, expect } from 'vitest';
import { isResearchRole } from '../src/pipeline/qualify/roles.js';

describe('isResearchRole', () => {
  it('matches Research Engineer', () => {
    expect(isResearchRole('Research Engineer')).toBe(true);
  });
  it('matches Applied Research Engineer', () => {
    expect(isResearchRole('Applied Research Engineer')).toBe(true);
  });
  it('matches Research Software Engineer', () => {
    expect(isResearchRole('Senior Research Software Engineer')).toBe(true);
  });
  it('matches ML Research Engineer', () => {
    expect(isResearchRole('ML Research Engineer')).toBe(true);
  });
  it('does not match plain Software Engineer', () => {
    expect(isResearchRole('Senior Software Engineer')).toBe(false);
  });
  it('does not match Backend Engineer', () => {
    expect(isResearchRole('Backend Engineer')).toBe(false);
  });
  it('handles null/empty', () => {
    expect(isResearchRole(null)).toBe(false);
    expect(isResearchRole('')).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(isResearchRole('research engineer')).toBe(true);
    expect(isResearchRole('RESEARCH ENGINEER')).toBe(true);
  });
});
