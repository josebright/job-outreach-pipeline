// tests/from-posting.test.js
import { describe, it, expect } from 'vitest';
import { contactsFromPosting, roleTypeFromLocalPart } from '../src/pipeline/enrich/from-posting.js';

describe('contactsFromPosting', () => {
  it('extracts a named email and marks it quality=named', () => {
    const r = contactsFromPosting({
      descriptionText: 'To apply, reach out to Sarah Kim at sarah.kim@acme.io',
      companyDomainHint: 'acme.io',
    });
    expect(r.length).toBe(1);
    expect(r[0].email).toBe('sarah.kim@acme.io');
    expect(r[0].quality).toBe('named');
  });

  it('marks careers@ / jobs@ as generic and sorts them last', () => {
    const r = contactsFromPosting({
      descriptionText: 'Send resume to careers@acme.io. Or contact founder@acme.io directly.',
      companyDomainHint: 'acme.io',
    });
    expect(r[0].email).toBe('founder@acme.io');
    expect(r[0].quality).toBe('named');   // 'founder' is not in generic list (it is a real name/title)
    expect(r[1].quality).toBe('generic');
  });

  it('rejects emails on unrelated domains', () => {
    const r = contactsFromPosting({
      descriptionText: 'We use sentry@sentry.io for errors. Reach the CTO at cto@acme.io',
      companyDomainHint: 'acme.io',
    });
    expect(r.map(x => x.email)).toEqual(['cto@acme.io']);
  });

  it('rejects personal Gmail addresses even without a hint', () => {
    const r = contactsFromPosting({
      descriptionText: 'Contact person@gmail.com and real@acme.io',
    });
    expect(r.map(x => x.email)).toEqual(['real@acme.io']);
  });

  it('returns [] on empty input', () => {
    expect(contactsFromPosting({ descriptionText: '' })).toEqual([]);
  });
});

describe('roleTypeFromLocalPart', () => {
  it('maps founder/ceo/cto to founder', () => {
    expect(roleTypeFromLocalPart('founder')).toBe('founder');
    expect(roleTypeFromLocalPart('ceo')).toBe('founder');
  });
  it('maps vp/head/cto to eng_leader', () => {
    expect(roleTypeFromLocalPart('vp-eng')).toBe('eng_leader');
    expect(roleTypeFromLocalPart('headofeng')).toBe('eng_leader');
  });
  it('maps eng/dev to engineer', () => {
    expect(roleTypeFromLocalPart('engineering')).toBe('engineer');
  });
  it('defaults to recruiter for unknown', () => {
    expect(roleTypeFromLocalPart('sarah')).toBe('recruiter');
  });
});
