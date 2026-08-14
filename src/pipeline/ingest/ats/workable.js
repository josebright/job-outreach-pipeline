// ingest/ats/workable.js
// Workable widget API. No auth.
// Endpoint: https://apply.workable.com/api/v1/widget/accounts/{slug}
// Returns { name, description, jobs: [...] }.
// Job listing here is compact; each job's full description requires a follow-up
// call to https://apply.workable.com/api/v3/accounts/{slug}/jobs/{shortcode}
// which we do lazily inside fetchJobs.
import { http, hostLimiter } from '../../util/http.js';
import { makeUnknownJob } from './interface.js';
import { htmlToText, classifyWorkplace, classifyRemoteScope, detectCurrency } from './classify.js';

export const name = 'workable';
export const discoveryHost = 'apply.workable.com';
const API_HOST = 'apply.workable.com';
const limit = hostLimiter(API_HOST, 1);

function widgetEndpoint(slug) {
  return `https://${API_HOST}/api/v1/widget/accounts/${encodeURIComponent(slug)}`;
}

function detailEndpoint(slug, shortcode) {
  return `https://${API_HOST}/api/v3/accounts/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(shortcode)}`;
}

export async function probe(slug) {
  try {
    const res = await limit(() => http.get(widgetEndpoint(slug), { validateStatus: s => s < 500 }));
    if (res.status !== 200) return { alive: false };
    if (!Array.isArray(res.data?.jobs)) return { alive: false };
    return { alive: true, companyName: res.data?.name || prettifySlug(slug) };
  } catch {
    return { alive: false };
  }
}

export async function fetchJobs(slug, { withDetails = true, maxDetail = 25 } = {}) {
  const res = await limit(() => http.get(widgetEndpoint(slug), { validateStatus: s => s < 500 }));
  if (res.status !== 200) return [];
  const listing = res.data?.jobs || [];
  if (listing.length === 0) return [];

  const normalized = listing.map(j => normalize(j, null));

  if (!withDetails) return normalized;

  // Fetch full description for at most maxDetail jobs per company to stay polite.
  // Older jobs beyond the cap keep the summary from the widget listing.
  const enriched = [];
  for (let i = 0; i < normalized.length; i++) {
    const j = normalized[i];
    const shortcode = listing[i]?.shortcode;
    if (i < maxDetail && shortcode) {
      try {
        const detail = await limit(() => http.get(detailEndpoint(slug, shortcode), { validateStatus: s => s < 500 }));
        if (detail.status === 200 && detail.data) {
          enriched.push(mergeDetail(j, detail.data));
          continue;
        }
      } catch { /* fall through, keep summary */ }
    }
    enriched.push(j);
  }
  return enriched;
}

export function normalize(raw, detail = null) {
  if (!raw?.id && !raw?.shortcode) return null;

  const id = String(raw.id || raw.shortcode);
  const location = raw.location?.location_str
    || [raw.location?.city, raw.location?.country].filter(Boolean).join(', ')
    || raw.city
    || null;

  const summary = raw.description || raw.summary || '';
  const summaryText = htmlToText(summary);
  const workplace = raw.remote === true ? 'remote' : classifyWorkplace(location, summaryText);

  const url = raw.application_url || raw.url || raw.shortlink || null;
  const postedAt = raw.published_on || raw.created_at || null;

  const base = makeUnknownJob({
    externalJobId: id,
    title: raw.title || null,
    department: raw.department || null,
    locationRaw: location,
    workplaceType: workplace,
    remoteScope: classifyRemoteScope(location, summaryText),
    currencySignal: detectCurrency(summaryText),
    descriptionText: summaryText || null,
    url,
    postedAt,
    updatedAtSource: postedAt,
  });

  if (detail) return mergeDetail(base, detail);
  return base;
}

function mergeDetail(job, detail) {
  const detailHtml = detail.description || '';
  const detailText = htmlToText(detailHtml);
  const combined = [job.descriptionText, detailText].filter(Boolean).join(' ').trim();
  const compRaw = detail.salary ? JSON.stringify(detail.salary) : job.compRaw;
  const currency = detail.salary?.currency || job.currencySignal || detectCurrency(combined, compRaw);
  return {
    ...job,
    descriptionText: combined || job.descriptionText,
    compRaw,
    currencySignal: currency,
  };
}

function prettifySlug(slug) {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
