// discover/index.js
// Combines three sources, in priority order:
//   1. Seed CSV        (highest, human-vetted, no probe)
//   2. SERP dorks      (per ATS, direct slug extraction)
//   3. Aggregator feeds (company names, resolved to slugs via probing)
//
// Every candidate slug is probed against its ATS before insertion.
// Dead slugs are skipped for 30 days via the dead_slug table.
import path from 'path';
import { fileURLToPath } from 'url';
import { getAts } from '../ingest/ats/index.js';
import { getAggregator } from './aggregators/index.js';
import { upsertCompany, isSlugDead, markSlugDead } from '../db/repo.js';
import { loadSeedCsv } from './seed.js';
import { serpDork } from './serp.js';
import { resolveSlug } from './resolve-slug.js';
import { logger } from '../util/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');

const DEFAULT_DORKS = {
  greenhouse:      '(backend OR "software engineer" OR platform) ("remote" AND ("worldwide" OR "EMEA" OR "Africa" OR "anywhere"))',
  lever:           '("software engineer" OR backend OR fullstack) remote (worldwide OR EMEA OR anywhere)',
  ashby:           '"software engineer" remote (worldwide OR EMEA OR anywhere)',
  workable:        '"software engineer" remote (worldwide OR EMEA)',
  smartrecruiters: '"software engineer" remote (worldwide OR EMEA OR anywhere)',
};

export async function runDiscover({ config }) {
  const stats = {
    seedInserted: 0,
    dorkFound: 0, dorkAlive: 0,
    aggregatorCompanies: 0, aggregatorResolved: 0,
    duplicates: 0, dead: 0,
  };

  // ── 1. Seed CSV ───────────────────────────────────────────
  const seedPath = config.discover.seed_csv_path
    ? path.resolve(ROOT_DIR, config.discover.seed_csv_path)
    : null;
  if (seedPath) {
    const rows = loadSeedCsv(seedPath);
    for (const row of rows) {
      const { created } = upsertCompany({
        name: row.name || row.slug,
        ats: row.ats,
        slug: row.slug,
        source: 'seed',
        website: row.website,
        hqCountry: row.hqCountry,
        sizeBand: row.sizeBand,
        nigeriaPresence: row.nigeriaPresence,
      });
      if (created) stats.seedInserted++;
      else stats.duplicates++;
    }
    logger.info({ inserted: stats.seedInserted, from: seedPath }, 'seed loaded');
  }

  // ── 2. SERP dorks per ATS ─────────────────────────────────
  for (const atsName of config.discover.ats_platforms) {
    const ats = getAts(atsName);
    const query = DEFAULT_DORKS[atsName];
    if (!query) continue;

    let slugs = [];
    try {
      slugs = await serpDork({
        provider: config.discover.serp_provider,
        host: ats.discoveryHost,
        query,
      });
    } catch (err) {
      logger.error({ err: err.message, ats: atsName }, 'serp dork failed');
      continue;
    }
    stats.dorkFound += slugs.length;

    for (const slug of slugs) {
      if (isSlugDead(atsName, slug)) continue;
      const probeRes = await ats.probe(slug);
      if (!probeRes.alive) {
        markSlugDead(atsName, slug);
        stats.dead++;
        continue;
      }
      const { created } = upsertCompany({
        name: probeRes.companyName || slug, ats: atsName, slug, source: 'dork',
      });
      if (created) stats.dorkAlive++;
      else stats.duplicates++;
    }
    logger.info({ ats: atsName, found: slugs.length }, 'dork batch done');
  }

  // ── 3. Aggregator feeds ───────────────────────────────────
  for (const aggName of config.discover.aggregator_feeds || []) {
    let candidates = [];
    try {
      const agg = getAggregator(aggName);
      candidates = await agg.fetchCompanies();
    } catch (err) {
      logger.error({ err: err.message, aggregator: aggName }, 'aggregator fetch failed');
      continue;
    }
    stats.aggregatorCompanies += candidates.length;

    for (const c of candidates) {
      const resolved = await resolveSlug({
        companyName: c.companyName,
        hint: c.hint,
        atsPlatforms: config.discover.ats_platforms,
      });
      if (!resolved) continue;
      const { created } = upsertCompany({
        name: resolved.companyName, ats: resolved.ats, slug: resolved.slug,
        source: `aggregator:${aggName}`,
        website: c.website || null,
        // If the aggregator gave us a sizeBand (only YC does today), pass
        // it through with source='hunter' trust — YC's own team-size
        // data is more accurate than what companies/find would return
        // for the same slug, but we still want draft-time re-verification
        // on the 501+ boundary.
        sizeBand: c.sizeBand || null,
        sizeBandSource: c.sizeBand ? 'hunter' : null,
      });
      if (created) stats.aggregatorResolved++;
      else stats.duplicates++;
    }
    logger.info({ aggregator: aggName, candidates: candidates.length }, 'aggregator batch done');
  }

  return stats;
}
