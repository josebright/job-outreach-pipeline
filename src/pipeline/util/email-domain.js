// util/email-domain.js
// Validation for anything we are about to treat as a company mail domain.
//
// Node's WHATWG URL parser is far more permissive than DNS. new URL('https://&')
// parses cleanly and reports hostname "&", so deriveDomain happily returned "&"
// for any company row whose website column held junk, and the pattern probe
// then built founders@& - six of which reached the approved queue and would
// every one of them have bounced.
//
// Careers subdomains are a second, quieter failure. jobs.dropbox.com is a
// perfectly real hostname, so it passes every syntactic check, but nobody reads
// mail there and Hunter has no emails indexed on it - which also meant the
// company's size never resolved and a 3,000-person company walked through the
// 2-500 employee gate as "unknown".

// Subdomains that front an ATS or careers page rather than the company's mail.
const CAREERS_SUBDOMAINS = [
  'jobs', 'job', 'careers', 'career', 'apply', 'applications', 'boards',
  'talent', 'hire', 'hiring', 'recruiting', 'recruit', 'work', 'workwith',
];

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * True when `host` looks like a real, public, mail-capable domain: at least
 * two labels, each syntactically valid, and an alphabetic TLD of 2+ chars.
 * Deliberately syntactic only - DNS/MX checking lives in domain-guess.js.
 */
export function isPlausibleDomain(host) {
  if (!host) return false;
  const h = String(host).trim().toLowerCase().replace(/\.$/, '');
  if (!h || h.length > 253) return false;
  if (h.includes('..') || h.includes('@') || h.includes(' ')) return false;

  const labels = h.split('.');
  if (labels.length < 2) return false;                 // "&", "localhost"
  if (!labels.every(l => LABEL.test(l))) return false; // "&", "foo_bar", ""

  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld)) return false;          // numeric or 1-char TLD
  return true;
}

/**
 * Strip www. and any leading careers/ATS subdomain, returning the domain we
 * should actually use for mail and for Hunter lookups. Returns null when the
 * input is not a plausible domain at all.
 *
 *   "www.acme.io"          -> "acme.io"
 *   "jobs.dropbox.com"     -> "dropbox.com"
 *   "careers.acme.co.uk"   -> "acme.co.uk"
 *   "&"                    -> null
 */
export function normalizeCompanyDomain(host) {
  if (!host) return null;
  let h = String(host).trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  // Peel repeated careers-ish prefixes, but never strip down to a bare
  // registrable pair or less (careers.io must not become "io").
  let guard = 0;
  while (guard++ < 3) {
    const labels = h.split('.');
    if (labels.length <= 2) break;
    if (!CAREERS_SUBDOMAINS.includes(labels[0])) break;
    h = labels.slice(1).join('.');
  }
  return isPlausibleDomain(h) ? h : null;
}

// Intentionally strict but not RFC-exhaustive: one @, a non-empty local part
// with no whitespace or angle brackets, and a plausible domain on the right.
export function isValidEmail(email) {
  if (!email) return false;
  const s = String(email).trim();
  if (/[\s<>,;"()[\]\\]/.test(s)) return false;
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return false;
  const local = s.slice(0, at);
  if (local.length > 64 || /^\.|\.$|\.\./.test(local)) return false;
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  return isPlausibleDomain(s.slice(at + 1));
}

/**
 * True when the address sits on a careers/ATS subdomain of the company
 * (founders@jobs.dropbox.com). It is syntactically valid and not on an ATS
 * vendor's host, so neither isValidEmail nor isAtsEmail catches it - but nobody
 * reads mail there. Pre-fix enrichment created these and they are still in the
 * database, attached to live drafts.
 */
export function isCareersSubdomainEmail(email) {
  if (!isValidEmail(email)) return false;
  const s = String(email).trim().toLowerCase();
  const host = s.slice(s.lastIndexOf('@') + 1).replace(/^www\./, '');
  const normalized = normalizeCompanyDomain(host);
  return Boolean(normalized) && normalized !== host;
}

// Personal / free mailbox providers. Two people at gmail.com are not one
// company, so company-level duplicate checks must never group addresses by
// these domains.
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'gmx.de', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru',
  'hey.com', 'fastmail.com',
]);

export function emailDomainOf(email) {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at > 0 && at < s.length - 1 ? s.slice(at + 1) : null;
}

export function isFreeMailDomain(domain) {
  return FREE_MAIL_DOMAINS.has(String(domain || '').trim().toLowerCase());
}
