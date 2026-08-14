// ingest/ats/ashby.js
// Ashby public job board API. No auth.
// Endpoint: https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
// Returns { jobs: [...] }.
import { http, hostLimiter } from '../../util/http.js';
import { makeUnknownJob } from './interface.js';
import { htmlToText, classifyWorkplace, classifyRemoteScope, detectCurrency } from './classify.js';

export const name = 'ashby';
export const discoveryHost = 'jobs.ashbyhq.com';
const API_HOST = 'api.ashbyhq.com';
const limit = hostLimiter(API_HOST, 1);

function endpoint(slug) {
  return `https://${API_HOST}/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
}

export async function probe(slug) {
  try {
    const res = await limit(() => http.get(endpoint(slug), { validateStatus: s => s < 500 }));
    if (res.status !== 200) return { alive: false };
    if (!res.data?.jobs) return { alive: false };
    return { alive: true, companyName: res.data.name || prettifySlug(slug) };
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

  const html = raw.descriptionHtml || raw.description || '';
  const text = htmlToText(html);
  const location = raw.location || raw.locationName || null;

  // Ashby has explicit isRemote and secondaryLocations. Use them when set.
  const workplace = raw.isRemote === true ? 'remote'
    : classifyWorkplace(location, text);

  const compRaw = raw.compensation ? JSON.stringify(raw.compensation) : null;
  const currencyFromComp = raw.compensation?.summaryComponents?.find(c => c.currencyCode)?.currencyCode || null;

  const postedAt = raw.publishedDate || raw.publishedAt || null;
  const updatedAt = raw.updatedAt || postedAt;

  return makeUnknownJob({
    externalJobId: String(raw.id),
    title: raw.title || null,
    department: raw.department || raw.team || null,
    locationRaw: location,
    workplaceType: workplace,
    remoteScope: classifyRemoteScope(location, text),
    currencySignal: currencyFromComp || detectCurrency(text, compRaw),
    compRaw,
    descriptionText: text || null,
    url: raw.jobUrl || raw.applicationUrl || null,
    postedAt,
    updatedAtSource: updatedAt,
  });
}

function prettifySlug(slug) {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
