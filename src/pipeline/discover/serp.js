// discover/serp.js
// SERP-based slug discovery. Supports Google Programmable Search Engine (PSE)
// as the free default, and Serper.dev as a paid alternative.
import { http } from '../util/http.js';
import { env } from '../config/loader.js';
import { logger } from '../util/logger.js';

const HOST_TO_SLUG_REGEX = {
  'boards.greenhouse.io': /boards\.greenhouse\.io\/([a-z0-9-]+)/i,
  'jobs.lever.co': /jobs\.lever\.co\/([a-z0-9-]+)/i,
  'jobs.ashbyhq.com': /jobs\.ashbyhq\.com\/([a-z0-9-]+)/i,
  'apply.workable.com': /apply\.workable\.com\/([a-z0-9-]+)/i,
};

/**
 * Run a dork query against the configured provider, extract slugs for the
 * targeted ATS host, dedupe, return.
 */
export async function serpDork({ provider, host, query, limit = 30 }) {
  if (provider === 'google_pse') return googlePseDork({ host, query, limit });
  if (provider === 'serper')     return serperDork({ host, query, limit });
  logger.warn({ provider }, 'serp provider not implemented; returning empty');
  return [];
}

// Google Programmable Search Engine (PSE) via the Custom Search JSON API.
// Free tier: 100 queries/day. Supports site: operator.
// Docs: https://developers.google.com/custom-search/v1/overview
async function googlePseDork({ host, query, limit }) {
  if (!env.GOOGLE_SEARCH_API_KEY || !env.GOOGLE_SEARCH_ENGINE_ID) {
    logger.warn('GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_ENGINE_ID missing; skipping SERP discovery');
    return [];
  }
  const fullQuery = `site:${host} ${query}`;
  // PSE returns up to 10 per request. We page up to `limit` results.
  const perPage = 10;
  const maxPages = Math.ceil(Math.min(limit, 100) / perPage);
  const seen = new Set();

  for (let page = 0; page < maxPages; page++) {
    const start = page * perPage + 1;
    try {
      const res = await http.get('https://www.googleapis.com/customsearch/v1', {
        params: {
          key: env.GOOGLE_SEARCH_API_KEY,
          cx: env.GOOGLE_SEARCH_ENGINE_ID,
          q: fullQuery,
          num: perPage,
          start,
        },
        validateStatus: s => s < 500,
      });
      if (res.status !== 200) {
        logger.warn({ status: res.status, err: res.data?.error?.message }, 'google_pse non-200');
        break;
      }
      const items = res.data?.items || [];
      if (items.length === 0) break;
      for (const it of items) if (it.link) seen.add(it.link);
      // Stop early if PSE reports no more pages.
      const queries = res.data?.queries?.nextPage;
      if (!queries) break;
    } catch (err) {
      logger.warn({ err: err.message }, 'google_pse error');
      break;
    }
  }
  return extractSlugs(host, [...seen]);
}

// Serper.dev alternative. Note: free tier does NOT allow site: queries.
async function serperDork({ host, query, limit }) {
  if (!env.SERPER_API_KEY) {
    logger.warn('SERPER_API_KEY missing; skipping SERP discovery');
    return [];
  }
  const fullQuery = `site:${host} ${query}`;
  const res = await http.post('https://google.serper.dev/search',
    { q: fullQuery, num: Math.min(limit, 100) },
    { headers: { 'X-API-KEY': env.SERPER_API_KEY, 'Content-Type': 'application/json' } }
  );
  const results = res.data?.organic || [];
  return extractSlugs(host, results.map(r => r.link).filter(Boolean));
}

export function extractSlugs(host, urls) {
  const re = HOST_TO_SLUG_REGEX[host];
  if (!re) return [];
  const seen = new Set();
  for (const url of urls) {
    const m = url.match(re);
    if (m && m[1] && !isReservedPath(m[1])) seen.add(m[1].toLowerCase());
  }
  return [...seen];
}

// Filter out non-company paths returned by dorks (e.g. shared static routes).
const RESERVED = new Set(['embed', 'api', 'static', 'assets', 'careers']);
function isReservedPath(s) { return RESERVED.has(s); }
