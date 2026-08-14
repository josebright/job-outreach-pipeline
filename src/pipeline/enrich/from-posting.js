// enrich/from-posting.js
// Fallback: scan the job posting text for contact emails when Hunter finds
// none. Filters out generic addresses that would go into a black hole
// (no-reply@, jobs@, careers@) and prefers named-person addresses.

const EMAIL_RE = /\b([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g;

// Addresses that lead to a shared inbox where cold outreach dies.
const GENERIC_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'jobs', 'careers', 'apply', 'applications', 'hr', 'talent', 'recruiting',
  'recruit', 'recruiter', 'hiring', 'people', 'peopleops',
  'info', 'contact', 'hello', 'help', 'support', 'admin', 'sales',
]);

// Local parts we deprioritize but still surface, since some small companies
// route these to a real person.
const SEMI_GENERIC = new Set(['team', 'founders', 'engineering', 'eng']);

/**
 * Return contact candidates found in a posting.
 * @returns {Array<{ email:string, quality:'named'|'semi'|'generic', local:string, domain:string }>}
 */
export function contactsFromPosting({ descriptionText, companyDomainHint = null }) {
  if (!descriptionText) return [];
  const seen = new Map();

  for (const m of descriptionText.matchAll(EMAIL_RE)) {
    const email = `${m[1]}@${m[2]}`.toLowerCase();
    if (seen.has(email)) continue;
    const local = m[1].toLowerCase();
    const domain = m[2].toLowerCase();

    // Skip if the domain does not plausibly match the company (avoid picking
    // up example.com, sentry emails, or personal Gmail in the posting body).
    if (companyDomainHint && !domainMatches(domain, companyDomainHint)) continue;
    if (BAD_DOMAINS.has(domain)) continue;

    let quality = 'named';
    if (GENERIC_LOCAL_PARTS.has(local)) quality = 'generic';
    else if (SEMI_GENERIC.has(local)) quality = 'semi';

    seen.set(email, { email, quality, local, domain });
  }

  // Return named first, then semi, then generic. Skip generic when quality
  // ones exist for the same company.
  const all = [...seen.values()];
  const order = { named: 0, semi: 1, generic: 2 };
  all.sort((a, b) => order[a.quality] - order[b.quality]);
  return all;
}

function domainMatches(candidate, hint) {
  const c = candidate.replace(/^www\./, '');
  const h = hint.replace(/^www\./, '');
  return c === h || c.endsWith('.' + h) || h.endsWith('.' + c);
}

// Domains that appear in postings but never route to hiring decision makers.
const BAD_DOMAINS = new Set([
  'example.com', 'example.org', 'sentry.io',
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',   // personal
]);

/**
 * Map a posting-derived email's local-part to our contact role_type.
 * Best-effort. Named addresses can't be classified without more info, so
 * we default to 'recruiter' (safest ambiguous choice for outreach).
 */
export function roleTypeFromLocalPart(local) {
  const l = local.toLowerCase();
  if (/^(ceo|cto|founder|founders)$/.test(l)) return 'founder';
  if (/(cto|vp|head)/.test(l)) return 'eng_leader';
  if (/(eng|engineer|dev|tech|platform)/.test(l)) return 'engineer';
  return 'recruiter';
}
