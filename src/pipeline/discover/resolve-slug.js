// discover/resolve-slug.js
// Given a company name from an aggregator, try to resolve it to a live
// (ats, slug) pair by probing each ATS with normalized-name guesses.
//
// Resolution order:
//   1. If the aggregator gave us a hint from the URL, trust it (still probe once).
//   2. Otherwise, iterate ATS platforms x slug candidates, first alive wins.
//
// Failures are recorded in dead_slug (30 days) so we do not re-probe them soon.
import { getAts } from '../ingest/ats/index.js';
import { slugCandidates } from '../ingest/ats/classify.js';
import { isSlugDead, markSlugDead } from '../db/repo.js';

/**
 * @param {object} args
 * @param {string} args.companyName
 * @param {{ats:string, slug:string}|null} [args.hint]
 * @param {string[]} args.atsPlatforms  - which ATS to try, in order
 * @returns {Promise<{ats:string, slug:string, companyName:string}|null>}
 */
export async function resolveSlug({ companyName, hint = null, atsPlatforms }) {
  // 1) Hint from URL: single probe against that specific (ats, slug).
  if (hint?.ats && hint?.slug && atsPlatforms.includes(hint.ats)) {
    if (!isSlugDead(hint.ats, hint.slug)) {
      const client = getAts(hint.ats);
      const res = await client.probe(hint.slug);
      if (res.alive) {
        return { ats: hint.ats, slug: hint.slug, companyName: res.companyName || companyName };
      }
      markSlugDead(hint.ats, hint.slug);
    }
  }

  // 2) Generate slug candidates and probe each ATS.
  const candidates = slugCandidates(companyName);
  for (const ats of atsPlatforms) {
    const client = getAts(ats);
    for (const slug of candidates) {
      if (isSlugDead(ats, slug)) continue;
      const res = await client.probe(slug);
      if (res.alive) {
        return { ats, slug, companyName: res.companyName || companyName };
      }
      markSlugDead(ats, slug);
    }
  }
  return null;
}
