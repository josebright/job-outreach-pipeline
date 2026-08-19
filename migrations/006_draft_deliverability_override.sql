-- 006_draft_deliverability_override.sql
-- Per-draft override for the deliverability gate.
-- The auto-cron send path enforces config.enrichment.min_email_status_for_auto_send
-- (default 'verified') to protect sender reputation. But when the applicant
-- manually /approves a draft, they've seen the [risky]/[verified] badge in
-- /list and are giving informed consent to send. Their explicit approval
-- should override the blanket gate for THAT draft.
--
-- Set to 1 when a human explicitly approves via Telegram; stays 0 for any
-- auto-approval path (none exist today, but the column is fail-safe if
-- one is ever added). sendApprovedDraft honors this bit and logs a
-- 'deliverability_override_used' event when it lets a risky send through,
-- so bounces remain attributable.

ALTER TABLE draft ADD COLUMN deliverability_override INTEGER NOT NULL DEFAULT 0;
