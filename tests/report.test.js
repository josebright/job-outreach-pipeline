// tests/report.test.js
// Report shape + funnel math. Uses in-memory-seeded rows only.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, setCompanyStatus, upsertJob, setJobQualifyResult,
  upsertContact, createDraft, updateDraftStatus,
} from '../src/pipeline/db/repo.js';
import { runReport } from '../src/pipeline/report/index.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `report-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

describe('runReport', () => {
  beforeEach(() => freshDb());

  it('returns a well-formed summary on an empty DB', async () => {
    const s = await runReport();
    expect(s.totals.companies_total).toBe(0);
    expect(s.funnel.discovered_to_qualified_pct).toBe(0);
    expect(Array.isArray(s.byScoreBand)).toBe(true);
    expect(Array.isArray(s.bySource)).toBe(true);
  });

  it('computes funnel percentages when there is data', async () => {
    const c = upsertCompany({ name: 'Acme', ats: 'greenhouse', slug: 'acme', source: 'seed', sizeBand: '51-200' });
    setCompanyStatus(c.id, 'qualified');
    const j = upsertJob({ companyId: c.id, externalJobId: 'A1', title: 'Senior Backend', descriptionText: 'x' });
    setJobQualifyResult(j.id, { status: 'qualified', score: 65 });
    const contact = upsertContact({
      companyId: c.id, fullName: 'A', title: 'CTO', roleType: 'founder',
      email: 'a@acme.io', emailStatus: 'verified', source: 'hunter',
    });
    const d = createDraft({
      contactId: contact.id, subject: 's', body: 'b',
      promptVersion: 'outreach_v1', hookVerified: true,
    });
    updateDraftStatus(d.id, 'approved');
    updateDraftStatus(d.id, 'sent');

    const s = await runReport();
    expect(s.totals.companies_qualified).toBe(1);
    expect(s.totals.jobs_qualified).toBe(1);
    expect(s.totals.drafts_sent).toBe(1);
    expect(s.byScoreBand.find(b => b.band === '60-79').n).toBe(1);
    expect(s.byCompanySize.find(b => b.size_band === '51-200').n).toBe(1);
    expect(s.bySource.find(b => b.source === 'seed').qualified).toBe(1);
  });
});
