-- 007_backfill_override_for_existing_approved.sql
-- One-shot backfill: any draft that was approved BEFORE migration 006
-- shipped is stuck with deliverability_override=0 (the column default),
-- so /send blocks it if the recipient is 'risky'. Those approvals
-- happened by human /approve, which is exactly the informed-consent
-- signal the override is meant to encode. Flip them.
--
-- Safe by construction: any future /approve sets override=1 in code
-- (see handleApprove), so this only affects the small window of
-- already-approved drafts pending re-consent. Runs once (tracked in
-- schema_migrations).

UPDATE draft
SET deliverability_override = 1
WHERE status = 'approved' AND deliverability_override = 0;
