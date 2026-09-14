// tests/migration-009-backfill.test.js
// Migration 009 decides which historical rejections become permanent blocks.
// Production holds dozens of rejected drafts from before this change; getting
// the predicate wrong either resurrects drafts the applicant already said no to,
// or permanently blocks companies that /cleanup and /rejectall only meant to
// clear out for a fresh, current-prompt draft.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { _resetForTests, getDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import { upsertCompany, upsertContact, createDraft, updateDraftStatus, draftById } from '../src/pipeline/db/repo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKFILL = fs.readFileSync(path.join(ROOT, 'migrations', '009_rejection_learning.sql'), 'utf8')
  .match(/UPDATE draft SET redraft_blocked = 1[\s\S]*?;/)[0];

function freshDb() {
  const p = path.join(os.tmpdir(), `m009-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

describe('migration 009 backfill', () => {
  beforeEach(() => freshDb());

  it('blocks applicant rejections and leaves housekeeping rejections re-draftable', () => {
    const c = upsertCompany({ name: 'Acme', ats: 'lever', slug: 'acme', source: 'seed' });
    const ct = upsertContact({ companyId: c.id, fullName: 'A', title: 'CTO', roleType: 'founder',
      email: 'a@acme.io', emailStatus: 'verified', source: 'hunter' });
    const mk = (status, reason) => {
      const d = createDraft({ contactId: ct.id, subject: 's', body: 'b', promptVersion: 'v', hookVerified: true });
      if (status !== 'pending_review') updateDraftStatus(d.id, status, { reason });
      return d.id;
    };

    const expected = new Map([
      [mk('rejected', 'has founders in the email'), 1],               // the live case
      [mk('rejected', 'via telegram'), 1],                            // /reject with no reason
      [mk('rejected', undefined), 1],
      [mk('rejected', 'bulk: old prompt'), 0],                        // /rejectall
      [mk('rejected', 'cleanup: superseded prompt outreach_v2'), 0],  // /cleanup
      [mk('rejected', 'auto: founders@x.com blocked by a learned rule'), 0],
      [mk('rejected', 'replace via telegram'), 0],                    // old /replace default
      [mk('rejected', 'replace: tone is off'), 0],                    // new /replace prefix
      [mk('pending_review', undefined), 0],
    ]);

    getDb().prepare('UPDATE draft SET redraft_blocked = 0').run();
    getDb().exec(BACKFILL);

    for (const [id, want] of expected) {
      const d = draftById(id);
      expect(d.redraft_blocked, `#${id} "${d.reject_reason}" (${d.status})`).toBe(want);
    }
  });
});
