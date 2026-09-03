// enrich/mail-provider.js
// Detect the mail provider a domain uses from its MX records.
//
// Why this matters: Google Workspace and Microsoft 365 return "accept
// this address" to SMTP verification probes (RCPT TO) for security /
// anti-enumeration reasons — even for addresses that don't exist.
// Hunter's email-verifier then reports these as `accept_all`, which
// used to make us discard perfectly legitimate emails at small
// startups hosted on Google Workspace (60-70% of tech startups).
//
// With provider detection we can interpret `accept_all` conditionally:
//   • accept_all on Google / M365 / Cloudflare → provider artifact,
//     accept as 'risky' (may or may not exist; send with care).
//   • accept_all on a self-hosted or unknown-provider domain → real
//     catch-all, treat as 'invalid' (per Hunter's own guidance).
import { promises as dns } from 'node:dns';

/**
 * @param {string} domain
 * @param {{ resolver?: object }} [opts] - injectable DNS resolver for tests
 * @returns {Promise<'google'|'microsoft'|'cloudflare'|'zoho'|'proofpoint'|'mimecast'|'fastmail'|'other'|'none'>}
 */
export async function detectMailProvider(domain, { resolver = dns } = {}) {
  if (!domain) return 'none';
  let mx;
  try {
    mx = await resolver.resolveMx(domain);
  } catch { return 'none'; }
  if (!Array.isArray(mx) || mx.length === 0) return 'none';

  // The lowest-priority (numerically highest) MX is a fallback; the
  // primary is the lowest-priority-value entry. Either way we just
  // pattern-match on any exchange hostname.
  const exchanges = mx.map(r => String(r.exchange || '').toLowerCase());
  const joined = exchanges.join(' ');

  if (/\bgoogle(mail)?\.com\b|\baspmx\b|gmr-smtp-in/.test(joined)) return 'google';
  if (/\boutlook\.com\b|protection\.outlook\.com|mail\.protection\.outlook\.com/.test(joined)) return 'microsoft';
  if (/mx\.cloudflare\.net|route.*cloudflare|cloudflare.*email/.test(joined)) return 'cloudflare';
  if (/zoho\.com\b|zohomail/.test(joined)) return 'zoho';
  if (/pphosted\.com|proofpoint/.test(joined)) return 'proofpoint';
  if (/mimecast\b/.test(joined)) return 'mimecast';
  if (/fastmail\.com|messagingengine/.test(joined)) return 'fastmail';
  return 'other';
}

/**
 * Given Hunter's raw status, the mail provider, and an optional personal
 * email count from email-count, return our normalized label.
 *
 * Two reasons we demote accept_all from 'invalid' to 'risky':
 *   1. Provider: Google / M365 / Cloudflare lie about being catch-all (SMTP
 *      anti-enumeration). Their accept_all is a provider artifact, not a
 *      confirmed catch-all server.
 *   2. Evidence: even for other providers, if Hunter has ≥3 personal emails
 *      indexed for this domain, real mailboxes clearly exist there.
 *      Accepting as 'risky' lets us send with care rather than discarding
 *      a domain that has proven human presence.
 *
 * @param {string} hunterStatus
 * @param {string} provider  — from detectMailProvider()
 * @param {number|null} [personalCount] — personal email count from email-count endpoint
 */
export function interpretVerifierStatus(hunterStatus, provider, personalCount = null) {
  const s = String(hunterStatus || '').toLowerCase();
  if (s === 'deliverable' || s === 'valid') return 'verified';
  if (s === 'undeliverable' || s === 'disposable') return 'invalid';
  if (s === 'accept_all') {
    // Google / M365 / Cloudflare habitually answer 250 OK to any RCPT.
    if (provider === 'google' || provider === 'microsoft' || provider === 'cloudflare') {
      return 'risky';
    }
    // For other providers, if Hunter has indexed ≥3 personal emails for
    // this domain, real mailboxes exist — treat as risky, not invalid.
    if (personalCount != null && personalCount >= 3) return 'risky';
    return 'invalid';
  }
  // webmail / risky / unknown / anything else
  return 'risky';
}
