// enrich/hunter.js
// Hunter.io API v2 client. Docs: https://hunter.io/api-documentation/
//
// Endpoints used:
//   /v2/email-count      -> how many emails Hunter has on a domain (FREE)
//   /v2/companies/find   -> HQ country, size, industry, LinkedIn URL (1 credit)
//   /v2/domain-search    -> list emails on a domain, plus pattern (1 credit / 10 results)
//   /v2/email-finder     -> resolve a specific person to an email (1 credit)
//   /v2/email-verifier   -> deliverability check (1 credit)
//
// Hunter's own recommendation for small startups (< ~30 employees):
//   1. email-count first (free) to skip empty domains
//   2. companies/find to fill HQ/size/industry when we don't have them
//   3. domain-search + pattern extraction (even one indexed person locks
//      the pattern, which we can reuse for future email-finder calls)
//   4. Never send to accept_all domains — Hunter warns they pass
//      verification but bounce/spam-trap.
//
// We ask the caller (enrich orchestrator) to charge the cost_ledger before
// each *paid* call so the guard can bail before we make it. email-count is
// free and never charged.
import { http, hostLimiter } from '../util/http.js';
import { env } from '../config/loader.js';
import { logger } from '../util/logger.js';

const HOST = 'api.hunter.io';
const limit = hostLimiter(HOST, 1);

function ensureKey() {
  if (!env.HUNTER_API_KEY) throw new Error('HUNTER_API_KEY missing');
}

/**
 * Free endpoint: returns how many emails Hunter indexes for a domain.
 * Call this BEFORE domain-search so we don't spend a credit on a domain
 * Hunter has never seen. Returns { total, personal, generic }. On any
 * error, returns { total: null } — the caller should treat null as
 * "unknown, don't skip" so we don't accidentally starve the pipeline.
 */
export async function emailCount({ domain }) {
  const params = { domain };
  // email-count works without an API key, but include it if we have one
  // to lift the per-IP rate cap.
  if (env.HUNTER_API_KEY) params.api_key = env.HUNTER_API_KEY;
  try {
    const res = await limit(() => http.get(`https://${HOST}/v2/email-count`, { params, validateStatus: s => s < 500 }));
    if (res.status !== 200) {
      // 429 / 401 / 403 here used to vanish, leaving company size "unknown" -
      // which is how companies far over 500 people passed the size gate.
      logger.warn({ status: res.status, domain, err: res.data?.errors?.[0]?.details }, 'hunter: email-count returned non-200');
      return { total: null };
    }
    return {
      total: res.data?.data?.total ?? null,
      personal: res.data?.data?.personal_emails ?? null,
      generic: res.data?.data?.generic_emails ?? null,
    };
  } catch (err) {
    logger.warn({ err: err.message, domain }, 'hunter: email-count request failed');
    return { total: null };
  }
}

/**
 * Company enrichment (People Data / "companies/find"). Returns
 * { name, domain, industry, size, country, linkedin, twitter, founded }
 * or null on 404. Costs 1 credit per successful call.
 */
export async function companyEnrich({ domain }) {
  ensureKey();
  const params = { domain, api_key: env.HUNTER_API_KEY };
  const res = await limit(() => http.get(`https://${HOST}/v2/companies/find`, { params, validateStatus: s => s < 500 }));
  if (res.status === 404) return null;
  if (res.status !== 200) return null;
  const d = res.data?.data || {};
  return {
    name: d.name || null,
    domain: d.domain || domain,
    // Hunter returns numeric metrics; normalize the ones we care about.
    industry: pickIndustry(d),
    // Metrics.employees is an approximate integer count; Hunter also
    // sometimes returns a size bucket string.
    employeesEstimate: d.metrics?.employees ?? null,
    country: d.geo?.country || d.geo?.countryCode || null,
    linkedin: d.linkedin?.handle ? `https://linkedin.com/company/${d.linkedin.handle}` : null,
    founded: d.foundedYear || d.founded || null,
    twitter: d.twitter?.handle || null,
  };
}

function pickIndustry(d) {
  // Hunter puts industry in a few places over the years. Try each.
  return d.category?.industry || d.category?.industryGroup || d.industry || null;
}

