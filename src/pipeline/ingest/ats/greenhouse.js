// ingest/ats/greenhouse.js
// Greenhouse Job Board API. Public, no auth. One request per board fetches all jobs.
// Docs: https://developers.greenhouse.io/job-board.html
import { http, hostLimiter } from '../../util/http.js';
import { makeUnknownJob } from './interface.js';
import { htmlToText, classifyWorkplace, classifyRemoteScope, detectCurrency } from './classify.js';

export const name = 'greenhouse';
export const discoveryHost = 'boards.greenhouse.io';
const API_HOST = 'boards-api.greenhouse.io';
const limit = hostLimiter(API_HOST, 1);

function endpoint(slug) {
  return `https://${API_HOST}/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
}

export async function probe(slug) {
  try {
    const res = await limit(() => http.get(endpoint(slug), { validateStatus: s => s < 500 }));
    if (res.status !== 200) return { alive: false };
    return { alive: true, companyName: prettifySlug(slug) };
  } catch {
    return { alive: false };
  }
}

export async function fetchJobs(slug) {
  const res = await limit(() => http.get(endpoint(slug), { validateStatus: s => s < 500 }));
  if (res.status !== 200) return [];
  const jobs = res.data?.jobs || [];
  return jobs.map(normalize).filter(Boolean);
}

export function normalize(raw) {
  if (!raw?.id) return null;
  const html = raw.content || '';
  const text = htmlToText(html);
  const location = raw.location?.name || null;

  return makeUnknownJob({
    externalJobId: String(raw.id),
    title: raw.title || null,
    department: (raw.departments?.[0]?.name) || null,
    locationRaw: location,
    workplaceType: classifyWorkplace(location, text),
    remoteScope: classifyRemoteScope(location, text),
    currencySignal: detectCurrency(text),
    compRaw: null,
    descriptionText: text || null,
    url: raw.absolute_url || null,
    postedAt: raw.updated_at || null,
    updatedAtSource: raw.updated_at || null,
  });
}

function prettifySlug(slug) {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Re-exported for the existing test file that imports from this module.
export { classifyWorkplace, classifyRemoteScope, detectCurrency };
