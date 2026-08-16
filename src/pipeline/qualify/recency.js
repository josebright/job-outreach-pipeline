// qualify/recency.js
// Gate 6 helper. A posting older than the configured window is dropped
// outright (stale postings rarely pay off — role usually filled or the
// team stopped actively hiring). Fresher postings score higher in the
// scoring pass (recency_bonus).

/**
 * @param {string|null} postedAtIso  - ISO 8601 or null
 * @param {number}      maxAgeDays   - from config.gates.max_posting_age_days
 * @param {Date}        [now]        - injectable for tests
 * @returns {{ fresh:boolean, ageDays:number|null }}
 *   fresh: true if within the window; false if stale.
 *   ageDays: null when postedAt is missing/invalid — treated as fresh
 *            (charitable, since some ATSes don't return a date).
 */
export function checkRecency(postedAtIso, maxAgeDays, now = new Date()) {
  if (!postedAtIso) return { fresh: true, ageDays: null };
  const d = new Date(postedAtIso);
  if (Number.isNaN(d.getTime())) return { fresh: true, ageDays: null };
  const ageMs = now.getTime() - d.getTime();
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  return { fresh: ageDays <= maxAgeDays, ageDays };
}
