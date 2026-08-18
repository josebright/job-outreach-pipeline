// discover/aggregators/hn.js
// Hacker News "Ask HN: Who is hiring?" monthly thread.
//
// Design: each top-level comment IS a job posting. Company name is the
// first pipe-separated field; role is the second; location/remote/stack
// follow. The rest of the comment body is the description. There is no
// need to look up an ATS slug — the comment already contains everything
// we need to insert a company + job directly (ats='external', bypassing
// the ATS resolution step that was throwing out ~97% of HN candidates).
import { http, hostLimiter } from '../../util/http.js';
import { hintFromUrl } from './remotive.js';

export const source = 'hn';
const SEARCH_HOST = 'hn.algolia.com';
const limit = hostLimiter(SEARCH_HOST, 1);

const SEARCH_URL = 'https://hn.algolia.com/api/v1/search_by_date' +
  '?tags=story,author_whoishiring&hitsPerPage=5';
const ITEM_URL = id => `https://hn.algolia.com/api/v1/items/${id}`;

/**
 * @returns {Promise<Array<{
 *   companyName: string,
 *   source: string,
 *   hint: object|null,
 *   website: string|null,
 *   jobs: Array<{ title:string, description:string, location:string|null, url:string|null, externalJobId:string }>
 * }>>}
 */
export async function fetchCompanies({ maxComments = 500 } = {}) {
  const storyId = await latestHiringStoryId();
  if (!storyId) return [];

  const res = await limit(() => http.get(ITEM_URL(storyId), { validateStatus: s => s < 500 }));
  if (res.status !== 200) return [];

  const seen = new Map();   // dedup by lowercased company name
  const children = Array.isArray(res.data?.children) ? res.data.children.slice(0, maxComments) : [];

  for (const c of children) {
    const parsed = parseHiringComment(c.text || '');
    if (!parsed) continue;

    const url = firstUrlFromHtml(c.text || '');
    const hint = hintFromUrl(url);
    const key = parsed.companyName.toLowerCase();
    if (seen.has(key)) continue;

    const website = websiteFromUrl(url);
    const externalJobId = `hn:${storyId}:${c.id || key}`;

    seen.set(key, {
      companyName: parsed.companyName,
      source,
      hint,
      website,
      jobs: [{
        title: parsed.title || 'Unspecified role',
        description: parsed.description || parsed.raw,
        location: parsed.location || null,
        url: url || null,
        externalJobId,
      }],
    });
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
 * Parse an HN "Who is hiring" comment into a structured job posting.
 * Format used by the community since ~2015:
 *   COMPANY | ROLE | LOCATION | REMOTE/ONSITE | Stack: ...
 *   Description paragraph
 *   Apply: <link>
 *
 * Returns { companyName, title, location, description, raw } or null
 * if the first line doesn't look like a legit company post (meta
 * comments, quoted replies, etc.).
 *
 * Exported for tests.
 */
export function parseHiringComment(htmlText) {
  if (!htmlText) return null;

  // Decode HTML entities + strip tags into plain text with paragraph breaks.
  const plain = String(htmlText)
    .replace(/<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .trim();

  const lines = plain.split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const firstLine = lines[0];
  const description = lines.slice(1).join('\n\n').trim();

  // Skip obvious meta comments.
  if (firstLine.startsWith('>')) return null;
  if (/^(please|note|reminder|thanks|thank you|edit|announcement)\b/i.test(firstLine)) return null;

  // Split first line on pipes / em-dashes / middle-dot / colon-space.
  const fields = firstLine.split(/(?:\s+[|\-–—·]\s+)|(?::\s+)/).map(f => f.trim()).filter(Boolean);
  if (fields.length === 0) return null;

  const companyName = fields[0];
  if (companyName.length < 2 || companyName.length > 80) return null;
  if (companyName.split(/\s+/).length > 6) return null;   // long sentence, not a name

  // Role is the second field if it looks like a job title (contains
  // "engineer", "developer", "designer", "manager", "founding", etc).
  const roleField = fields[1] || '';
  const looksLikeRole = /\b(engineer|developer|designer|manager|founding|scientist|architect|lead|swe|analyst|researcher|product|marketer|writer|specialist|principal|staff|senior|junior|intern|director|head|vp)\b/i.test(roleField);
  const title = looksLikeRole ? roleField : '';

  // Location: any field containing REMOTE / a city / a country / a timezone.
  const location = fields.slice(1).find(f =>
    /\b(remote|onsite|hybrid|worldwide|anywhere|us|uk|eu|emea|london|new york|nyc|sf|san francisco|berlin|amsterdam|toronto|remote-first)\b/i.test(f)
  ) || null;

  return { companyName, title, location, description, raw: firstLine };
}

function firstUrlFromHtml(html) {
  const m = String(html || '').match(/href="([^"]+)"/i);
  return m ? m[1] : null;
}

function websiteFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch { return null; }
}
