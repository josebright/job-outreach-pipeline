// discover/aggregators/wwr.js
// We Work Remotely RSS feed for the programming category. No auth.
// https://weworkremotely.com/categories/remote-programming-jobs.rss
//
// The RSS <title> field is formatted as "Company: Role Title".
// The <link> takes us to the WWR job page (not an ATS), so we can't
// pull a slug hint directly — the caller's resolveSlug will still
// probe by company name.
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
    if (seen.has(key)) continue;
    seen.set(key, {
      companyName: name,
      url: it.link || null,
      source,
      hint: null,
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

/**
 * Naive RSS <item> extractor. Good enough for a fixed, well-formed feed.
 * Returns [{title, link}].
 */
function extractItems(xml) {
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  for (const m of xml.matchAll(itemRe)) {
    const block = m[1];
    const title = tag(block, 'title');
    const link  = tag(block, 'link');
    if (title) out.push({ title, link });
  }
  return out;
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}
