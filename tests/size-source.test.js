// tests/size-source.test.js
// Coverage for the size_band_source trust ladder + /setsize command.
// Prevents the Affirm/Algolia regression where a wrong Hunter-cached
// size prevented draft-time re-verification.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests, getDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, updateCompanyEnrichment, setCompanySizeManual, companyBySlug,
} from '../src/pipeline/db/repo.js';
import { handleSetSize } from '../src/pipeline/bot/handlers.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `sizesrc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

describe('size_band_source tracking', () => {
  beforeEach(() => freshDb());

  it('upsertCompany with source=seed and a sizeBand marks size_band_source=seed', () => {
    upsertCompany({
      name: 'PostHog', ats: 'ashby', slug: 'posthog',
      source: 'seed', sizeBand: '51-200',
    });
    const c = companyBySlug('posthog');
    expect(c.size_band).toBe('51-200');
    expect(c.size_band_source).toBe('seed');
  });

  it('seed re-import OVERWRITES a Hunter-guessed size (seed always wins)', () => {
    // Simulate: Hunter cached a wrong "201-500" for Neon
    upsertCompany({
      name: 'Neon', ats: 'ashby', slug: 'neon', source: 'dork',
    });
    const c1 = companyBySlug('neon');
    updateCompanyEnrichment(c1.id, { sizeBand: '201-500', sizeBandSource: 'hunter' });
    expect(companyBySlug('neon').size_band).toBe('201-500');

    // Now the seed CSV re-imports Neon with the correct 51-200 band
    upsertCompany({
      name: 'Neon', ats: 'ashby', slug: 'neon',
      source: 'seed', sizeBand: '51-200',
    });
    const c2 = companyBySlug('neon');
    expect(c2.size_band).toBe('51-200');
    expect(c2.size_band_source).toBe('seed');
  });

  it('updateCompanyEnrichment does NOT overwrite an existing size by default', () => {
    upsertCompany({
      name: 'Convex', ats: 'ashby', slug: 'convex',
      source: 'seed', sizeBand: '11-50',
    });
    // Hunter later thinks Convex is bigger — should be ignored.
    updateCompanyEnrichment(companyBySlug('convex').id, {
      sizeBand: '201-500', sizeBandSource: 'hunter',
    });
    expect(companyBySlug('convex').size_band).toBe('11-50');
    expect(companyBySlug('convex').size_band_source).toBe('seed');
  });

  it('updateCompanyEnrichment with overwriteSize=true DOES overwrite (draft re-verify path)', () => {
    upsertCompany({
      name: 'Affirm', ats: 'greenhouse', slug: 'affirm', source: 'dork',
    });
    updateCompanyEnrichment(companyBySlug('affirm').id, {
      sizeBand: '201-500', sizeBandSource: 'hunter',
    });
    // Draft-time re-verify: Hunter now returns 1000+
    updateCompanyEnrichment(companyBySlug('affirm').id, {
      sizeBand: '1000+', sizeBandSource: 'hunter', overwriteSize: true,
    });
    expect(companyBySlug('affirm').size_band).toBe('1000+');
    expect(companyBySlug('affirm').size_band_source).toBe('hunter');
  });

  it('setCompanySizeManual always overwrites and marks source=manual', () => {
    upsertCompany({
      name: 'Algolia', ats: 'greenhouse', slug: 'algolia', source: 'dork',
    });
    updateCompanyEnrichment(companyBySlug('algolia').id, {
      sizeBand: '201-500', sizeBandSource: 'hunter',
    });
    setCompanySizeManual(companyBySlug('algolia').id, '501-1000');
    const c = companyBySlug('algolia');
    expect(c.size_band).toBe('501-1000');
    expect(c.size_band_source).toBe('manual');
  });
});

describe('handleSetSize (Telegram /setsize command)', () => {
  beforeEach(() => freshDb());

  it('rejects a missing arg with usage hint', () => {
    const out = handleSetSize('', '');
    expect(out).toMatch(/Usage:/);
  });

  it('rejects an unknown band value', () => {
    upsertCompany({ name: 'X', ats: 'greenhouse', slug: 'x', source: 'dork' });
    const out = handleSetSize('x', 'huge');
    expect(out).toMatch(/Unknown band/);
  });

  it('accepts a valid band and marks the size as manual', () => {
    upsertCompany({ name: 'Affirm', ats: 'greenhouse', slug: 'affirm', source: 'dork' });
    const out = handleSetSize('affirm', '1000+');
    expect(out).toMatch(/Set Affirm size to <b>1000\+<\/b>/);
    const c = companyBySlug('affirm');
    expect(c.size_band).toBe('1000+');
    expect(c.size_band_source).toBe('manual');
  });

  it('errors when the slug does not exist', () => {
    const out = handleSetSize('nonexistent', '11-50');
    expect(out).toMatch(/No company with slug/);
  });
});
