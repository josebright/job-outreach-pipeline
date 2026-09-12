// qualify/filters.js
// Priority-ordered gate chain. Applied in order; first fail short-circuits.
// The old Q1-Q6 numbering has been dropped along with Track B — see the
// design note in qualify/index.js.
//
// Priority order (as agreed with the applicant):
//   1. Remote-from-Nigeria (no visa/work permit required)
//   2. Pay ≥ minimum in USD/EUR/GBP (only enforced when stated)
//   3. Skillset match (SWE / backend / frontend / fullstack / product /
//                      founding / research; explicit rejects for
//                      management, ML, security, infra, etc.)
//   4. Company size 2-500 (2-100 preferred; enforced via scoring/tier)
//   5. Not previously contacted (within 90 days)
//   6. Posting recency (within max_posting_age_days)
//   7. Have a contact email — enforced at draft time, not here.
import { checkPay } from './pay-check.js';
import { checkRecency } from './recency.js';

const norm = s => (s || '').toLowerCase();
const compact = s => norm(s).replace(/\s+/g, ' ');

// Role markers that *must* appear in the title. Substring match on
// normalized (lowercased) title. Compare gate3 for details.
export const ROLE_MARKERS = [
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

// Explicit rejects that must not appear anywhere in the title. Applied
// after ROLE_MARKERS so titles like "Machine Learning Engineer" which
// don't hit any ROLE_MARKER don't even reach this list.
//
// Includes ATS-in-the-wild variants of the same underlying rejection:
// "ML Software Engineer", "Software Engineer, Machine Learning",
// "Manager, Software Engineering". These aren't a whack-a-mole growth
// list — every entry maps to one of the same underlying rejected
// categories (management, ML/AI, security, infra, adjacent-specialty).
export const REJECT_ROLE_MARKERS = [
  // Architecture / SRE / DevOps
  'architect', 'sre', 'site reliability',
  'devops', 'devsecops',
  'reliability engineer', 'observability engineer',

  // Security
  'security engineer', 'security software engineer', 'application security',
  'appsec engineer', 'product security', 'offensive security',

  // ML / AI (all word orders we've actually seen in postings)
  'ml engineer', 'machine learning engineer', 'ml software engineer',
  'ai engineer', 'ai software engineer', 'agentic ai',
  'mlops', 'ai/ml', 'llm engineer', 'gen ai', 'genai engineer',
  'ai governance', 'ai safety', 'ai alignment', 'ai trust',
  'machine learning', 'ml research', 'ai research',
  ', machine learning', ' - machine learning',
  ', ml ', ' - ml ',
  ', ai ', ' - ai ', ', ai\b', ' - ai\b',

  // Data
  'data engineer', 'data scientist', 'analytics engineer',
  ', data engineering', ' - data engineering',

  // Infrastructure / Platform
  'infrastructure engineer', 'infra engineer',
  'platform engineer', 'platform lead',
  ', infrastructure', ' - infrastructure', '(infrastructure)',
  ', platform', ' - platform',

  // Other adjacent specialties
  'firmware engineer', 'hardware engineer', 'embedded engineer',
  'flight software', 'flight engineer', 'avionics', 'spacecraft',
  'quantum engineer', 'quantum software',
  'qa engineer', 'quality engineer', 'test engineer', 'sdet',
  'sales engineer', 'solutions engineer', 'support engineer',
  'network engineer', 'systems engineer', 'system engineer',
  'game engineer', 'graphics engineer', 'audio engineer',
  'blockchain engineer', 'protocol engineer', 'crypto engineer',
  'developer advocate', 'developer relations', 'devrel',
  'growth engineer', 'forward deployed engineer', 'fde',

  // Auth / pipeline / ingestion (adjacent SWE roles, not our stack)
  'auth engineer', 'authentication engineer',
  ', auth', ' - auth',
  'ciam', 'customer identity', 'access management',
  'pipeline engineer', 'ingestion engineer', 'ingestion pipeline',

  // Supply-chain / CI security-adjacent (aligns with security reject)
  'secure build', 'secure supply chain', 'supply chain security',

  // AI agent framework work (aligns with ai/ml reject — applicant is SWE
  // not agent-framework builder)
  ', agent', ' - agent', 'agent engineer', 'agentic',

  // Management (applicant is IC, not a hiring manager)
  'engineering manager', 'engineering director', 'director of engineering',
  'vp engineering', 'vp of engineering', 'head of engineering',
  'chief technology', 'cto',
  'manager, software engineering', 'manager, engineering',
  'software engineering manager',
];

/* ─── Gate 1: Remote-from-Nigeria ──────────────────────────── */

/**
 * The company must be able to hire the applicant remotely from Nigeria
 * without a visa or work permit. Deny-list first (US-only, "EU citizens
 * only", "must reside in ...", US timezone, etc.), then allow-list
 * (worldwide, anywhere, EMEA, Africa, global, fully remote), then the
 * ATS classifier's remote_scope field.
 *
 * Charitable-remote rule: if the job's location text just says "Remote"
 * (no allow keyword hit) AND the deny-list did NOT trip, we PASS.
 * Rationale: most ATSes only label the workplace_type; the actual
 * geographical constraint (if any) appears in the description body, and
 * the deny list is our filter for that. Marking bare "Remote" as
 * needs_review was killing ~96% of qualified jobs on the last /run.
 * If we occasionally draft to a US-only role we missed, the applicant
 * can /reject <id> us only which now auto-suppresses.
 *
 * Anything truly ambiguous (no location text at all, no remote signal
 * anywhere) still becomes needs_review.
 */
export function gate1_remoteFromNigeria(job, config) {
  const location = norm(job.location_raw || '');
  const description = norm(job.description_text || '');
  const haystack = compact(`${location} ${description}`);
  const { allow, deny } = config.location;

  for (const d of deny || []) {
    if (haystack.includes(norm(d))) return { pass: false, reason: `remote_denied:${d}` };
  }
  for (const a of allow || []) {
    if (haystack.includes(norm(a))) return { pass: true, reason: null };
  }
  if (job.remote_scope === 'worldwide' || job.remote_scope === 'emea' || job.remote_scope === 'africa') {
    return { pass: true, reason: null };
  }
  if (job.remote_scope === 'us_only' || job.remote_scope === 'onsite') {
    return { pass: false, reason: `remote_scope:${job.remote_scope}` };
  }

  // Charitable pass: ANY mention of "remote" (word-bounded) in either
  // location OR description + no US-only signal → pass. The deny list
  // above is our filter for US-only postings, and the applicant can
  // /reject <id> us only which auto-suppresses. Being too strict here
  // was pushing ~90% of jobs into needs_review, effectively rejecting
  // them since needs_review never becomes qualified.
  const looksRemote =
    /\bremote\b/i.test(location) ||
    /\bremote\b/i.test(description) ||
    job.workplace_type === 'remote' ||
    job.remote_scope === 'remote' ||
    REMOTE_DESC_SIGNALS.test(description);
  if (looksRemote) return { pass: true, reason: null };

  // Final charitable pass: if we reached here, there is no US-only/onsite
  // signal (deny-list didn't fire) and no positive remote signal either.
  // These jobs came through SERP dork queries that included "remote" and
  // "worldwide" — the COMPANY is remote-friendly even if this specific
  // posting body omits the word. needs_review was a dead end: jobs re-
  // evaluate every run, always return remote_ambiguous, and never qualify.
  // Pass them through to gate3 where the role title will do the real
  // filtering. Applicant can /reject <id> us only which auto-suppresses.
  return { pass: true, reason: null };
}

// Kept in sync with ingest/ats/classify.js REMOTE_TEXT_SIGNALS so both
// layers recognise the same 2026 remote-signal vocabulary.
const REMOTE_DESC_SIGNALS = /\b(fully\s+remote|100%\s+remote|remote[-\s]first|remote[-\s]friendly|distributed\s+team|globally\s+distributed|work\s+from\s+anywhere|anywhere\s+in\s+the\s+world|async[-\s]first|hire\s+globally|hire\s+anywhere|we['\s]re\s+(fully\s+)?remote|we\s+are\s+(fully\s+)?remote|remote\s+(role|position|team|company|opportunity|first))\b/i;

/* ─── Gate 2: Pay ≥ minimum in USD/EUR/GBP ─────────────────── */

/**
 * When the posting states a salary, it must be at least
 * config.gates.pay_minimum_annual in USD/EUR/GBP. When no salary is
 * stated, the gate passes (per applicant's preference — small startups
 * rarely disclose, and rejecting them all wipes out most supply).
 */
export function gate2_payMinimum(job, config) {
  const minAnnual = config.gates?.pay_minimum_annual ?? 24000;
  const result = checkPay({
    compRaw: job.comp_raw,
    descriptionText: job.description_text,
    minAnnual,
    acceptedCurrencies: config.currency?.accept || ['USD', 'EUR', 'GBP'],
  });
  if (result.status === 'above_floor' || result.status === 'unstated') {
    return { pass: true, reason: null };
  }
  if (result.status === 'below_floor') {
    return { pass: false, reason: `pay_below_floor:${result.annual}` };
  }
  return { pass: false, reason: `pay_wrong_currency:${result.currency}` };
}

// Accepted specializations that may appear *after* a comma or dash in
// the title (e.g. "Software Engineer, Backend" or "Software Engineer -
// Booking Platform"). Anything else in the suffix position is rejected
// — the reject-list approach is too permissive because ATS titles use
// endless variations ("Cortex Quality", "Understanding", "Flight
// Software", "Cortex AI"...). A closed whitelist is fail-safe.
//
// Match rule: the specialization suffix must START WITH one of these
// tokens. So "Backend - Booking Platform" starts with "backend" → ok.
// "Understanding" doesn't start with any → reject.
const ACCEPTED_SPECIALIZATIONS = [
  'backend', 'back-end', 'back end',
  'frontend', 'front-end', 'front end',
  'fullstack', 'full-stack', 'full stack',
  'product', 'product backend', 'product frontend', 'product engineering',
  'api', 'apis', 'api platform',
  'web', 'mobile', 'ios', 'android',
  'core',   // "Software Engineer, Core Platform" is common at small co's
];

/* ─── Gate 3: Skillset match ───────────────────────────────── */

/**
 * The job title must contain a ROLE_MARKER (SWE / backend / frontend /
 * fullstack / product / founding / research variants) AND must NOT
 * contain any REJECT_ROLE_MARKER (management, ML, security, infra, etc).
 * Then at least one config.stack keyword must appear in title or
 * description. Junior-in-title is rejected unless the posting states a
 * salary above config.stack.junior_override_min_annual — but "new grad"
 * / "intern" / "internship" are hard-rejected even with salary override.
 */
export function gate3_skillsetMatch(job, config) {
  const title = norm(job.title);
  const text = compact(`${job.title || ''} ${job.description_text || ''}`);
  const { keywords, seniority_reject } = config.stack;

  const titleHasRole = ROLE_MARKERS.some(m => title.includes(m));
  if (!titleHasRole) return { pass: false, reason: 'title_not_engineering' };
  const isReject = REJECT_ROLE_MARKERS.some(m => title.includes(m));
  if (isReject) return { pass: false, reason: 'title_role_out_of_scope' };

  // Trailing parenthetical: often metadata like "(Europe/UK timezone)"
  // or "(4-8 YOE)" (harmless) — but sometimes a substantive role scope
  // like "(AI Governance)" or "(Machine Learning)" (must reject). Check
  // the paren content against the same REJECT_ROLE_MARKERS list.
  const paren = extractParenContent(job.title || '');
  if (paren) {
    const parenNorm = norm(paren);
    const parenIsReject = REJECT_ROLE_MARKERS.some(m => parenNorm.includes(m));
    if (parenIsReject) return { pass: false, reason: `paren_role_out_of_scope:${paren.slice(0, 40)}` };
  }

  // Whitelist for comma/dash-suffix specializations. If the title has a
  // specialization after "Software Engineer, X" or "Software Engineer - X",
  // that X must be an accepted specialization. Prevents endless whack-a-
  // mole with "Software Engineer, {any-team-name-at-any-company}".
  const spec = extractSpecialization(job.title || '');
  if (spec) {
    const specLower = spec.toLowerCase();
    const accepted = ACCEPTED_SPECIALIZATIONS.some(a =>
      specLower === a || specLower.startsWith(a + ' ') || specLower.startsWith(a + ',') ||
      specLower.startsWith(a + '-') || specLower.startsWith(a + '(')
    );
    if (!accepted) return { pass: false, reason: `spec_not_accepted:${spec.slice(0, 40)}` };
  }

  const hasStackKeyword = keywords.some(k => text.includes(norm(k)));
  if (!hasStackKeyword) return { pass: false, reason: 'no_stack_keyword_match' };

  // "new grad" / "intern" are hard-rejected regardless of salary override
  // — the role is structurally wrong for a senior applicant even at a
  // senior salary.
  const HARD_JUNIOR = ['new grad', 'newgrad', 'intern', 'internship'];
  if (HARD_JUNIOR.some(r => wordBoundary(title, r))) {
    return { pass: false, reason: 'seniority_new_grad_or_intern' };
  }

  const hasReject = (seniority_reject || []).some(r => wordBoundary(title, norm(r)));
  if (hasReject) {
    // Junior-with-good-pay override: if the posting explicitly states a
    // salary at or above the configured floor, accept the role anyway.
    const floor = config.stack?.junior_override_min_annual || 0;
    if (floor > 0) {
      const pay = checkPay({
        compRaw: job.comp_raw,
        descriptionText: job.description_text,
        minAnnual: floor,
        acceptedCurrencies: config.currency?.accept || ['USD', 'EUR', 'GBP'],
      });
      if (pay.status === 'above_floor') return { pass: true, reason: null };
    }
    return { pass: false, reason: 'seniority_below_target' };
  }

  return { pass: true, reason: null };
}

/* ─── Gate 4: Company size 2-500 ───────────────────────────── */

/**
 * Companies at or above config.scoring.reject_size_bands are dropped
 * outright (default: 501+ headcount). Unknown size passes — Q4 is not
 * a "must have data" gate; the tier-priority in draft ordering handles
 * the 2-100 preference within the accepted band.
 */
export function gate4_companySize(company, config) {
  const band = String(company?.size_band || '').trim();
  if (!band) return { pass: true, reason: null };
  const rejects = (config?.scoring?.reject_size_bands || []).map(b => String(b).toLowerCase());
  if (rejects.includes(band.toLowerCase())) {
    return { pass: false, reason: `company_size_too_large:${band}` };
  }
  return { pass: true, reason: null };
}

/* ─── Gate 5: Not previously contacted ─────────────────────── */

/**
 * Caller passes `alreadyContacted` (bool) — a repo lookup for outbound
 * messages to this company in the last 90 days.
 */
export function gate5_notPreviouslyContacted(alreadyContacted) {
  if (alreadyContacted) return { pass: false, reason: 'contacted_within_90_days' };
  return { pass: true, reason: null };
}

/* ─── Gate 6: Posting recency ──────────────────────────────── */

/**
 * Postings older than config.gates.max_posting_age_days are dropped
 * (role likely filled). Missing/unparseable posting date passes — some
 * ATSes just don't return it.
 */
export function gate6_recentPosting(job, config) {
  const max = config.gates?.max_posting_age_days ?? 30;
  const r = checkRecency(job.posted_at, max);
  if (r.fresh) return { pass: true, reason: null };
  return { pass: false, reason: `posting_stale:${r.ageDays}d` };
}

/* ─── Utilities ────────────────────────────────────────────── */

/**
 * Extract the specialization suffix from a job title. Returns null when
 * the title has no suffix.
 *   "Senior Software Engineer, Understanding"   → "Understanding"
 *   "Software Engineer - Auth"                  → "Auth"
 *   "Backend Engineer (Europe/UK timezone)"     → null (parens stripped, no separator)
 *   "Full-Stack Engineer"                       → null (hyphen inside a word)
 *   "Software Engineer, Product Backend (4-8)"  → "Product Backend"
 *
 * Exported for tests.
 */
export function extractSpecialization(title) {
  if (!title) return null;
  // Strip trailing parentheticals ("(4-8 YOE)", "(Remote)", etc.)
  const cleaned = String(title).replace(/\s*\([^)]*\)\s*$/, '').trim();
  // Split on ", " OR " - " OR " – " OR " — ". The spaces around dashes
  // ensure we don't split on hyphens inside compound words like
  // "Full-Stack" or "Back-End".
  const m = cleaned.match(/^(.*?)(?:,\s+|\s+[-–—]\s+)(.+)$/);
  if (!m) return null;
  return m[2].trim() || null;
}

/**
 * Extract content inside a trailing "(...)" from a title.
 *   "Staff Software Engineer (AI Governance)" → "AI Governance"
 *   "Backend Engineer (Europe/UK timezone)"   → "Europe/UK timezone"
 *   "Software Engineer"                       → null
 * Exported for tests.
 */
export function extractParenContent(title) {
  if (!title) return null;
  const m = String(title).match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : null;
}

function wordBoundary(haystack, needle) {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
}

/* ─── Back-compat aliases ──────────────────────────────────── */
// Kept so external code / tests that still import Q1-Q6 names don't break
// during the transition. New code should use the gate* names above.
export const q1_roleMatches            = gate3_skillsetMatch;
export const q2_remoteEligible         = (job, config /*, track */) => gate1_remoteFromNigeria(job, config);
export const q3_currencyOK             = () => ({ pass: true, reason: null });  // subsumed into gate2
export const q4_visaRelocation         = () => ({ pass: true, reason: null });  // Track B removed
export const q5_notPreviouslyContacted = gate5_notPreviouslyContacted;
export const q6_companySizeOK          = gate4_companySize;
