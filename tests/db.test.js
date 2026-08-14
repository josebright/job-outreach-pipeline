// tests/db.test.js
// Verifies migrations run cleanly and the repo layer is idempotent.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { _resetForTests, closeDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, upsertJob, companiesByStatus,
  isSuppressed, suppress,
  getSendCount, incrementSendCount,
  isSlugDead, markSlugDead,
} from '../src/pipeline/db/repo.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `pipeline-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
  return p;
}

describe('migrations', () => {
  it('runs cleanly on empty DB and is idempotent', () => {
    freshDb();
    const first = runMigrations();
    expect(first.applied.length).toBe(0);      // already applied by freshDb
    expect(first.skipped.length).toBeGreaterThan(0);
  });
});

describe('company repo', () => {
  beforeEach(() => freshDb());

  it('upsertCompany is idempotent on (ats, slug)', () => {
    const a = upsertCompany({ name: 'Acme', ats: 'greenhouse', slug: 'acme', source: 'seed' });
    const b = upsertCompany({ name: 'Acme', ats: 'greenhouse', slug: 'acme', source: 'seed' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.id).toBe(b.id);
    expect(companiesByStatus('discovered').length).toBe(1);
  });

  it('upsertJob is idempotent on (company_id, external_job_id)', () => {
    const c = upsertCompany({ name: 'Acme', ats: 'greenhouse', slug: 'acme', source: 'seed' });
    const j1 = upsertJob({ companyId: c.id, externalJobId: 'job-1', title: 'Senior Engineer' });
    const j2 = upsertJob({ companyId: c.id, externalJobId: 'job-1', title: 'Senior Engineer (updated)' });
    expect(j1.created).toBe(true);
    expect(j2.created).toBe(false);
    expect(j1.id).toBe(j2.id);
  });
});

describe('suppression list', () => {
  beforeEach(() => freshDb());

  it('is case-insensitive and permanent', () => {
    suppress('Alice@Example.com', 'bounce');
    expect(isSuppressed('alice@example.com')).toBe(true);
    expect(isSuppressed('ALICE@example.com')).toBe(true);
    expect(isSuppressed('bob@example.com')).toBe(false);
  });
});

describe('send counters', () => {
  beforeEach(() => freshDb());

  it('starts at 0 and increments atomically', () => {
    expect(getSendCount('initial')).toBe(0);
    incrementSendCount('initial');
    incrementSendCount('initial');
    incrementSendCount('followup');
    expect(getSendCount('initial')).toBe(2);
    expect(getSendCount('followup')).toBe(1);
  });
});

describe('dead slug graveyard', () => {
  beforeEach(() => freshDb());

  it('marks and detects dead slugs within TTL', () => {
    expect(isSlugDead('greenhouse', 'bogus')).toBe(false);
    markSlugDead('greenhouse', 'bogus', 30);
    expect(isSlugDead('greenhouse', 'bogus')).toBe(true);
  });
});
