// qualify/filters.js
// Q1-Q5 hard filters per PRD section 5, Module 3.
// Each filter returns { pass: boolean, reason: string|null, needsReview?: boolean }.
// A reason is populated whenever the job is not a clean pass.
import { extractAnnualSalary } from './salary.js';

const norm = s => (s || '').toLowerCase();
const compact = s => norm(s).replace(/\s+/g, ' ');

// Role markers that *must* appear in the title. Applicant is a fullstack /
// backend / frontend / product SWE — not an ML/data/platform/SRE specialist.
const ROLE_MARKERS = [
  'software engineer', 'swe',
  'backend engineer', 'back-end engineer', 'back end engineer',
  'frontend engineer', 'front-end engineer', 'front end engineer',
  'fullstack engineer', 'full-stack engineer', 'full stack engineer',
  'full-stack developer', 'full stack developer', 'fullstack developer',
  'backend developer', 'back-end developer', 'back end developer',
  'frontend developer', 'front-end developer', 'front end developer',
  'software developer',
  'product engineer', 'founding engineer', 'founding software engineer',
  'research engineer', 'applied research engineer', 'research software engineer',
  'web engineer', 'mobile engineer',
  'node engineer', 'nodejs engineer', 'node.js engineer',
  'python engineer', 'typescript engineer', 'react engineer',
  'nestjs engineer', 'flutter engineer',
];

// Explicit rejects: engineering-adjacent titles outside the applicant's scope.
// Runs *after* ROLE_MARKERS so titles like "Machine Learning Engineer" that
// pass the "engineer" substring get filtered here.
const REJECT_ROLE_MARKERS = [
  'architect', 'sre', 'site reliability',
  'devops', 'devsecops', 'security engineer',
  'ml engineer', 'machine learning engineer',
  'data engineer', 'data scientist', 'analytics engineer',
  'infrastructure engineer', 'infra engineer',
  'platform engineer', 'platform lead',
  'firmware engineer', 'hardware engineer', 'embedded engineer',
  'qa engineer', 'quality engineer', 'test engineer', 'sdet',
  'sales engineer', 'solutions engineer', 'support engineer',
  'network engineer', 'systems engineer', 'system engineer',
  'ai engineer', 'mlops', 'ai/ml',
];

/**
 * Q1: Role matches profile.
 * - Title/description contains any of config.stack.keywords, AND
 * - Title does NOT contain any config.stack.seniority_reject term.
 * (We treat presence of a seniority_accept term as a bonus, not a hard requirement,
 * since many senior roles say "Software Engineer" without a level word.)
 */
export function q1_roleMatches(job, config) {
  const title = norm(job.title);
  const text = compact(`${job.title || ''} ${job.description_text || ''}`);
  const { keywords, seniority_accept, seniority_reject } = config.stack;

  // Split keywords into ROLE keywords (must appear in title) and STACK
  // keywords (may appear anywhere). Prevents "Demand Generation Lead" from
  // qualifying just because the description happens to mention Python.
  //
  // Scope is deliberately narrow: SWE / backend / frontend / fullstack /
  // product / founding / research-engineer. Roles like architect, SRE,
  // devops, ML/data engineer, platform/infrastructure engineer are dropped
  // because they don't match the applicant's stack focus.
  const titleHasRole = ROLE_MARKERS.some(m => title.includes(m));
  if (!titleHasRole) return { pass: false, reason: 'title_not_engineering' };
  const isReject = REJECT_ROLE_MARKERS.some(m => title.includes(m));
  if (isReject) return { pass: false, reason: 'title_role_out_of_scope' };

  const hasStackKeyword = keywords.some(k => text.includes(norm(k)));
  if (!hasStackKeyword) return { pass: false, reason: 'no_stack_keyword_match' };

  const hasReject = (seniority_reject || []).some(r => wordBoundary(title, norm(r)));
  if (hasReject) {
    // Junior-with-good-pay override: if the posting explicitly states a
    // salary at or above the configured floor, accept the role anyway.
    const floor = config.stack?.junior_override_min_annual || 0;
    if (floor > 0) {
      const salary = extractAnnualSalary({
        compRaw: job.comp_raw,
        descriptionText: job.description_text,
        acceptedCurrencies: config.currency?.accept || ['USD', 'EUR', 'GBP'],
      });
      if (salary && salary.annual >= floor) {
        return { pass: true, reason: null };
      }
    }
    return { pass: false, reason: 'seniority_below_target' };
  }

  return { pass: true, reason: null };
}

