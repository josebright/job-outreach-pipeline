// enrich/domain-guess.js
// Guess a company's primary domain from its ATS slug when neither website
// nor a non-ATS job URL is available. Small startups almost always own
// <slug>.com / .io / .ai / .co / .dev / .app. We DNS-check each candidate
// and return the first that resolves.
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
 * @returns {Promise<string|null>} resolved domain (e.g., "modal.com") or null
 */
export async function guessDomain(company) {
  const candidates = candidatesFor(company);
  for (const host of candidates) {
    try {
      const addrs = await dns.resolve4(host);
      if (Array.isArray(addrs) && addrs.length > 0) return host;
    } catch { /* NXDOMAIN or SERVFAIL — try next */ }
  }
  return null;
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
