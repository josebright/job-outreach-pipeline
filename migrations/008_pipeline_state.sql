-- Small key/value store for pipeline bookkeeping that is not per-entity.
-- First use: a fingerprint of the qualification-relevant config, so that
-- changing a gate threshold or keyword list re-evaluates jobs that the OLD
-- config had already marked 'disqualified'. Without it those rows are a
-- terminal state and config changes only ever affect newly-ingested jobs.
CREATE TABLE IF NOT EXISTS pipeline_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
