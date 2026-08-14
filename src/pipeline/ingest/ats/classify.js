// ingest/ats/classify.js
// Shared classifiers used by every ATS client to normalize job posting fields.
// Kept small and deterministic so it can be tuned in one place.
import * as cheerio from 'cheerio';

const LOC = s => (s || '').toLowerCase();

export function htmlToText(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  return $.root().text().replace(/\s+/g, ' ').trim();
}

export function classifyWorkplace(location, text) {
  const l = LOC(location);
  const t = LOC(text);
  if (l.includes('remote') || t.includes('fully remote') || t.includes('100% remote')) return 'remote';
  if (l.includes('hybrid') || t.includes('hybrid')) return 'hybrid';
  if (l && !l.includes('remote')) return 'onsite';
  return 'unknown';
}

export function classifyRemoteScope(location, text) {
  const s = `${LOC(location)} ${LOC(text)}`;
  if (/(worldwide|anywhere|global(ly)?|remote - anywhere)/.test(s)) return 'worldwide';
  if (/(us only|united states only|remote \(us\)|us timezones only)/.test(s)) return 'us_only';
  if (/africa/.test(s)) return 'africa';
  if (/emea/.test(s)) return 'emea';
  if (/\bremote\b/.test(s)) return 'unknown';
  if (LOC(location) && !LOC(location).includes('remote')) return 'onsite';
  return 'unknown';
}

export function detectCurrency(text, compRaw = null) {
  const s = `${text || ''} ${compRaw || ''}`;
  if (!s.trim()) return null;
  if (/\$\s?\d|\bUSD\b/.test(s)) return 'USD';
  if (/€\s?\d|\bEUR\b/.test(s)) return 'EUR';
  if (/£\s?\d|\bGBP\b/.test(s)) return 'GBP';
  return null;
}

// Turn a company display name into candidate ATS slug guesses.
// Aggregator feeds only give us the display name; we try each guess against
// each ATS's API and take the first that returns 200.
export function slugCandidates(companyName) {
  if (!companyName) return [];
  const cleaned = companyName
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,'"()!?]/g, '')
    .replace(/\b(inc|llc|ltd|gmbh|sarl|bv|s\.a)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const collapsed = cleaned.replace(/\s+/g, '');
  const hyphenated = cleaned.replace(/\s+/g, '-');
  const underscored = cleaned.replace(/\s+/g, '_');
  const firstWord = cleaned.split(' ')[0];

  return [...new Set([collapsed, hyphenated, underscored, firstWord].filter(Boolean))];
}
