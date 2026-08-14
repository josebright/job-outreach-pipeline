-- 001_initial_schema.sql
-- Baseline schema for the outreach pipeline.
-- SQLite dialect. Applied by src/pipeline/db/migrate.js.

CREATE TABLE IF NOT EXISTS company (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  ats               TEXT    NOT NULL,        -- greenhouse | lever | ashby | workable | seed
  slug              TEXT    NOT NULL,
  hq_country        TEXT,
  size_band         TEXT,                    -- 1-10 | 11-50 | 51-200 | 201-500 | 501-1000 | 1000+
  website           TEXT,
  nigeria_presence  INTEGER NOT NULL DEFAULT 0, -- 0/1 boolean
  source            TEXT    NOT NULL,        -- dork | aggregator | seed | manual
  score             INTEGER NOT NULL DEFAULT 0,
  status            TEXT    NOT NULL DEFAULT 'discovered', -- discovered | ingested | qualified | disqualified | dead
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (ats, slug)
);

CREATE INDEX IF NOT EXISTS idx_company_status ON company (status);
CREATE INDEX IF NOT EXISTS idx_company_score  ON company (score DESC);

CREATE TABLE IF NOT EXISTS job (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id         INTEGER NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  external_job_id    TEXT    NOT NULL,
  title              TEXT    NOT NULL,
  department         TEXT,
  location_raw       TEXT,
  remote_scope       TEXT,                   -- worldwide | emea | africa | us_only | onsite | unknown
  workplace_type     TEXT,                   -- remote | hybrid | onsite | unknown
  currency_signal    TEXT,                   -- USD | EUR | GBP | none
  comp_raw           TEXT,
  description_text   TEXT,
  url                TEXT,
  posted_at          TEXT,
  updated_at_source  TEXT,
  status             TEXT    NOT NULL DEFAULT 'ingested', -- ingested | qualified | disqualified | needs_review | closed
  disqualify_reason  TEXT,
  track              TEXT    NOT NULL DEFAULT 'A',        -- A (remote/USD) | B (visa)
  score              INTEGER NOT NULL DEFAULT 0,
  fetched_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, external_job_id)
);

CREATE INDEX IF NOT EXISTS idx_job_status    ON job (status);
CREATE INDEX IF NOT EXISTS idx_job_company   ON job (company_id);
CREATE INDEX IF NOT EXISTS idx_job_posted_at ON job (posted_at DESC);

CREATE TABLE IF NOT EXISTS contact (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  full_name     TEXT,
  title         TEXT,
  role_type     TEXT    NOT NULL,           -- founder | eng_leader | engineer | recruiter
  email         TEXT    NOT NULL,
  email_status  TEXT    NOT NULL,           -- verified | risky | invalid
  source        TEXT    NOT NULL,           -- hunter | apollo | snov | manual
  raw           TEXT,                       -- JSON blob from provider for audit
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, email)
);

CREATE INDEX IF NOT EXISTS idx_contact_company ON contact (company_id);
CREATE INDEX IF NOT EXISTS idx_contact_email   ON contact (email);

CREATE TABLE IF NOT EXISTS draft (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id     INTEGER NOT NULL REFERENCES contact(id) ON DELETE CASCADE,
  job_id         INTEGER REFERENCES job(id) ON DELETE SET NULL,
  subject        TEXT    NOT NULL,
  body           TEXT    NOT NULL,
  prompt_version TEXT    NOT NULL,          -- git-sha or semver of prompt file
  hook_evidence  TEXT,                      -- exact quoted line from source
  hook_verified  INTEGER NOT NULL DEFAULT 0, -- 0/1: hook_evidence substring-match passed
  status         TEXT    NOT NULL DEFAULT 'pending_review', -- pending_review | approved | rejected | sent
  reject_reason  TEXT,
  model          TEXT,                      -- claude-sonnet-4-6 | gemini-2.0-flash | etc
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  approved_at    TEXT,
  sent_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_draft_status  ON draft (status);
CREATE INDEX IF NOT EXISTS idx_draft_contact ON draft (contact_id);

CREATE TABLE IF NOT EXISTS message (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id        INTEGER NOT NULL REFERENCES draft(id) ON DELETE CASCADE,
  direction       TEXT    NOT NULL,          -- outbound | inbound
  kind            TEXT    NOT NULL,          -- initial | followup_1 | followup_2 | reply
  sent_at         TEXT,
  opened_at       TEXT,
  replied_at      TEXT,
  reply_sentiment TEXT,                      -- positive | neutral | negative | auto_reply
  thread_id       TEXT,                      -- Gmail thread id
  message_id      TEXT,                      -- RFC 5322 Message-ID
  bounced         INTEGER NOT NULL DEFAULT 0,
  raw             TEXT                       -- JSON: headers, snippet for reply
);

CREATE INDEX IF NOT EXISTS idx_message_thread ON message (thread_id);
CREATE INDEX IF NOT EXISTS idx_message_kind   ON message (kind);
CREATE INDEX IF NOT EXISTS idx_message_draft  ON message (draft_id);

-- Suppression list: any address here must never be sent to.
-- Populated on bounce, opt-out reply, or manual add.
CREATE TABLE IF NOT EXISTS suppression (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,               -- bounce | opt_out | manual
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  detail     TEXT
);

-- Daily send counter, persisted so caps survive restart.
-- One row per (date, kind). date is YYYY-MM-DD in WAT (UTC+1).
CREATE TABLE IF NOT EXISTS send_counter (
  date  TEXT NOT NULL,                    -- YYYY-MM-DD
  kind  TEXT NOT NULL,                    -- initial | followup
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, kind)
);

-- Cost guard for paid providers (Hunter, Apollo, Serper, LLM tokens).
-- One row per (month, provider). month is YYYY-MM.
CREATE TABLE IF NOT EXISTS cost_ledger (
  month     TEXT    NOT NULL,             -- YYYY-MM
  provider  TEXT    NOT NULL,
  units     INTEGER NOT NULL DEFAULT 0,   -- requests, verifications, tokens (unit meaning per provider)
  budget    INTEGER NOT NULL,
  PRIMARY KEY (month, provider)
);

-- Slug graveyard: slugs that returned 404 or dead-signal. Skip until expires_at.
CREATE TABLE IF NOT EXISTS dead_slug (
  ats        TEXT NOT NULL,
  slug       TEXT NOT NULL,
  died_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,               -- datetime('now', '+30 days')
  PRIMARY KEY (ats, slug)
);

-- Append-only event log. Every state transition writes here.
-- If DB indexes get corrupt, the pipeline can be reconstructed from this.
CREATE TABLE IF NOT EXISTS event_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT    NOT NULL,            -- company | job | contact | draft | message | system
  entity_id   INTEGER,
  event       TEXT    NOT NULL,            -- discovered | ingested | qualified | draft_created | approved | sent | bounced | replied | suppressed
  detail_json TEXT,
  at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_entity ON event_log (entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_event_at     ON event_log (at DESC);
