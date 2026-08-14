// enrich/hunter.js
// Hunter.io API v2 client. Docs: https://hunter.io/api-documentation/
//
// Three endpoints used:
//   /v2/domain-search   -> list emails on a domain, plus pattern
//   /v2/email-finder    -> resolve a specific person to an email
//   /v2/email-verifier  -> deliverability check
//
// Cost per call (Hunter's own accounting):
//   domain-search     = 1 credit per 10 results returned
//   email-finder      = 1 credit per successful match
//   email-verifier    = 1 credit per verification
//
// We ask the caller (enrich orchestrator) to charge the cost_ledger before
// each call so the guard can bail before we make it.
import { http, hostLimiter } from '../util/http.js';
import { env } from '../config/loader.js';

const HOST = 'api.hunter.io';
const limit = hostLimiter(HOST, 1);

function ensureKey() {
  if (!env.HUNTER_API_KEY) throw new Error('HUNTER_API_KEY missing');
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
 */
export async function emailVerifier({ email }) {
  ensureKey();
  const params = { email, api_key: env.HUNTER_API_KEY };
  const res = await limit(() => http.get(`https://${HOST}/v2/email-verifier`, { params, validateStatus: s => s < 500 }));
  if (res.status !== 200) return { status: 'invalid', raw: null };
  const d = res.data?.data;
  const map = { deliverable: 'verified', risky: 'risky', undeliverable: 'invalid', unknown: 'risky' };
  return {
    status: map[d?.status] || 'invalid',
    score: d?.score ?? null,
    raw: d,
  };
}

function describe(res) {
  const d = res.data;
  return {
    status: res.status,
    errors: d?.errors || d?.message || null,
  };
}
