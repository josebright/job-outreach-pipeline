// discover/aggregators/remoteok.js
// RemoteOK public API. Requires a User-Agent header.
// https://remoteok.com/api  ->  first array element is a legal notice.
import { http, hostLimiter } from '../../util/http.js';
import { hintFromUrl } from './remotive.js';

export const source = 'remoteok';
const API_HOST = 'remoteok.com';
const limit = hostLimiter(API_HOST, 1);
const ENDPOINT = `https://${API_HOST}/api`;

// RemoteOK rejects generic bots. Send a clear identifier.
const HEADERS = { 'User-Agent': 'job-outreach-pipeline/3.0 (personal job search)' };

// Tags that indicate the posting is for a software role.
const DEV_TAGS = new Set([
  'dev', 'engineer', 'backend', 'frontend', 'fullstack', 'full-stack', 'software',
  'nodejs', 'node', 'python', 'react', 'typescript', 'javascript', 'devops',
]);

export async function fetchCompanies({ maxJobs = 200 } = {}) {
  const res = await limit(() => http.get(ENDPOINT, {
    headers: HEADERS,
    validateStatus: s => s < 500,
  }));
  if (res.status !== 200 || !Array.isArray(res.data)) return [];

  // Drop the legal notice at index 0.
  const jobs = res.data.slice(1, maxJobs + 1);

  const seen = new Map();
  for (const j of jobs) {
    if (!looksLikeSoftware(j)) continue;
    const name = (j.company || '').trim();
    if (!name) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.set(name.toLowerCase(), {
      companyName: name,
      url: j.apply_url || j.url || null,
      source,
      hint: hintFromUrl(j.apply_url || j.url),
    });
  }
  return [...seen.values()];
}

function looksLikeSoftware(j) {
  const tags = Array.isArray(j.tags) ? j.tags.map(t => String(t).toLowerCase()) : [];
  if (tags.some(t => DEV_TAGS.has(t))) return true;
  const pos = String(j.position || '').toLowerCase();
  return /\b(engineer|developer|software|backend|frontend|full ?stack)\b/.test(pos);
}
