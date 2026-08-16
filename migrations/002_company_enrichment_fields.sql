-- 002_company_enrichment_fields.sql
-- Adds fields backfilled from Hunter's /v2/companies/find + /v2/domain-search:
--   email_pattern: from domain-search (e.g. "{first}.{last}"). Even a
--                  single indexed person locks the pattern; we can then
--                  construct + verify emails for other names later.
--   industry:      from Company Enrichment (SaaS / dev tools / etc.),
--                  useful for future segmentation.
--   linkedin_url:  from Company Enrichment. Handy for /addcompany + UI.

ALTER TABLE company ADD COLUMN email_pattern TEXT;
ALTER TABLE company ADD COLUMN industry      TEXT;
ALTER TABLE company ADD COLUMN linkedin_url  TEXT;