/**
 * Convert an employee count integer into a size band string that matches
 * the bands used elsewhere in the pipeline ("11-50" etc.). Returns null
 * for unknown input.
 */
export function employeesToBand(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  const e = Number(n);
  if (e <= 0) return null;
  if (e <= 10)   return '1-10';
  if (e <= 50)   return '11-50';
  if (e <= 200)  return '51-200';
  if (e <= 500)  return '201-500';
  if (e <= 1000) return '501-1000';
  return '1000+';
}

/**
 * Search a domain for contacts. Returns { pattern, emails: [...] }.
 * emails item shape: { value, first_name, last_name, position, seniority, department, confidence, verification }
 */
export async function domainSearch({ domain, limit: max = 25, seniority = null, department = null }) {
  ensureKey();
  const params = { domain, api_key: env.HUNTER_API_KEY, limit: max };
  if (seniority) params.seniority = seniority;
  if (department) params.department = department;

  const res = await limit(() => http.get(`https://${HOST}/v2/domain-search`, { params, validateStatus: s => s < 500 }));
  if (res.status !== 200) return { pattern: null, emails: [], error: describe(res) };
  return {
    pattern: res.data?.data?.pattern || null,
    organization: res.data?.data?.organization || null,
    emails: res.data?.data?.emails || [],
  };
}

/**
 * Find a specific person's email by name + domain.
 * Returns { email, first_name, last_name, position, confidence, verification } or null.
 */
export async function emailFinder({ domain, firstName, lastName }) {
  ensureKey();
  const params = {
    domain, first_name: firstName, last_name: lastName, api_key: env.HUNTER_API_KEY,
  };
  const res = await limit(() => http.get(`https://${HOST}/v2/email-finder`, { params, validateStatus: s => s < 500 }));
  if (res.status !== 200) return null;
  const d = res.data?.data;
  if (!d?.email) return null;
  return {
    email: d.email,
    firstName: d.first_name,
    lastName: d.last_name,
    position: d.position,
    confidence: d.score,
    verification: d.verification,
  };
}

/**
 * Verify an email. Returns one of 'verified' | 'risky' | 'invalid'.
 *
 * Hunter statuses we can see:
 *   deliverable    -> verified (send freely)
 *   undeliverable  -> invalid  (never send; suppress)
 *   disposable     -> invalid  (throwaway mailbox)
 *   accept_all     -> invalid  (Hunter's own warning: server accepts
 *                               anything; verification is meaningless
 *                               and bulk-sending damages sender reputation)
 *   risky          -> risky    (low-confidence but no accept_all flag)
 *   webmail        -> risky    (Gmail/Yahoo personal; usually still delivers)
 *   unknown        -> risky    (Hunter could not verify; do not throw away)
 *   anything else  -> risky    (safer than dropping; downstream still gated)
 */
export async function emailVerifier({ email }) {
  ensureKey();
  const params = { email, api_key: env.HUNTER_API_KEY };
  const res = await limit(() => http.get(`https://${HOST}/v2/email-verifier`, { params, validateStatus: s => s < 500 }));
  if (res.status !== 200) return { status: 'invalid', raw: null };
  const d = res.data?.data;
  const status = mapHunterStatus(d?.status);
  return {
    status,
    score: d?.score ?? null,
    raw: d,
  };
}

/**
 * Same mapping used for the inline verification field returned by
 * domain-search (so the caller does not have to re-implement it).
 */
export function mapHunterStatus(status) {
  if (!status) return 'risky';
  const s = String(status).toLowerCase();
  if (s === 'deliverable' || s === 'valid') return 'verified';
  if (s === 'undeliverable' || s === 'disposable') return 'invalid';
  // accept_all: Hunter itself warns against sending to these. The server
  // says "yes" to any address, so verification is meaningless and bulk
  // sends bounce or hit spam traps. Treat as invalid to keep them out of
  // both the contact table and the send queue.
  if (s === 'accept_all') return 'invalid';
  // Everything else (risky, webmail, unknown): risky. Never drop silently.
  return 'risky';
}

function describe(res) {
  const d = res.data;
  return {
    status: res.status,
    errors: d?.errors || d?.message || null,
  };
}
