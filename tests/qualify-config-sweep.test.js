// tests/qualify-config-sweep.test.js
// 'disqualified' used to be a terminal state, so lowering scoring.threshold
// or widening stack.keywords only ever affected newly-ingested jobs — the
// ~1,100 jobs the old threshold had already killed stayed dead. A config
// fingerprint now triggers one re-evaluation sweep over those rows.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import { upsertCompany, upsertJob, jobById, getState } from '../src/pipeline/db/repo.js';
import { runQualify, qualifyFingerprint } from '../src/pipeline/qualify/index.js';
import { parseConfig } from '../src/pipeline/config/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function freshDb() {
  const p = path.join(os.tmpdir(), `sweep-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}
function baseConfig() {
  return parseConfig(yaml.load(fs.readFileSync(path.join(ROOT, 'config.example.yaml'), 'utf8')));
}
const isoDaysAgo = d => new Date(Date.now() - d * 864e5).toISOString();

describe('qualifyFingerprint', () => {
  it('is stable across runs for identical config', () => {
    expect(qualifyFingerprint(baseConfig())).toBe(qualifyFingerprint(baseConfig()));
  });

  it('is insensitive to key ordering', () => {
    const a = baseConfig();
    const b = baseConfig();
    b.scoring = Object.fromEntries(Object.entries(b.scoring).reverse());
    expect(qualifyFingerprint(a)).toBe(qualifyFingerprint(b));
  });

  it('changes when the score threshold changes', () => {
    const a = baseConfig();
    const b = baseConfig();
    b.scoring.threshold = a.scoring.threshold + 5;
    expect(qualifyFingerprint(a)).not.toBe(qualifyFingerprint(b));
  });

  it('changes when a stack keyword is added', () => {
    const a = baseConfig();
    const b = baseConfig();
    b.stack.keywords = [...b.stack.keywords, 'founding engineer'];
    expect(qualifyFingerprint(a)).not.toBe(qualifyFingerprint(b));
  });

  it('changes when a location deny entry is added', () => {
    const a = baseConfig();
    const b = baseConfig();
    b.location.deny = [...b.location.deny, 'mars only'];
    expect(qualifyFingerprint(a)).not.toBe(qualifyFingerprint(b));
  });
});

describe('disqualified re-sweep on config change', () => {
  beforeEach(() => freshDb());

  // A job good enough to pass every gate but score below 40 — exactly the
  // low_score:25 shape that dominated the live gate-kill breakdown.
  function seedLowScoreJob() {
    const c = upsertCompany({
      name: 'Acme', ats: 'greenhouse', slug: 'acme', source: 'seed', hqCountry: 'US',
    });
    upsertJob({
      companyId: c.id, externalJobId: 'a1',
      title: 'Senior Backend Engineer',
      locationRaw: 'Remote', remoteScope: 'worldwide', workplaceType: 'remote',
      descriptionText: 'Node.js and Python.',
      postedAt: isoDaysAgo(1),
    });
  }

  it('kills the job under a high threshold, then rescues it when lowered', async () => {
    seedLowScoreJob();

    const strict = baseConfig();
    strict.scoring.threshold = 40;
    const s1 = await runQualify({ config: strict });
    expect(s1.qualified).toBe(0);
    expect(jobById(1).status).toBe('disqualified');
    expect(jobById(1).disqualify_reason).toMatch(/^low_score:/);

    // Same config again: the dead row must NOT be re-evaluated.
    const s2 = await runQualify({ config: strict });
    expect(s2.configChanged).toBe(false);
    expect(s2.evaluated).toBe(0);

    // Lower the threshold — the fingerprint changes and the sweep runs.
    const loose = baseConfig();
    loose.scoring.threshold = 20;
    const s3 = await runQualify({ config: loose });
    expect(s3.configChanged).toBe(true);
    expect(s3.rescued).toBe(1);
    expect(jobById(1).status).toBe('qualified');
  });

  it('sweeps only once — the pass after the change is cheap again', async () => {
    seedLowScoreJob();
    const strict = baseConfig();
    strict.scoring.threshold = 40;
    await runQualify({ config: strict });

    const loose = baseConfig();
    loose.scoring.threshold = 20;
    await runQualify({ config: loose });
    const again = await runQualify({ config: loose });
    expect(again.configChanged).toBe(false);
    expect(again.rescued).toBe(0);
  });

  it('records the fingerprint so the sweep is not repeated', async () => {
    seedLowScoreJob();
    const cfg = baseConfig();
    await runQualify({ config: cfg });
    expect(getState('qualify_config_fingerprint')).toBe(qualifyFingerprint(cfg));
  });

  it('leaves genuinely-bad jobs disqualified after the sweep', async () => {
    const c = upsertCompany({ name: 'Beta', ats: 'lever', slug: 'beta', source: 'seed' });
    upsertJob({
      companyId: c.id, externalJobId: 'b1',
      title: 'Director of Marketing',
      locationRaw: 'Remote', remoteScope: 'worldwide',
      descriptionText: 'Brand strategy.', postedAt: isoDaysAgo(1),
    });
    const strict = baseConfig(); strict.scoring.threshold = 40;
    await runQualify({ config: strict });
    expect(jobById(1).status).toBe('disqualified');

    const loose = baseConfig(); loose.scoring.threshold = 20;
    const s = await runQualify({ config: loose });
    expect(s.configChanged).toBe(true);
    expect(s.rescued).toBe(0);
    expect(jobById(1).status).toBe('disqualified');
  });
});
