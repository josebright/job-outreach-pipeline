-- 009_rejection_learning.sql
-- A rejection is a decision, not a suggestion. Before this, rejecting a draft
-- had no durable effect unless the reason happened to match the company
-- suppression regex, so the next /run regenerated the same draft to the same
-- address for the same role (#124 came back as #126, #125 as #127).

-- 1. The exact (contact, job) pair of an applicant rejection is never
--    auto-drafted again. Housekeeping rejections (bulk:, cleanup:, auto:,
--    replace) leave this 0 so those companies can receive a fresh draft.
ALTER TABLE draft ADD COLUMN redraft_blocked INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_draft_redraft ON draft (contact_id, job_id, redraft_blocked);

-- Backfill: every rejection the applicant typed counts as a decision.
UPDATE draft SET redraft_blocked = 1
WHERE status = 'rejected'
  AND COALESCE(reject_reason, '') NOT LIKE 'bulk:%'
  AND COALESCE(reject_reason, '') NOT LIKE 'cleanup:%'
  AND COALESCE(reject_reason, '') NOT LIKE 'auto:%'
  AND COALESCE(reject_reason, '') NOT LIKE 'replace%';

-- 2. Rules learned from rejection reasons, so "has founders in the email"
--    stops every founders@ address rather than one draft.
CREATE TABLE IF NOT EXISTS rejection_rule (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,   -- local_part | all_role_aliases | company | job
  value           TEXT NOT NULL,   -- alias family, company id, or job id
  reason          TEXT,            -- the applicant's own words
  source_draft_id INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, value)
);

-- 3. Enrich cooldown. Enrich skipped any company with a contact row, including
--    an invalidated one, so a company whose only address was rejected could
--    never get a new one. It now retries, at most once a week per company.
ALTER TABLE company ADD COLUMN last_enrich_attempt_at TEXT;
