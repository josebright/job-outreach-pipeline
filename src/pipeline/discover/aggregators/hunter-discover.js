// discover/aggregators/hunter-discover.js
// Hunter /v2/discover: finds companies actively hiring, filtered by headcount
// and job-openings signals. FREE endpoint — does NOT consume credits.
// Rate cap per Hunter: 5 req/s / 50 req/min; hostLimiter keeps us at 1 req/s.
//
// Returns Path-B candidates (companyName + website, no jobs array).
// discover/index.js Path-B then tries ATS resolution; if that fails and a
// website is present, the company is added as ats='external' so enrich can
// find contacts later.
//
// 403 means the account tier doesn't have discover access — logged once and
// the aggregator silently returns [] so the rest of the run continues.
import { http, hostLimiter } from '../../util/http.js';
import { env } from '../../config/loader.js';
import { logger } from '../../util/logger.js';

export const source = 'hunter_discover';

const HOST = 'api.hunter.io';
const limit = hostLimiter(HOST, 1);

// ICP filter: 1-500 employees (gate4_companySize handles the upper bound).
const HEADCOUNT_BANDS = ['1-10', '11-50', '51-200', '201-500'];

// Keywords signal remote-friendly engineering roles. Hunter treats these as
// OR within the include array, so any hit qualifies. Keep broad so we don't
// over-filter here — gates in qualify/filters.js handle the fine-grained ICP check.
const KEYWORDS_INCLUDE = ['remote', 'software engineer', 'backend engineer', 'full-stack'];

/**
 * Fetch companies actively hiring from Hunter /v2/discover.
 * @param {object} opts
 * @param {number} [opts.pages=3] - how many pages to fetch (100 results each)
 * @returns {Promise<Array<{companyName,website,sizeBand,source,hint,jobs?}>>}
 */
export async function fetchCompanies({ pages = 3 } = {}) {
  if (!env.HUNTER_API_KEY) {
    logger.warn('hunter_discover: HUNTER_API_KEY not set — skipping');
    return [];
  }

  const candidates = [];
  const seen = new Set();
  let tierBlocked = false;

  for (let page = 1; page <= pages; page++) {
    let res;
    try {
      res = await limit(() => http.post(
        `https://${HOST}/v2/discover`,
        {
          headcount: HEADCOUNT_BANDS,
          job_openings: { hiring: true, posted_date: 'last7d' },
          keywords: { include: KEYWORDS_INCLUDE },
        },
        {
          params: { api_key: env.HUNTER_API_KEY, page, limit: 100 },
          validateStatus: s => s < 500,
        }
      ));
    } catch (err) {
      logger.error({ err: err.message, page }, 'hunter_discover: request errored');
      break;
    }

    if (res.status === 401 || res.status === 403) {
      logger.warn({ status: res.status }, 'hunter_discover: tier restriction — endpoint not available on this plan');
      tierBlocked = true;
      break;
    }
    if (res.status !== 200) {
      logger.warn({ status: res.status, page, body: res.data }, 'hunter_discover: unexpected status');
      break;
    }

    const companies = Array.isArray(res.data?.data?.companies)
      ? res.data.data.companies
      : [];

    if (companies.length === 0) break;

    for (const co of companies) {
      const domain = co.domain || null;
      const name = co.name || co.organization || domain;
      if (!name) continue;
      const key = domain || name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        companyName: name,
        website: domain,
        sizeBand: normalizeBand(co.headcount),
        source,
        hint: null,
        // No jobs array → discover/index.js routes this as Path B
      });
    }

    logger.debug({ page, fetched: companies.length }, 'hunter_discover: page done');

    // Hunter returns fewer items than `limit` on the last page.
    if (companies.length < 100) break;
  }

  if (!tierBlocked) {
    logger.info({ total: candidates.length }, 'hunter_discover: fetch complete');
  }
  return candidates;
}

/**
 * Normalize Hunter's headcount field to our size-band strings.
 * Hunter may return "11-50", "11_50", or a raw integer.
 */
export function normalizeBand(headcount) {
  if (headcount == null) return null;
  const s = String(headcount).replace(/_/g, '-');
  if (s === '1-10' || s === '11-50' || s === '51-200' || s === '201-500') return s;
  const n = Number(s.replace(/[^0-9]/g, ''));
  if (!n) return null;
  if (n <= 10)  return '1-10';
  if (n <= 50)  return '11-50';
  if (n <= 200) return '51-200';
  if (n <= 500) return '201-500';
  return null;
}
