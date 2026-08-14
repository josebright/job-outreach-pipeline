// qualify/score.js
// Soft scoring per PRD section 5, Module 3.
// Returns a 0-100 score plus a per-signal breakdown for auditing.

const norm = s => (s || '').toLowerCase();
const wordCount = (haystack, needles) => needles
  .map(n => norm(n))
  .filter(n => n && norm(haystack).includes(n))
  .length;

/**
 * @returns {{ score:number, breakdown: Record<string,number> }}
 */
export function scoreJob(job, company, config) {
  const weights = config.scoring.weights;
  const breakdown = {};

  // Nigeria presence: company-level flag set by seed CSV or enrichment.
  if (company?.nigeria_presence) breakdown.nigeria_presence = weights.nigeria_presence;

  // Explicit salary: currency signal in accept list AND a raw comp string present.
  const acceptSet = new Set(config.currency.accept);
  const hasExplicitSalary = job.currency_signal
    && acceptSet.has(job.currency_signal)
    && Boolean(job.comp_raw || /\b(salary|compensation|base|pay|package)\b/i.test(job.description_text || ''));
  if (hasExplicitSalary) breakdown.explicit_salary = weights.explicit_salary;

  // Remote worldwide (strictly worldwide, not just EMEA).
  if (job.remote_scope === 'worldwide') breakdown.remote_worldwide = weights.remote_worldwide;

  // Recent post: within last 14 days.
  if (isRecent(job.posted_at, 14)) breakdown.recent_post_days = weights.recent_post_days;

  // Stack overlap: 3+ of the configured stack keywords appearing in title+description.
  const overlap = wordCount(
    `${job.title || ''} ${job.description_text || ''}`,
    config.stack.keywords,
  );
  if (overlap >= 3) breakdown.stack_overlap = weights.stack_overlap;

  // Company size sweet spot: 11-200 employees. Only awarded when size_band is set.
  if (isSweetSpotSize(company?.size_band)) {
    breakdown.company_size_sweet_spot = weights.company_size_sweet_spot;
  }

  // EOR / contractor mention in description or comp.
  const eorText = `${job.description_text || ''} ${job.comp_raw || ''}`;
  const hasEor = (config.currency.contractor_signal_words || [])
    .some(w => norm(eorText).includes(norm(w)));
  if (hasEor) breakdown.eor_mention = weights.eor_mention;

  const score = Object.values(breakdown).reduce((s, v) => s + v, 0);
  return { score: Math.min(100, Math.max(0, score)), breakdown };
}

function isRecent(iso, days) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return d.getTime() >= cutoff;
}

// Accept variants: "11-50", "51-200", "11-200", "small", etc.
// PRD sweet spot is 11-200 (reachable decision-makers).
function isSweetSpotSize(band) {
  if (!band) return false;
  const s = String(band).toLowerCase();
  if (['11-50', '51-200', '11-200', '10-50', '50-200'].some(b => s.includes(b))) return true;
  // Numeric ranges like "20-150".
  const m = s.match(/(\d+)\s*-\s*(\d+)/);
  if (m) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (lo >= 11 && hi <= 200) return true;
    // Overlap: any part in the 11-200 band, e.g., "50-500" → yes-ish.
    if (lo <= 200 && hi >= 11 && hi - lo <= 300) return true;
  }
  return false;
}
