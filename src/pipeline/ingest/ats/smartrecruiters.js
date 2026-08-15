// ingest/ats/smartrecruiters.js
// SmartRecruiters public postings API. No auth.
// Endpoint: https://api.smartrecruiters.com/v1/companies/{slug}/postings
// Returns { offset, limit, totalFound, content: [...] }.
// Each posting also exposes a detail URL: /companies/{slug}/postings/{id}.
// We fetch detail lazily for the top N per company (same pattern as Workable)
// to pull the description body. Content is HTML.
import { http, hostLimiter } from '../../util/http.js';
import { makeUnknownJob } from './interface.js';
import { htmlToText, classifyWorkplace, classifyRemoteScope, detectCurrency } from './classify.js';

export const name = 'smartrecruiters';
export const discoveryHost = 'jobs.smartrecruiters.com';
const API_HOST = 'api.smartrecruiters.com';
const limit = hostLimiter(API_HOST, 1);

function listEndpoint(slug) {
  return `https://${API_HOST}/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`;
}
function detailEndpoint(slug, postingId) {
  return `https://${API_HOST}/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(postingId)}`;
}

export async function probe(slug) {
  try {
    const res = await limit(() => http.get(listEndpoint(slug), { validateStatus: s => s < 500 }));
    if (res.status !== 200) return { alive: false };
    if (!Array.isArray(res.data?.content)) return { alive: false };
    const companyName = res.data.content?.[0]?.company?.name || prettifySlug(slug);
    return { alive: true, companyName };
  } catch {
    return { alive: false };
  }
}

export async function fetchJobs(slug, { maxDetail = 20 } = {}) {
  const res = await limit(() => http.get(listEndpoint(slug), { validateStatus: s => s < 500 }));
  if (res.status !== 200) return [];
  const list = res.data?.content || [];
  if (list.length === 0) return [];

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    let detail = null;
    if (i < maxDetail && raw.id) {
      try {
        const dres = await limit(() => http.get(detailEndpoint(slug, raw.id), { validateStatus: s => s < 500 }));
        if (dres.status === 200) detail = dres.data;
      } catch { /* keep going */ }
    }
    const job = normalize(raw, detail);
    if (job) out.push(job);
  }
  return out;
}

export function normalize(raw, detail = null) {
  if (!raw?.id) return null;

  const location = [raw.location?.city, raw.location?.region, raw.location?.country]
    .filter(Boolean).join(', ') || null;
  const remoteHint = raw.location?.remote === true;

  // Description is on the detail response under jobAd.sections.{jobDescription,qualifications,additionalInformation}
  const parts = [];
  if (detail?.jobAd?.sections) {
    for (const key of ['jobDescription', 'qualifications', 'additionalInformation']) {
      const s = detail.jobAd.sections[key];
      if (s?.text) parts.push(htmlToText(s.text));
    }
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();

  const workplace = remoteHint ? 'remote' : classifyWorkplace(location, text);
  const currency = detectCurrency(text, detail?.compensation?.description);

  const postedAt = raw.releasedDate || raw.createdOn || null;

  return makeUnknownJob({
    externalJobId: String(raw.id),
    title: raw.name || null,
    department: raw.department?.label || null,
    locationRaw: location,
    workplaceType: workplace,
    remoteScope: classifyRemoteScope(location, text),
    currencySignal: currency,
    compRaw: detail?.compensation?.description || null,
    descriptionText: text || null,
    url: raw.ref || detail?.actions?.apply?.url || null,
    postedAt,
    updatedAtSource: raw.releasedDate || postedAt,
  });
}

function prettifySlug(slug) {
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
