// ingest/ats/lever.js
// Lever public postings API. No auth.
// Endpoint: https://api.lever.co/v0/postings/{slug}?mode=json
// Returns an array of postings.
import { http, hostLimiter } from '../../util/http.js';
import { makeUnknownJob } from './interface.js';
import { htmlToText, classifyWorkplace, classifyRemoteScope, detectCurrency } from './classify.js';

export const name = 'lever';
export const discoveryHost = 'jobs.lever.co';
const API_HOST = 'api.lever.co';
const limit = hostLimiter(API_HOST, 1);

function endpoint(slug) {
  return `https://${API_HOST}/v0/postings/${encodeURIComponent(slug)}?mode=json`;
}

export async function probe(slug) {
  try {
    const res = await limit(() => http.get(endpoint(slug), { validateStatus: s => s < 500 }));
    if (res.status !== 200) return { alive: false };
    if (!Array.isArray(res.data)) return { alive: false };
    return { alive: true, companyName: prettifySlug(slug) };
  } catch {
    return { alive: false };
  }
}

export async function fetchJobs(slug) {
  const res = await limit(() => http.get(endpoint(slug), { validateStatus: s => s < 500 }));
  if (res.status !== 200 || !Array.isArray(res.data)) return [];
  return res.data.map(normalize).filter(Boolean);
}

export function normalize(raw) {
  if (!raw?.id) return null;

  // Lever puts description in `descriptionPlain`, `description` (HTML), and
  // sometimes `lists` (bulleted sections). Combine into one text blob.
  const parts = [];
  if (raw.descriptionPlain) parts.push(raw.descriptionPlain);
  else if (raw.description) parts.push(htmlToText(raw.description));
  if (Array.isArray(raw.lists)) {
    for (const l of raw.lists) {
      if (l?.text) parts.push(l.text);
      if (l?.content) parts.push(htmlToText(l.content));
    }
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();

  const location = raw.categories?.location || null;
  const workplaceTypeRaw = (raw.workplaceType || '').toLowerCase(); // 'remote' | 'hybrid' | 'on-site' | ''
  const workplace = workplaceTypeRaw === 'on-site' ? 'onsite'
    : workplaceTypeRaw === 'remote' ? 'remote'
    : workplaceTypeRaw === 'hybrid' ? 'hybrid'
    : classifyWorkplace(location, text);

  const postedAt = raw.createdAt ? new Date(raw.createdAt).toISOString() : null;
  const updatedAt = raw.updatedAt ? new Date(raw.updatedAt).toISOString() : postedAt;

  return makeUnknownJob({
    externalJobId: String(raw.id),
    title: raw.text || null,
    department: raw.categories?.department || raw.categories?.team || null,
    locationRaw: location,
    workplaceType: workplace,
    remoteScope: classifyRemoteScope(location, text),
    currencySignal: detectCurrency(text),
    compRaw: raw.salaryRange ? JSON.stringify(raw.salaryRange) : null,
    descriptionText: text || null,
    url: raw.hostedUrl || raw.applyUrl || null,
    postedAt,
    updatedAtSource: updatedAt,
  });
}

function prettifySlug(slug) {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
