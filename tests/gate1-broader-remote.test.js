// tests/gate1-broader-remote.test.js
// Covers the 2026 remote-signal vocabulary extensions. Previously
// bare "Remote" in location passed but the more common ATS phrasings
// ("remote-first", "distributed team", "work from anywhere",
// "async-first") bled 89% of qualified jobs into needs_review.
import { describe, it, expect } from 'vitest';
import { gate1_remoteFromNigeria } from '../src/pipeline/qualify/filters.js';
import { classifyWorkplace, classifyRemoteScope } from '../src/pipeline/ingest/ats/classify.js';

const config = {
  location: {
    allow: ['worldwide', 'anywhere', 'emea', 'africa', 'global', 'fully remote'],
    deny: ['us only', 'united states only', 'eu citizens only', 'remote (us)'],
  },
};

describe('gate1 broader remote-signal vocabulary', () => {
  const passes = [
    ['Berlin, Germany', 'We are a remote-first company hiring globally.'],
    ['New York', 'Distributed team, work from anywhere in the world.'],
    ['United States', 'We are fully remote and async-first.'],
    ['San Francisco', 'Remote-friendly role, hire globally with flexible hours.'],
    ['', 'Globally distributed engineering team across 15 countries.'],
    ['Toronto', 'This is a remote position; we hire anywhere.'],
    ['Warsaw', "We're remote and hire anywhere in the world."],
    ['Lisbon', 'This role is 100% remote across EU-friendly timezones.'],
  ];
  for (const [loc, desc] of passes) {
    it(`PASSES loc="${loc.slice(0,20)}" desc contains 2026 remote signal`, () => {
      const r = gate1_remoteFromNigeria(
        { location_raw: loc, description_text: desc, remote_scope: 'unknown', workplace_type: 'unknown' },
        config,
      );
      expect(r.pass).toBe(true);
    });
  }

  it('still needs_review for genuinely-onsite roles with no remote signal', () => {
    const r = gate1_remoteFromNigeria(
      { location_raw: 'Berlin', description_text: 'In-office 5 days/week, downtown Berlin office.', remote_scope: 'onsite', workplace_type: 'onsite' },
      config,
    );
    expect(r.pass).toBe(false);
  });

  it('still fails when a US-only signal is present alongside "remote-first"', () => {
    const r = gate1_remoteFromNigeria(
      { location_raw: 'Remote', description_text: 'We are remote-first but US only.', remote_scope: 'unknown', workplace_type: 'remote' },
      config,
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/remote_denied/);
  });
});

describe('classifyWorkplace broader vocabulary', () => {
  const remoteTexts = [
    'Remote-first team.',
    'We are a distributed team.',
    'Work from anywhere in the world.',
    'Async-first, no meetings before noon.',
    '100% remote.',
    'This is a remote position.',
    "We're remote and hire globally.",
    'Globally distributed engineering.',
  ];
  for (const t of remoteTexts) {
    it(`classifies "${t.slice(0,40)}..." as remote`, () => {
      expect(classifyWorkplace('New York', t)).toBe('remote');
    });
  }

  it('still classifies hybrid roles as hybrid', () => {
    expect(classifyWorkplace('Berlin', 'Hybrid: 3 days in-office.')).toBe('hybrid');
  });

  it('classifies genuine onsite roles as onsite', () => {
    expect(classifyWorkplace('Berlin', 'In-office team, downtown Berlin.')).toBe('onsite');
  });
});

describe('classifyRemoteScope expanded us_only detection', () => {
  it('catches "US based only"', () => {
    expect(classifyRemoteScope('Remote', 'This role is US based only.')).toBe('us_only');
  });
  it('catches "US citizens only"', () => {
    expect(classifyRemoteScope('Remote', 'Must be US citizens only.')).toBe('us_only');
  });
  it('catches "must reside in the US"', () => {
    expect(classifyRemoteScope('Remote', 'You must reside in the US to apply.')).toBe('us_only');
  });
  it('catches "hire globally" as worldwide', () => {
    expect(classifyRemoteScope('Remote', 'We hire globally at senior levels.')).toBe('worldwide');
  });
  it('catches "any timezone" as worldwide', () => {
    expect(classifyRemoteScope('Remote', 'Any timezone welcome, async-first.')).toBe('worldwide');
  });
});
