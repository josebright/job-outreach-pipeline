// tests/followups-disabled.test.js
// Follow-ups are off by default. Two defects made them actively harmful:
// followup_2 eligibility never checked that followup_1 had been sent (only
// that the INITIAL was 10+ days old), so a backlog matched both queries in
// one pass and a recipient got two follow-ups 60 seconds apart; and the
// canned bodies pitched contractor/Deel onboarding, which the draft prompt
// bans outright for the initial email.
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { _resetForTests, getDb } from '../src/pipeline/db/connection.js';
import { runMigrations } from '../src/pipeline/db/migrate.js';
import {
  upsertCompany, upsertContact, createDraft, updateDraftStatus,
} from '../src/pipeline/db/repo.js';
import { runSend } from '../src/pipeline/send/index.js';
import { draftsDueForFollowup } from '../src/pipeline/send/follow-up.js';

function freshDb() {
  const p = path.join(os.tmpdir(), `fu-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.PIPELINE_DB_PATH = p;
  _resetForTests(p);
  runMigrations();
}

function baseConfig(overrides = {}) {
  return {
    send: {
      sender_email: 'me@x.org', sender_name: 'Me', reply_to: null,
      daily_cap_initial: 15, daily_cap_followup: 15, research_daily_cap: 0,
      ...overrides,
    },
    enrichment: {},
  };
}

// A draft whose initial went out `days` ago with no reply and no follow-ups.
function seedSentDraft(days) {
  const c = upsertCompany({
    name: 'Acme', ats: 'lever', slug: `acme-${Math.random().toString(36).slice(2)}`, source: 'seed',
  });
  const ct = upsertContact({
    companyId: c.id, fullName: 'Jakob F', title: 'CTO', roleType: 'founder',
    email: `j${Math.random().toString(36).slice(2)}@acme.io`, emailStatus: 'verified', source: 'hunter',
  });
  const d = createDraft({ contactId: ct.id, subject: 's', body: 'b', promptVersion: 'v3', hookVerified: true });
  updateDraftStatus(d.id, 'sent');
  getDb().prepare(`
    INSERT INTO message (draft_id, direction, kind, sent_at, thread_id, message_id)
    VALUES (?, 'outbound', 'initial', datetime('now', ?), 't', 'm@x')
  `).run(d.id, `-${days} days`);
  return d.id;
}

describe('follow-ups disabled by default', () => {
  beforeEach(() => freshDb());

  it('sends no follow-ups when followups_enabled is false', async () => {
    seedSentDraft(20);
    const stats = await runSend({ config: baseConfig({ followups_enabled: false }) });
    expect(stats.followup1Sent).toBe(0);
    expect(stats.followup2Sent).toBe(0);
  });

  it('sends none when the flag is simply absent', async () => {
    seedSentDraft(20);
    const stats = await runSend({ config: baseConfig() });
    expect(stats.followup1Sent).toBe(0);
    expect(stats.followup2Sent).toBe(0);
  });

  it('writes no outbound follow-up message rows', async () => {
    seedSentDraft(20);
    await runSend({ config: baseConfig({ followups_enabled: false }) });
    const n = getDb().prepare(
      `SELECT COUNT(*) AS n FROM message WHERE kind IN ('followup_1','followup_2')`
    ).get().n;
    expect(n).toBe(0);
  });
});

describe('the follow-up sequencing defect this protects against', () => {
  beforeEach(() => freshDb());

  it('documents that one old initial matches BOTH follow-up queries at once', () => {
    // 20 days old, no follow-ups sent yet. followup_2 eligibility only tests
    // the initial's age, never whether followup_1 went out - so both fire in
    // the same pass. This is why Jakob received "Just bumping this up" and
    // "Closing the loop on my earlier note" a minute apart.
    const id = seedSentDraft(20);
    expect(draftsDueForFollowup('followup_1').map(d => d.id)).toContain(id);
    expect(draftsDueForFollowup('followup_2').map(d => d.id)).toContain(id);
  });
});
