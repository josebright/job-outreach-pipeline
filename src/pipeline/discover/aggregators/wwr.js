// discover/aggregators/wwr.js
// We Work Remotely RSS feed for the programming category. No auth.
// https://weworkremotely.com/categories/remote-programming-jobs.rss
//
// Each RSS <item> IS a job posting. Title = "Company: Role Title".
// Description is HTML with the JD body. Region gives location. We emit
// the full job so discover can insert it directly (ats='external').
import { http, hostLimiter } from '../../util/http.js';

export const source = 'wwr';
const HOST = 'weworkremotely.com';
const limit = hostLimiter(HOST, 1);

const FEED_URL = `https://${HOST}/categories/remote-programming-jobs.rss`;

export async function fetchCompanies({ maxItems = 200 } = {}) {
  const res = await limit(() => http.get(FEED_URL, {
    responseType: 'text', validateStatus: s => s < 500,
  }));
  if (res.status !== 200) return [];
  const xml = String(res.data || '');
  const items = extractItems(xml).slice(0, maxItems);

  const seen = new Map();
  for (const it of items) {
    const name = parseCompanyFromTitle(it.title);
    if (!name) continue;
    const key = name.toLowerCase();
    // For the same company across multiple listings, take the first
    // (freshest — RSS is chronological, newest first) and merge extra
    // jobs into the same candidate.
    const role = parseRoleFromTitle(it.title) || 'Unspecified role';
    const jobEntry = {
      title: role,
      description: stripHtml(it.description || ''),
      location: it.region || null,
      url: it.link || null,
      externalJobId: `wwr:${hashString(it.link || it.title)}`,
    };
    if (seen.has(key)) {
      seen.get(key).jobs.push(jobEntry);
      continue;
    }
    seen.set(key, {
      companyName: name,
      source,
      hint: null,
      website: null,
      jobs: [jobEntry],
    });
  }
  return [...seen.values()];
}

/** RSS titles are "Company: Role Title". Company is the part before the first colon. */
export function parseCompanyFromTitle(title) {
  if (!title) return null;
  const t = String(title).trim();
  const idx = t.indexOf(':');
  if (idx <= 0) return null;
  const name = t.slice(0, idx).trim();
  if (name.length < 2 || name.length > 60) return null;
  return name;
}

/** Role is the part after the first colon in the title. */
export function parseRoleFromTitle(title) {
  if (!title) return null;
  const t = String(title).trim();
  const idx = t.indexOf(':');
  if (idx <= 0) return null;
  const role = t.slice(idx + 1).trim();
  return role || null;
}

/**
 * Naive RSS <item> extractor. Good enough for a fixed, well-formed feed.
 * Returns [{title, link, description, region}].
 */
function extractItems(xml) {
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  for (const m of xml.matchAll(itemRe)) {
    const block = m[1];
    const title = tag(block, 'title');
    const link  = tag(block, 'link');
    const description = tag(block, 'description');
    const region = tag(block, 'region');
    if (title) out.push({ title, link, description, region });
  }
  return out;
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashString(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
