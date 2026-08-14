// discover/aggregators/remotive.js
// Remotive public API. No auth.
// https://remotive.com/api/remote-jobs?category=software-dev
import { http, hostLimiter } from '../../util/http.js';

export const source = 'remotive';
const API_HOST = 'remotive.com';
const limit = hostLimiter(API_HOST, 1);

const CATEGORY = 'software-dev';
const ENDPOINT = `https://${API_HOST}/api/remote-jobs?category=${CATEGORY}`;

export async function fetchCompanies({ maxJobs = 200 } = {}) {
  const res = await limit(() => http.get(ENDPOINT, { validateStatus: s => s < 500 }));
  if (res.status !== 200 || !Array.isArray(res.data?.jobs)) return [];

  const seen = new Map();
  for (const j of res.data.jobs.slice(0, maxJobs)) {
    const name = (j.company_name || '').trim();
    if (!name) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.set(name.toLowerCase(), {
      companyName: name,
      url: j.url || null,
      source,
      hint: hintFromUrl(j.url),
    });
  }
  return [...seen.values()];
}

// Extract (ats, slug) from a job URL when it points at a known ATS.
export function hintFromUrl(url) {
  if (!url) return null;
  const patterns = [
    { ats: 'greenhouse', re: /boards\.greenhouse\.io\/([a-z0-9-]+)/i },
    { ats: 'lever',      re: /jobs\.lever\.co\/([a-z0-9-]+)/i },
    { ats: 'ashby',      re: /jobs\.ashbyhq\.com\/([a-z0-9-]+)/i },
    { ats: 'workable',   re: /apply\.workable\.com\/([a-z0-9-]+)/i },
  ];
  for (const { ats, re } of patterns) {
    const m = url.match(re);
    if (m && m[1]) return { ats, slug: m[1].toLowerCase() };
  }
  return null;
}
