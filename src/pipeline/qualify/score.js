// qualify/score.js
// Soft scoring, applied *after* the priority gate chain. Signals here
// discriminate *within* the pool that already cleared every hard gate —
// no point double-counting things the gate chain already enforced.
//
// Removed from prior scoring (now hard gates):
//   remote_worldwide   — enforced by gate1_remoteFromNigeria
//   explicit_salary    — enforced (in-currency) by gate2_payMinimum
//   recent_post_days   — enforced by gate6_recentPosting; recency bonus
//                        below is a fresher-is-better refinement
//
// Kept + refined:
//   nigeria_presence         (30)  — company-level flag, high value
//   pay_amount_bonus         (0-15) — sliding scale above the floor
//   recency_bonus            (0-15) — sliding scale within the window
//   stack_overlap            (10)  — 3+ stack keywords in title+desc
//   company_size_sweet_spot  (20)  — 11-200 employees
//   seed_stage_bonus         (5)   — extra for 2-50 (founder-read inbox)
//   eor_mention              (5)   — Deel / Remote.com / EOR named
import { checkPay } from './pay-check.js';
import { checkRecency } from './recency.js';

const norm = s => (s || '').toLowerCase();
const wordCount = (haystack, needles) => needles
  .map(n => norm(n))
  .filter(n => n && norm(haystack).includes(n))
  .length;

export function scoreJob(job, company, config) {
  const weights = config.scoring?.weights || {};
  const breakdown = {};

  // Nigeria presence: company-level flag set by seed CSV / enrichment.
  if (company?.nigeria_presence) breakdown.nigeria_presence = weights.nigeria_presence ?? 30;

  // Pay amount bonus: sliding scale above the floor. Even splits at
  // 2x, 3x, 4x the minimum.
  const minAnnual = config.gates?.pay_minimum_annual ?? 24000;
  const pay = checkPay({
    compRaw: job.comp_raw,
    descriptionText: job.description_text,
    minAnnual,
    acceptedCurrencies: config.currency?.accept || ['USD', 'EUR', 'GBP'],
  });
  if (pay.status === 'above_floor' && pay.annual) {
    const ratio = pay.annual / minAnnual;
    const cap   = weights.pay_amount_bonus ?? 15;
    if (ratio >= 4)      breakdown.pay_amount_bonus = cap;
    else if (ratio >= 3) breakdown.pay_amount_bonus = Math.round(cap * 0.75);
    else if (ratio >= 2) breakdown.pay_amount_bonus = Math.round(cap * 0.5);
    else                 breakdown.pay_amount_bonus = Math.round(cap * 0.25);
  }

  // Recency bonus: closer to today = higher. Fresh (≤ 7 days) = full;
  // fades to zero at max_posting_age_days.
  const maxAge = config.gates?.max_posting_age_days ?? 30;
  const rec = checkRecency(job.posted_at, maxAge);
  if (rec.fresh && rec.ageDays !== null) {
    const cap = weights.recency_bonus ?? 15;
    if (rec.ageDays <= 7)        breakdown.recency_bonus = cap;
    else if (rec.ageDays <= 14)  breakdown.recency_bonus = Math.round(cap * 0.66);
    else if (rec.ageDays <= 21)  breakdown.recency_bonus = Math.round(cap * 0.33);
    else                         breakdown.recency_bonus = Math.round(cap * 0.15);
  }

  // Stack overlap: 3+ of the configured stack keywords in title + desc.
  const overlap = wordCount(
    `${job.title || ''} ${job.description_text || ''}`,
    config.stack?.keywords || [],
  );
  if (overlap >= 3) breakdown.stack_overlap = weights.stack_overlap ?? 10;

  // Company size sweet spot (11-200) and seed-stage bonus (2-50).
  if (isSweetSpotSize(company?.size_band)) {
    breakdown.company_size_sweet_spot = weights.company_size_sweet_spot ?? 20;
  }
  if (isSeedStageSize(company?.size_band) && (weights.seed_stage_bonus ?? 5)) {
    breakdown.seed_stage_bonus = weights.seed_stage_bonus ?? 5;
  }

  // EOR mention (Deel / Remote.com / etc).
  const eorText = `${job.description_text || ''} ${job.comp_raw || ''}`;
  const hasEor = (config.currency?.contractor_signal_words || [])
    .some(w => norm(eorText).includes(norm(w)));
  if (hasEor) breakdown.eor_mention = weights.eor_mention ?? 5;

  const score = Object.values(breakdown).reduce((s, v) => s + v, 0);
  return { score: Math.min(100, Math.max(0, score)), breakdown };
}

// 11-200 sweet spot — reachable decision makers, still enough scale
// to have Hunter data.
function isSweetSpotSize(band) {
  if (!band) return false;
  const s = String(band).toLowerCase();
  if (['11-50', '51-200', '11-200', '10-50', '50-200'].some(b => s.includes(b))) return true;
  const m = s.match(/(\d+)\s*-\s*(\d+)/);
  if (m) {
    const lo = Number(m[1]), hi = Number(m[2]);
    if (lo >= 11 && hi <= 200) return true;
    if (lo <= 200 && hi >= 11 && hi - lo <= 300) return true;
  }
  return false;
}

// 2-50 bracket — founder / head-of-eng typically reads their own inbox.
function isSeedStageSize(band) {
  if (!band) return false;
  const s = String(band).toLowerCase();
  if (['2-10', '11-50', '10-50', '1-10', '1-50', '2-50'].some(b => s.includes(b))) return true;
  const m = s.match(/(\d+)\s*-\s*(\d+)/);
  if (m) {
    const lo = Number(m[1]), hi = Number(m[2]);
    if (lo >= 1 && hi <= 50) return true;
  }
  return false;
}
