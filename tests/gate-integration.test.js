// tests/gate-integration.test.js
// End-to-end: seed 6 companies covering the failure modes we've actually
// hit in production, run runQualify, and assert exactly one job passes.
// This is the "truth table" the design doc promised.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, upsertJob, jobsByStatus, jobById,
} from '../src/pipeline/db/repo.js';
import { runQualify } from '../src/pipeline/qualify/index.js';
import { parseConfig } from '../src/pipeline/config/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function freshDb() {
  const p = path.join(os.tmpdir(), `gate-int-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

function realConfig() {
  const raw = yaml.load(fs.readFileSync(path.join(ROOT, 'config.example.yaml'), 'utf8'));
  return parseConfig(raw);
}

function isoDaysAgo(d) {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
}

describe('runQualify: priority-gate truth table', () => {
  beforeEach(() => freshDb());

  it('exactly ONE of six carefully-designed jobs survives every gate', async () => {
    const config = realConfig();

    // Case A: fails gate 1 (US only)
    const cA = upsertCompany({ name: 'USOnlyCo', ats: 'greenhouse', slug: 'usonly',
      source: 'seed', hqCountry: 'US', sizeBand: '51-200' });
    upsertJob({
      companyId: cA.id, externalJobId: 'A-1',
      title: 'Senior Backend Engineer',
      locationRaw: 'Remote (US)', remoteScope: 'us_only',
      compRaw: '$150,000 USD',
      descriptionText: 'Node.js. US only. Salary $150k.',
      postedAt: isoDaysAgo(5),
    });

    // Case B: passes gate 1 but fails gate 2 (pay below floor: $1k/mo = $12k/yr)
    const cB = upsertCompany({ name: 'LowPayCo', ats: 'ashby', slug: 'lowpay',
      source: 'seed', hqCountry: 'GB', sizeBand: '11-50' });
    upsertJob({
      companyId: cB.id, externalJobId: 'B-1',
      title: 'Backend Engineer',
      locationRaw: 'Remote - Worldwide', remoteScope: 'worldwide',
      compRaw: '$1,000/month',
      descriptionText: 'Node.js. Compensation: $1,000/month.',
      postedAt: isoDaysAgo(5),
    });

    // Case C: passes 1+2 but fails gate 3 (wrong role: Manager)
    const cC = upsertCompany({ name: 'MgmtCo', ats: 'lever', slug: 'mgmt',
      source: 'seed', hqCountry: 'DE', sizeBand: '51-200' });
    upsertJob({
      companyId: cC.id, externalJobId: 'C-1',
      title: 'Manager, Software Engineering',
      locationRaw: 'Remote Worldwide', remoteScope: 'worldwide',
      compRaw: '$150,000 USD',
      descriptionText: 'Lead a team. Node.js background. Salary $150k.',
      postedAt: isoDaysAgo(5),
    });

    // Case D: passes 1+2+3 but fails gate 4 (too big)
    const cD = upsertCompany({ name: 'BigCo', ats: 'greenhouse', slug: 'bigco',
      source: 'seed', hqCountry: 'US', sizeBand: '1000+' });
    upsertJob({
      companyId: cD.id, externalJobId: 'D-1',
      title: 'Senior Backend Engineer',
      locationRaw: 'Remote Worldwide', remoteScope: 'worldwide',
      compRaw: '$150,000 USD',
      descriptionText: 'Node.js and TypeScript. Salary $150k.',
      postedAt: isoDaysAgo(5),
    });

    // Case E: passes 1..4 but fails gate 6 (stale posting)
    const cE = upsertCompany({ name: 'StaleCo', ats: 'ashby', slug: 'staleco',
      source: 'seed', hqCountry: 'NL', sizeBand: '11-50' });
    upsertJob({
      companyId: cE.id, externalJobId: 'E-1',
      title: 'Backend Engineer',
      locationRaw: 'Remote Worldwide', remoteScope: 'worldwide',
      compRaw: '$120,000 USD',
      descriptionText: 'Node.js and Python. Salary $120k.',
      postedAt: isoDaysAgo(60),   // stale
    });

    // Case F: THE ONLY ONE THAT PASSES. Clears every gate.
    const cF = upsertCompany({ name: 'CleanCo', ats: 'ashby', slug: 'cleanco',
      source: 'seed', hqCountry: 'US', sizeBand: '11-50', nigeriaPresence: true });
    upsertJob({
      companyId: cF.id, externalJobId: 'F-1',
      title: 'Senior Backend Engineer',
      locationRaw: 'Remote Worldwide', remoteScope: 'worldwide',
      compRaw: '$120,000 - $180,000 USD',
      descriptionText: 'Node.js, TypeScript, Python. We hire via Deel worldwide. Salary $120k+.',
      postedAt: isoDaysAgo(3),
    });

    const stats = await runQualify({ config });
    expect(stats.evaluated).toBe(6);
    expect(stats.qualified).toBe(1);

    const qualified = jobsByStatus('qualified');
    expect(qualified.map(j => j.external_job_id)).toEqual(['F-1']);

    const disqualified = jobsByStatus('disqualified');
    const disReasons = disqualified.map(j => ({ id: j.external_job_id, reason: j.disqualify_reason }));

    // Each rejected case fails at exactly the gate the design expects.
    expect(disReasons.find(r => r.id === 'A-1').reason).toMatch(/remote_(denied|scope)/);
    expect(disReasons.find(r => r.id === 'B-1').reason).toContain('pay_below_floor');
    expect(disReasons.find(r => r.id === 'C-1').reason).toBe('title_role_out_of_scope');
    expect(disReasons.find(r => r.id === 'D-1').reason).toContain('company_size_too_large');
    expect(disReasons.find(r => r.id === 'E-1').reason).toContain('posting_stale');
  });
});
