// enrich/domain-guess.js
// Guess a company's primary domain from its ATS slug when neither website
// nor a non-ATS job URL is available. Small startups almost always own
// <slug>.com / .io / .ai / .co / .dev / .app. We DNS-check each candidate
// and return the first that resolves both an A record AND an MX record.
//
// Why MX: a parked/squatted domain typically has an A record pointing at
// some parking service but no MX (parking pages don't receive mail). A
// real company mail domain always has MX. This filter cheaply rules out
// squats before we spend a Hunter credit on them.
//
// Zero API cost. DNS lookups are cached by the OS resolver so re-checks
// against the same slug are fast. No HTTP call, no user-agent, no risk.
import { promises as dns } from 'node:dns';

const TLDS = ['com', 'io', 'ai', 'co', 'dev', 'app', 'so', 'xyz', 'tech'];

// Slugs that would produce garbage guesses.
const SKIP = new Set([
  'careers', 'jobs', 'talent', 'apply', 'application', 'boards',
]);

/**
 * @param {{ slug?:string|null, name?:string|null }} company
 * @param {{ resolver?: object }} [opts] - injectable DNS resolver for tests
 * @returns {Promise<string|null>} resolved domain (e.g., "modal.com") or null
 */
export async function guessDomain(company, { resolver = dns } = {}) {
  const candidates = candidatesFor(company);
  for (const host of candidates) {
    if (await hasARecord(host, resolver) && await hasMxRecord(host, resolver)) {
      return host;
    }
  }
  return null;
}

async function hasARecord(host, resolver) {
  try {
    const addrs = await resolver.resolve4(host);
    return Array.isArray(addrs) && addrs.length > 0;
  } catch { return false; }
}

async function hasMxRecord(host, resolver) {
  try {
    const mx = await resolver.resolveMx(host);
    // resolveMx returns [{ exchange, priority }, ...]. Any non-empty
    // list means the domain accepts mail somewhere. An empty list is
    // returned as [] on some resolvers instead of throwing NODATA, so
    // check length explicitly.
    return Array.isArray(mx) && mx.length > 0 && mx.some(r => r?.exchange);
  } catch { return false; }
}

export function candidatesFor(company) {
  const raw = String(company?.slug || '').toLowerCase().trim();
  if (!raw || SKIP.has(raw)) return [];
  const variants = new Set();

  // Base slug as-is + de-punctuated + de-dashed.
  const base = raw.replace(/[^a-z0-9-]/g, '');
  if (base) variants.add(base);
  variants.add(base.replace(/-/g, ''));

  // Also try the first token of the display name (e.g. "Modal Labs" -> "modal").
  const nameFirst = String(company?.name || '').toLowerCase().split(/\s+/)[0]?.replace(/[^a-z0-9]/g, '') || '';
  if (nameFirst && nameFirst.length >= 3) variants.add(nameFirst);

  const hosts = [];
  for (const v of variants) {
    if (!v || v.length < 2) continue;
    for (const tld of TLDS) hosts.push(`${v}.${tld}`);
  }
  return hosts;
}
