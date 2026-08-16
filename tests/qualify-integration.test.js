// tests/qualify-integration.test.js
// End-to-end: seed a few companies + jobs, run qualify, verify statuses.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, upsertJob, jobsByStatus, jobById, companyById,
} from '../src/pipeline/db/repo.js';
import { runQualify } from '../src/pipeline/qualify/index.js';
import { parseConfig } from '../src/pipeline/config/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function freshDb() {
  const p = path.join(os.tmpdir(), `qualify-int-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

describe('runQualify: end-to-end', () => {
  beforeEach(() => freshDb());

  it('qualifies a strong senior remote worldwide role, disqualifies a US-only junior role', () => {
    const config = realConfig();

    const c1 = upsertCompany({
      name: 'Acme', ats: 'greenhouse', slug: 'acme',
      source: 'seed', hqCountry: 'US', sizeBand: '51-200', nigeriaPresence: true,
    });
    const c2 = upsertCompany({
      name: 'Beta', ats: 'greenhouse', slug: 'beta',
      source: 'seed', hqCountry: 'US', sizeBand: '10000+',
    });

    upsertJob({
      companyId: c1.id, externalJobId: 'A-1',
      title: 'Senior Backend Engineer',
      locationRaw: 'Remote (Worldwide)',
      remoteScope: 'worldwide',
      workplaceType: 'remote',
      currencySignal: 'USD',
      compRaw: '$150,000 - $200,000 USD',
      descriptionText: 'Node.js, TypeScript, Python. We hire via Deel worldwide. Salary $150k.',
      postedAt: isoDaysAgo(2),
    });

    upsertJob({
      companyId: c2.id, externalJobId: 'B-1',
      title: 'Junior Software Engineer',
      locationRaw: 'Remote (US)',
      remoteScope: 'us_only',
      workplaceType: 'remote',
      currencySignal: 'USD',
      descriptionText: 'Node.js entry-level role, US only.',
      postedAt: isoDaysAgo(3),
    });

    return runQualify({ config }).then(stats => {
      expect(stats.evaluated).toBe(2);
      expect(stats.qualified).toBe(1);
      expect(stats.disqualified).toBe(1);

      const qualified = jobsByStatus('qualified');
      const disqualified = jobsByStatus('disqualified');
      expect(qualified.map(j => j.external_job_id)).toEqual(['A-1']);
      expect(disqualified.map(j => j.external_job_id)).toEqual(['B-1']);

      // Company promoted to 'qualified' with score reflecting the top job.
      const company = companyById(c1.id);
      expect(company.status).toBe('qualified');
      expect(company.score).toBeGreaterThanOrEqual(40);
    });
  });

  it('marks ambiguous location as needs_review, not disqualified', () => {
    const config = realConfig();
    const c = upsertCompany({
      name: 'Gamma', ats: 'lever', slug: 'gamma',
      source: 'seed', hqCountry: 'US',
    });
    upsertJob({
      companyId: c.id, externalJobId: 'G-1',
      title: 'Senior Backend Engineer',
      locationRaw: 'Remote',                // ambiguous
      remoteScope: 'unknown',
      currencySignal: 'USD',
      descriptionText: 'Node.js and Python.',
      postedAt: isoDaysAgo(1),
    });

    return runQualify({ config }).then(stats => {
      expect(stats.needsReview).toBe(1);
      const job = jobById(1);
      expect(job.status).toBe('needs_review');
      expect(job.disqualify_reason).toBe('location_ambiguous');
    });
  });

  it('re-qualifies already-qualified jobs on subsequent passes so filter changes take retroactive effect', () => {
    const config = realConfig();
    const c = upsertCompany({
      name: 'Delta', ats: 'greenhouse', slug: 'delta',
      source: 'seed', hqCountry: 'GB', sizeBand: '51-200', nigeriaPresence: true,
    });
    upsertJob({
      companyId: c.id, externalJobId: 'D-1',
      title: 'Staff Backend Engineer',
      locationRaw: 'Remote - Worldwide',
      remoteScope: 'worldwide',
      currencySignal: 'GBP',
      compRaw: '£120k-£160k',
      descriptionText: 'Node.js, TypeScript, Python, React. Salary £120k.',
      postedAt: isoDaysAgo(4),
    });

    return runQualify({ config }).then(first => {
      return runQualify({ config }).then(second => {
        expect(first.qualified).toBe(1);
        // Second pass re-evaluates the already-qualified job (still passes)
        // so filter tweaks propagate retroactively. Idempotent by outcome,
        // not by work count.
        expect(second.evaluated).toBe(1);
        expect(second.qualified).toBe(1);
        const job = jobById(1);
        expect(job.status).toBe('qualified');
      });
    });
  });
});
