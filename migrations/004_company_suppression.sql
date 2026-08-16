-- 004_company_suppression.sql
-- Permanent per-company blocklist. When a company appears here it is
-- skipped at qualify AND draft time — no jobs from it get qualified,
-- no drafts get generated, and future runs of any aggregator that
-- re-discovers it are effectively no-ops for outreach.
--
-- Two ways an entry lands here:
--   1. Manual: applicant runs `/suppress <slug> <reason>` in Telegram
--   2. Auto:   applicant runs `/reject <id> too big` (or any reason
--              matching /too\s*(big|large)/i) — the pipeline suppresses
--              the company so subsequent /run cycles don't re-draft it.
--
-- Useful for the "Hunter's data is stale and keeps re-appearing" case
-- (Affirm/Algolia/Snowflake/Airtable) where every free size API returns
-- the same wrong value. The applicant is the ground truth; once they
-- say "no", the pipeline listens.

CREATE TABLE IF NOT EXISTS company_suppression (
  company_id     INTEGER PRIMARY KEY REFERENCES company(id) ON DELETE CASCADE,
  reason         TEXT,
  suppressed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_company_suppression_at ON company_suppression (suppressed_at);