/**
 * Q2: Remote-eligible from Nigeria (Track A).
 * - Match against DENY list first (US only, EU citizens only, etc.).
 * - Then ALLOW list (worldwide, EMEA, Africa, anywhere, fully remote).
 * - Neither → needs_review (do not auto-reject).
 * Track B skips this filter (visa/relocation allows onsite).
 */
export function q2_remoteEligible(job, config, track = 'A') {
  if (track === 'B') return { pass: true, reason: null };

  const haystack = compact(`${job.location_raw || ''} ${job.description_text || ''}`);
  const { allow, deny } = config.location;

  for (const d of deny || []) {
    if (haystack.includes(norm(d))) return { pass: false, reason: `location_denied:${d}` };
  }
  for (const a of allow || []) {
    if (haystack.includes(norm(a))) return { pass: true, reason: null };
  }
  // Explicit remote_scope hints from the ATS classifier.
  if (job.remote_scope === 'worldwide' || job.remote_scope === 'emea' || job.remote_scope === 'africa') {
    return { pass: true, reason: null };
  }
  if (job.remote_scope === 'us_only' || job.remote_scope === 'onsite') {
    return { pass: false, reason: `remote_scope:${job.remote_scope}` };
  }
  return { pass: false, needsReview: true, reason: 'location_ambiguous' };
}

/**
 * Q3: Pays USD/EUR/GBP (Track A).
 * Signal cascade, strongest first:
 *   1. Explicit currency signal already set by ATS classifier (currency_signal).
 *   2. HQ country in config.currency.hq_country_currency_map → maps to accepted currency.
 *   3. Description mentions a contractor/EOR signal word (Deel, Remote.com, "hire anywhere"...).
 * No signal at all → needs_review.
 */
export function q3_currencyOK(job, company, config, track = 'A') {
  if (track === 'B') return { pass: true, reason: null };

  const { accept, hq_country_currency_map, contractor_signal_words } = config.currency;
  const acceptSet = new Set(accept);

  if (job.currency_signal && acceptSet.has(job.currency_signal)) {
    return { pass: true, reason: null };
  }

  const hq = (company?.hq_country || '').toUpperCase();
  if (hq && hq_country_currency_map[hq] && acceptSet.has(hq_country_currency_map[hq])) {
    return { pass: true, reason: null };
  }

  const text = norm(`${job.description_text || ''} ${job.comp_raw || ''}`);
  const hasEor = (contractor_signal_words || []).some(w => text.includes(norm(w)));
  if (hasEor) return { pass: true, reason: null };

  return { pass: false, needsReview: true, reason: 'no_currency_signal' };
}

/**
 * Q4: Visa/relocation present (Track B only).
 */
export function q4_visaRelocation(job, track = 'A') {
  if (track !== 'B') return { pass: true, reason: null };
  const text = norm(`${job.description_text || ''}`);
  const signals = [
    'visa sponsorship', 'visa support', 'sponsor a visa', 'sponsor visa',
    'relocation', 'work permit', 'sponsored visa',
  ];
  if (signals.some(s => text.includes(s))) return { pass: true, reason: null };
  return { pass: false, reason: 'no_visa_or_relocation_mention' };
}

/**
 * Q5: Not previously contacted within N days at this company.
 * Caller passes `alreadyContacted` (boolean) computed via repo.wasCompanyContactedRecently.
 */
export function q5_notPreviouslyContacted(alreadyContacted) {
  if (alreadyContacted) return { pass: false, reason: 'contacted_within_90_days' };
  return { pass: true, reason: null };
}

/**
 * Q6: Company size sanity. Enterprises (1000+ headcount) route hiring
 * through ATS + recruiting agencies and rarely reply to cold outreach,
 * so we drop them outright. Unknown size is not enough to reject — it
 * only fails when the seed/enrichment recorded a size band in the
 * configured reject list.
 */
export function q6_companySizeOK(company, config) {
  const band = String(company?.size_band || '').trim();
  if (!band) return { pass: true, reason: null };
  const rejects = (config?.scoring?.reject_size_bands || []).map(b => String(b).toLowerCase());
  if (rejects.includes(band.toLowerCase())) {
    return { pass: false, reason: `company_size_too_large:${band}` };
  }
  return { pass: true, reason: null };
}

// Utility: word-boundary contains. Prevents "senior" matching inside "seniority".
function wordBoundary(haystack, needle) {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
}
