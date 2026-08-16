// discover/aggregators/yc.js
// Y Combinator's public company directory. No auth, no expiry.
// https://api.ycombinator.com/v0.1/companies
//
// Every YC company appears here with an exact teamSize (integer), which
// lets us pre-filter to the 2-500 range at the aggregator itself — no
// downstream cycles wasted on companies that would fail gate 4.
//
// Returns { companyName, url, source, hint, sizeBand } — the sizeBand
// is derived from teamSize and passed through to upsertCompany with
// source='seed'-equivalent trust (see below). YC has strong data
// hygiene here, so we tag these as source='hunter' for size trust
// purposes since we still want draft-time re-verification on borderline
// cases — but the initial value is much more likely correct than
// Hunter's guess.
import { http, hostLimiter } from '../../util/http.js';
import { hintFromUrl } from './remotive.js';

export const source = 'yc';
const API_HOST = 'api.ycombinator.com';
const limit = hostLimiter(API_HOST, 1);

const ENDPOINT = `https://${API_HOST}/v0.1/companies`;

// Pagination — YC returns ~1000 companies per page. We only need active
// hiring companies; walk 2 pages max (~2000 companies) per run.
const PAGES = 2;

/**
 * @param {object} args
 * @param {number} [args.maxTeamSize=500]
 * @param {boolean} [args.onlyActive=true]
 */
export async function fetchCompanies({ maxTeamSize = 500, onlyActive = true } = {}) {
  const seen = new Map();

  for (let page = 1; page <= PAGES; page++) {
    const res = await limit(() => http.get(`${ENDPOINT}?page=${page}&count=1000`, {
      validateStatus: s => s < 500,
    }));
    if (res.status !== 200) break;
    const companies = Array.isArray(res.data?.companies) ? res.data.companies : [];
    if (companies.length === 0) break;

    for (const c of companies) {
      const teamSize = Number(c.teamSize || 0);
      // 0 means "unknown" in YC's data. Include it — gate 4 accepts unknowns.
      if (teamSize > 0 && teamSize > maxTeamSize) continue;
      if (onlyActive && c.status && c.status !== 'Active') continue;
      const name = String(c.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;

      // Hint: we don't get an ATS URL from YC, but the website often
      // links out to /careers or /jobs which we can probe later.
      seen.set(key, {
        companyName: name,
        url: c.website || null,
        source,
        hint: null,      // YC doesn't give us an ATS slug directly
        sizeBand: teamSizeToBand(teamSize),
      });
    }

    // If the last page returned fewer than 1000, we've hit the end.
    if (companies.length < 1000) break;
  }
  return [...seen.values()];
}

/** Convert YC's integer teamSize to our band strings. */
export function teamSizeToBand(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 10)   return '1-10';
  if (n <= 50)   return '11-50';
  if (n <= 200)  return '51-200';
  if (n <= 500)  return '201-500';
  if (n <= 1000) return '501-1000';
  return '1000+';
}
