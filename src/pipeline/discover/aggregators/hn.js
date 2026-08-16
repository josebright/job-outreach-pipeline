// discover/aggregators/hn.js
// Hacker News "Ask HN: Who is hiring?" monthly thread.
//
// Why this source: seed-stage founders post here directly (they can't
// afford Greenhouse/Lever). Comments follow a well-known format:
//   COMPANY | ROLE | LOCATION | REMOTE/ONSITE | Stack: ...
//   (with a link to careers page, often an ATS URL we already parse)
//
// Flow:
//   1. Find the latest whoishiring story via Algolia HN search
//   2. Fetch its comment tree
//   3. Walk top-level comments; extract company name + any URL
//   4. Emit { companyName, url, hint } like the other aggregators
//
// No filter is applied here — per applicant's direction, gate 1
// (remote-from-Nigeria) handles remote/US-only decisions downstream.
import { http, hostLimiter } from '../../util/http.js';
import { hintFromUrl } from './remotive.js';   // reuse the ATS URL matcher

export const source = 'hn';
const SEARCH_HOST = 'hn.algolia.com';
const limit = hostLimiter(SEARCH_HOST, 1);

const SEARCH_URL = 'https://hn.algolia.com/api/v1/search_by_date' +
  '?tags=story,author_whoishiring&hitsPerPage=5';

const ITEM_URL = id => `https://hn.algolia.com/api/v1/items/${id}`;

/**
 * @returns {Promise<Array<{companyName:string, url:string|null, source:string, hint:object|null}>>}
 */
export async function fetchCompanies({ maxComments = 500 } = {}) {
  const storyId = await latestHiringStoryId();
  if (!storyId) return [];

  const res = await limit(() => http.get(ITEM_URL(storyId), { validateStatus: s => s < 500 }));
  if (res.status !== 200) return [];

  const seen = new Map();
  const children = Array.isArray(res.data?.children) ? res.data.children.slice(0, maxComments) : [];
  for (const c of children) {
    const parsed = parseHiringComment(c.text || '');
    if (!parsed) continue;

    // Prefer an in-comment ATS URL as the source of a slug hint.
    const url = firstUrlFromHtml(c.text || '');
    const hint = hintFromUrl(url);
    const key = parsed.companyName.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, { companyName: parsed.companyName, url: url || null, source, hint });
  }
  return [...seen.values()];
}

// Find the id of the most recent "Ask HN: Who is hiring?" story.
async function latestHiringStoryId() {
  const res = await limit(() => http.get(SEARCH_URL, { validateStatus: s => s < 500 }));
  if (res.status !== 200) return null;
  const hits = Array.isArray(res.data?.hits) ? res.data.hits : [];
  const hiring = hits.find(h => /who\s+is\s+hiring/i.test(h.title || ''));
  return hiring?.objectID || hits[0]?.objectID || null;
}

/**
 * Parse an HN "Who is hiring" comment into { companyName }.
 * Real comments almost always start with the company name on the first
 * line, followed by "|" or "-" separators. We take the text before the
 * first separator on the first non-empty line.
 * Returns null if we can't confidently extract a name.
 *
 * Exported for tests.
 */
export function parseHiringComment(htmlText) {
  if (!htmlText) return null;
  // Strip HTML tags (HN comment text has <p>, <a>, etc.)
  const plain = String(htmlText)
    .replace(/<p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');  // & last so it doesn't double-decode

  const firstLine = plain.split('\n').map(l => l.trim()).find(Boolean);
  if (!firstLine) return null;

  // Split on |, -, — (em dash), · (middle dot), or a colon.
  // Pipe / dash / em-dash / dot require spaces around them (otherwise
  // "Cal.com" would split on the dot). Colon does NOT require a
  // leading space so we catch "Resend: Product Engineer".
  const rawName = firstLine.split(/(?:\s+[|\-–—·]\s+)|(?::\s+)/)[0].trim();
  if (!rawName) return null;

  // Skip obvious meta comments ("Please respect the format...", quotes)
  if (rawName.length < 2 || rawName.length > 80) return null;
  if (/^(please|note|reminder|thanks|thank you|edit)\b/i.test(rawName)) return null;
  if (rawName.startsWith('>')) return null;

  // A company name shouldn't be one big sentence. Reject if it has many words
  // and no obvious "-" / "|" separator hit.
  if (rawName.split(/\s+/).length > 6) return null;

  return { companyName: rawName };
}

// First URL found in the HTML comment (Algolia HN keeps <a href="..."> anchors).
function firstUrlFromHtml(html) {
  const m = String(html || '').match(/href="([^"]+)"/i);
  return m ? m[1] : null;
}
