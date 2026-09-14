// tests/rejection-rules.test.js
// The classifier that turns a /reject reason into lasting effects. Before it,
// "has founders in the email" changed nothing and the same draft came back on
// the next run.
import { describe, it, expect } from 'vitest';
import {
  classifyRejectReason, aliasFamilyOf, isAddressBlocked, describeFamily,
} from '../src/pipeline/draft/rejection-rules.js';

describe('classifyRejectReason', () => {
  it('learns the founders family from the exact reason the applicant typed', () => {
    const c = classifyRejectReason('has founders in the email', { email: 'founders@nango.com' });
    expect(c.aliasFamilies).toEqual(['founders']);
    expect(c).toMatchObject({ contact: true, company: false, job: false, recognized: true });
  });

  it('treats singular and plural aliases as one family', () => {
    expect(aliasFamilyOf('founder@acme.io')).toBe('founders');
    expect(aliasFamilyOf('founders@acme.io')).toBe('founders');
    expect(describeFamily('founders')).toBe('founders@ / founder@');
  });

  it('learns an alias named next to an address word, whoever the recipient was', () => {
    const c = classifyRejectReason('no hello@ emails please', { email: 'founders@acme.io' });
    expect(c.aliasFamilies).toContain('hello');
  });

  it('does not learn an ambiguous word from a recipient match alone', () => {
    // "wrong job" rejecting a jobs@ draft is about the role, not the inbox.
    const c = classifyRejectReason('wrong job', { email: 'jobs@acme.io' });
    expect(c.aliasFamilies).toEqual([]);
    expect(c.job).toBe(true);
  });

  it('blocks every role alias when the complaint is about generic addresses', () => {
    const c = classifyRejectReason('generic email, want a real person', { email: 'hello@acme.io' });
    expect(c.allRoleAliases).toBe(true);
    expect(c.contact).toBe(true);
  });

  it('does not read "generic copy" as an address complaint', () => {
    const c = classifyRejectReason('generic copy', { email: 'founders@acme.io' });
    expect(c.allRoleAliases).toBe(false);
    expect(c.aliasFamilies).toEqual([]);
    expect(c.wording).toBe(true);
  });

  it('keeps every company-suppression reason the old regex handled', () => {
    for (const r of ['too big for our tier', 'too large', 'wrong industry', 'US only', 'not remote']) {
      expect(classifyRejectReason(r).company, r).toBe(true);
    }
  });

  it('recognizes role-level reasons', () => {
    for (const r of ['wrong role', 'not a backend role', 'too junior', 'php only', 'position filled']) {
      expect(classifyRejectReason(r).job, r).toBe(true);
    }
  });

  it('treats a wording complaint as wording only', () => {
    expect(classifyRejectReason('body is off')).toMatchObject({
      company: false, job: false, contact: false, wording: true,
    });
  });

  it('recognizes a wrong-person reason without learning an alias', () => {
    const c = classifyRejectReason('wrong person, she left the company', { email: 'jane@acme.io' });
    expect(c.contact).toBe(true);
    expect(c.aliasFamilies).toEqual([]);
    expect(c.allRoleAliases).toBe(false);
  });

  it('admits when it cannot tell what was wrong', () => {
    expect(classifyRejectReason('meh').recognized).toBe(false);
    expect(classifyRejectReason('').recognized).toBe(false);
  });
});

describe('isAddressBlocked', () => {
  const founders = { families: new Set(['founders']), allRoleAliases: false };

  it('blocks every member of a learned family, on any domain', () => {
    expect(isAddressBlocked('founders@nango.com', founders)).toBe(true);
    expect(isAddressBlocked('founder@acme.io', founders)).toBe(true);
    expect(isAddressBlocked('founders@jobs.dropbox.com', founders)).toBe(true);
  });

  it('leaves named people and other aliases alone', () => {
    expect(isAddressBlocked('jane.doe@nango.com', founders)).toBe(false);
    expect(isAddressBlocked('hello@nango.com', founders)).toBe(false);
  });

  it('blocks all aliases, but no named person, under the all-aliases rule', () => {
    const all = { families: new Set(), allRoleAliases: true };
    expect(isAddressBlocked('hello@acme.io', all)).toBe(true);
    expect(isAddressBlocked('careers@acme.io', all)).toBe(true);
    expect(isAddressBlocked('jane@acme.io', all)).toBe(false);
  });

  it('covers every local part the enrich pattern probe generates', () => {
    for (const p of ['founders', 'founder', 'ceo', 'cto', 'hello', 'team', 'hr', 'hiring', 'talent', 'careers', 'jobs']) {
      expect(aliasFamilyOf(`${p}@acme.io`), p).not.toBeNull();
    }
  });
});
