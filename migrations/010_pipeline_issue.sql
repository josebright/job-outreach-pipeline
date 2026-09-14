-- 010_pipeline_issue.sql
-- Every warning and error the pipeline raises, kept where the applicant can see
-- it. Until now these went only to Railway's log stream, so from Telegram every
-- failure looked the same: silence, or a result with a quietly missing piece.
-- /run, /send, the daily notification and /issues all read from here.
CREATE TABLE IF NOT EXISTS pipeline_issue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT,             -- groups the issues of one /run, cron pass, or /send
  origin      TEXT,             -- telegram:/run | cron:daily | cron:send | telegram:/send | bot
  stage       TEXT,             -- discover | ingest | qualify | enrich | draft | send | bot | service
  level       TEXT NOT NULL,    -- warn | error | fatal
  message     TEXT NOT NULL,
  detail_json TEXT,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_issue_at  ON pipeline_issue (at);
CREATE INDEX IF NOT EXISTS idx_issue_run ON pipeline_issue (run_id);
