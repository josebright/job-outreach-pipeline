-- 005_draft_variant.sql
-- Track which prompt variant produced each draft. The three-variant
-- rotation (V1_OBSERVATION, V2_QUESTION, V3_DIRECT) has been in place
-- since the outreach_v2 prompt shipped, but the pick was ephemeral in
-- generateDraft's return — never persisted. Without per-variant
-- persistence we can't segment reply-rate telemetry by variant, and
-- can't tell which structural shape is actually earning replies.

ALTER TABLE draft ADD COLUMN variant TEXT;
CREATE INDEX IF NOT EXISTS idx_draft_variant ON draft (variant);
