// tests/bouncelog.test.js
// /bouncelog lists every bounced outbound in the window, joined to contact +
// company. Reviewer uses it to tell whether bounces are Hunter-verified misses
// (real deliverability failures) or pattern-probed risky guesses that leaked.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests, getDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, upsertContact, createDraft, updateDraftStatus,
} from '../src/pipeline/db/repo.js';
import { handleBouncelog } from '../src/pipeline/bot/handlers.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `bouncelog-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

function seedBounce({ companyName, slug, email, emailStatus, kind = 'initial', daysAgo = 1 }) {
  const co = upsertCompany({ name: companyName, ats: 'greenhouse', slug, source: 'seed' });
  const contact = upsertContact({
    companyId: co.id, fullName: 'A', title: 'CTO', roleType: 'founder',
    email, emailStatus, source: 'hunter',
  });
  const draft = createDraft({
    contactId: contact.id, subject: 's', body: 'b',
    promptVersion: 'outreach_v1', hookVerified: true,
  });
  updateDraftStatus(draft.id, 'approved');
  getDb().prepare(`
    INSERT INTO message (draft_id, direction, kind, sent_at, bounced)
    VALUES (?, 'outbound', ?, datetime('now', ?), 1)
  `).run(draft.id, kind, `-${daysAgo} days`);
}

describe('handleBouncelog', () => {
  beforeEach(() => freshDb());

  it('reports "no bounces" when the window is empty', () => {
    const out = handleBouncelog();
    expect(out).toMatch(/no bounces/i);
  });

  it('lists every bounced message with contact + company + status', () => {
    seedBounce({ companyName: 'Acme', slug: 'acme', email: 'jane@acme.io', emailStatus: 'verified' });
    seedBounce({ companyName: 'BetaCo', slug: 'beta', email: 'cto@beta.com', emailStatus: 'risky' });
    const out = handleBouncelog();
    expect(out).toMatch(/Bounces, last 30d/);
    expect(out).toMatch(/2 total/);
    // Both addresses appear
    expect(out).toContain('jane@acme.io');
    expect(out).toContain('cto@beta.com');
    // Company names appear
    expect(out).toContain('Acme');
    expect(out).toContain('BetaCo');
    // Status mix line lets the reviewer see verified-vs-risky split at a glance
    expect(out).toMatch(/verified=1/);
    expect(out).toMatch(/risky=1/);
  });

  it('respects the days window argument', () => {
    // In-window and out-of-window bounces
    seedBounce({ companyName: 'Recent', slug: 'rec', email: 'a@rec.com', emailStatus: 'verified', daysAgo: 2 });
    seedBounce({ companyName: 'Ancient', slug: 'anc', email: 'b@anc.com', emailStatus: 'risky', daysAgo: 40 });

    // 30d default excludes the 40d-old one
    const out30 = handleBouncelog();
    expect(out30).toContain('a@rec.com');
    expect(out30).not.toContain('b@anc.com');

    // 60d includes both
    const out60 = handleBouncelog('60');
    expect(out60).toContain('a@rec.com');
    expect(out60).toContain('b@anc.com');
  });

  it('clamps a garbage arg to the 1-90 day range', () => {
    seedBounce({ companyName: 'X', slug: 'x', email: 'x@x.com', emailStatus: 'verified' });
    // Non-numeric arg falls back to default 30
    const out = handleBouncelog('nonsense');
    expect(out).toContain('last 30d');
    // Negative/zero clamps up to 1
    const out1 = handleBouncelog('-5');
    expect(out1).toMatch(/last 1d|no bounces/);
    // Huge clamps down to 90
    const out90 = handleBouncelog('9999');
    expect(out90).toContain('last 90d');
  });

  it('does not include inbound messages', () => {
    // Inbound messages should never appear even if their bounced flag is set
    const co = upsertCompany({ name: 'InboundCo', ats: 'greenhouse', slug: 'ib', source: 'seed' });
    const contact = upsertContact({
      companyId: co.id, fullName: 'A', title: 'CTO', roleType: 'founder',
      email: 'ib@ib.com', emailStatus: 'verified', source: 'hunter',
    });
    const draft = createDraft({
      contactId: contact.id, subject: 's', body: 'b',
      promptVersion: 'outreach_v1', hookVerified: true,
    });
    getDb().prepare(`
      INSERT INTO message (draft_id, direction, kind, sent_at, bounced)
      VALUES (?, 'inbound', 'reply', datetime('now'), 1)
    `).run(draft.id);
    const out = handleBouncelog();
    expect(out).toMatch(/no bounces/i);
  });
});
