// discover/serp.js
// SERP-based slug discovery. Currently supports Serper.dev; SerpAPI/Google PSE
// are placeholders for Week 2.
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
  if (provider === 'serper') return serperDork({ host, query, limit });
  logger.warn({ provider }, 'serp provider not implemented; returning empty');
  return [];
}

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
