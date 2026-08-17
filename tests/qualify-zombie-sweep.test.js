// tests/qualify-zombie-sweep.test.js
// A company can end up stuck at status='qualified' but with all its
// jobs in status='disqualified' when gate rules tighten mid-run. Those
// zombies pollute /diag and waste enrich cycles. On every qualify pass,
// sweep all 'qualified' companies and demote any with no live jobs.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, setCompanyStatus, upsertJob, setJobQualifyResult, companyById,
} from '../src/pipeline/db/repo.js';
import { runQualify } from '../src/pipeline/qualify/index.js';
import { parseConfig } from '../src/pipeline/config/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function freshDb() {
  const p = path.join(os.tmpdir(), `zombie-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

function realConfig() {
  return parseConfig(yaml.load(fs.readFileSync(path.join(ROOT, 'config.example.yaml'), 'utf8')));
}

describe('qualify: zombie sweep', () => {
  beforeEach(() => freshDb());

  it('demotes a "qualified" company whose jobs are all already disqualified and untouched this pass', async () => {
    // Simulate a company that got promoted before Q6 tightening. Its
    // one job is already status='disqualified' (won't be re-evaluated
    // because qualify targets ingested/needs_review/qualified only —
    // NOT disqualified). So touchedCompanies stays empty for this co.
    const zombie = upsertCompany({
      name: 'Affirm', ats: 'greenhouse', slug: 'affirm',
      source: 'seed', hqCountry: 'US', sizeBand: '1000+',
    });
    setCompanyStatus(zombie.id, 'qualified');
    const job = upsertJob({
      companyId: zombie.id, externalJobId: 'AF1',
      title: 'Senior Backend Engineer',
      locationRaw: 'Remote', remoteScope: 'worldwide',
      compRaw: '$150,000 USD',
      descriptionText: 'Node.js. Salary $150k.',
      postedAt: new Date().toISOString(),
    });
    // Pre-mark the job as disqualified — as if a prior tightening ran.
    setJobQualifyResult(job.id, {
      status: 'disqualified', score: 0, disqualifyReason: 'company_size_too_large:1000+',
    });

    const config = realConfig();
    const stats = await runQualify({ config });

    // The disqualified job is NOT re-evaluated (not in targets), yet
    // the sweep should still demote the company.
    expect(stats.zombiesDemoted).toBe(1);
    const after = companyById(zombie.id);
    expect(after.status).toBe('ingested');
  });

  it('does NOT demote a healthy qualified company whose jobs are still qualified', async () => {
    const healthy = upsertCompany({
      name: 'PostHog', ats: 'ashby', slug: 'posthog',
      source: 'seed', hqCountry: 'GB', sizeBand: '51-200', nigeriaPresence: true,
    });
    setCompanyStatus(healthy.id, 'qualified');
    const job = upsertJob({
      companyId: healthy.id, externalJobId: 'PH1',
      title: 'Senior Backend Engineer',
      locationRaw: 'Remote Worldwide', remoteScope: 'worldwide',
      compRaw: '$130,000 USD',
      descriptionText: 'Node.js, TypeScript, Python. Salary $130k. We hire via Deel worldwide.',
      postedAt: new Date().toISOString(),
    });
    setJobQualifyResult(job.id, { status: 'qualified', score: 60 });

    const config = realConfig();
    const stats = await runQualify({ config });

    expect(stats.zombiesDemoted).toBeFalsy();
    expect(companyById(healthy.id).status).toBe('qualified');
  });
});
