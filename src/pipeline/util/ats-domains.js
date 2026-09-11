// util/ats-domains.js
// Hostnames belonging to applicant-tracking systems, job boards and
// aggregators — never to the hiring company itself.
//
// Two consumers, one list:
//   1. enrich/deriveDomain — a job URL on one of these hosts tells us
//      nothing about the employer's real mail domain, so it must not be
//      used as the enrichment domain.
//   2. send/sendApprovedDraft — an address at one of these hosts is always
//      a pattern-probe artifact (founders@api.smartrecruiters.com), never a
//      real inbox. Sending to one guarantees a bounce, and enough bounces
//      trip the alarm that pauses the whole pipeline.
//
// Matched as a domain suffix, so "api.smartrecruiters.com",
// "jobs.smartrecruiters.com" and "smartrecruiters.com" all match the single
// "smartrecruiters.com" entry.
export const ATS_DOMAINS = [
  // ATS platforms we ingest from directly (config.discover.ats_platforms).
  // api.smartrecruiters.com was the live leak: the SmartRecruiters adapter
  // stores raw.ref as the job URL, which is an api.smartrecruiters.com
  // address, and deriveDomain happily treated it as the employer domain.
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'workable.com',
  'smartrecruiters.com',

  // Other ATS hosts that turn up via aggregator feeds.
  'bamboohr.com', 'breezy.hr', 'recruitee.com', 'teamtailor.com',
  'jazzhr.com', 'jobvite.com', 'icims.com', 'taleo.net',
  'myworkdayjobs.com', 'workday.com', 'successfactors.com',
  'personio.de', 'personio.com', 'pinpointhq.com', 'rippling.com',
  'applytojob.com', 'paylocity.com', 'dayforcehcm.com', 'gh.io',

  // Job boards / aggregators (our own discovery sources included).
  'remotive.com', 'remoteok.com', 'remoteok.io', 'weworkremotely.com',
  'ycombinator.com', 'indeed.com', 'linkedin.com', 'glassdoor.com',
  'angel.co', 'wellfound.com', 'builtin.com', 'dice.com', 'monster.com',
  'ziprecruiter.com', 'otta.com', 'himalayas.app', 'jobs.ashbyhq.com',

  // Shorteners that occasionally land in job feeds.
  'bit.ly', 'lnkd.in',
];

const SUFFIXES = ATS_DOMAINS.map(d => d.toLowerCase());

/** True when `hostname` is (or is a subdomain of) a known ATS / job-board host. */
export function isAtsHost(hostname) {
  if (!hostname) return false;
  const h = String(hostname).trim().toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  if (!h) return false;
  return SUFFIXES.some(d => h === d || h.endsWith(`.${d}`));
}

/** True when `email`'s domain is a known ATS / job-board host. */
export function isAtsEmail(email) {
  if (!email) return false;
  const s = String(email).trim();
  const at = s.lastIndexOf('@');
  if (at === -1) return false;
  return isAtsHost(s.slice(at + 1));
}
