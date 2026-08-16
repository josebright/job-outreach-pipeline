-- 003_size_band_source.sql
-- Tracks WHERE a company.size_band value came from so we can decide
-- whether to trust it. Hunter's companies/find is often stale for
-- larger companies (Affirm, Algolia, Canonical all cached wrong values),
-- so we distrust its answers and re-verify at draft time. Seed CSV data
-- is human-vetted and trusted unconditionally. Manual overrides via
-- /setsize are also trusted.
--
-- Values: 'seed' | 'hunter' | 'manual' | NULL (unknown / not yet set)
--
-- Retroactive fix: any company that ALREADY has a size_band but no
-- source is marked as 'hunter' so the next draft pass re-verifies.
-- Seed-CSV companies get re-marked as 'seed' next time the CSV loader
-- runs — the loader now sets this field.

ALTER TABLE company ADD COLUMN size_band_source TEXT;

-- Retroactive: any existing size_band without a source came from Hunter
-- (that was the only path that wrote sizes prior to this migration).
-- Marks it distrusted so draft-time re-verification kicks in.
UPDATE company
SET size_band_source = 'hunter'
WHERE size_band IS NOT NULL AND size_band_source IS NULL;
