// qualify/salary.js
// Best-effort salary extraction. Reads comp_raw first (structured), then falls
// back to scanning the description for currency amounts. Normalizes to an
// annual figure in the currency that appeared.
//
// Handles common patterns:
//   $150,000       $150k       150K USD       $150,000-$200,000
//   €90k - €120k   £80,000     $120K annually $10k/month
//
// Returns { annual, monthly, currency } or null if nothing usable was found.

const CURRENCY = {
  '$': 'USD', 'USD': 'USD',
  '€': 'EUR', 'EUR': 'EUR',
  '£': 'GBP', 'GBP': 'GBP',
};

// Match a currency symbol/code + number + optional "k"/"K" + optional per-period suffix.
// Examples matched: $150k  €90,000  £80K  USD 120,000  $10k/month  $150,000/year
const AMOUNT_RE =
  /(?:(\$|€|£)|\b(USD|EUR|GBP)\b)\s*([\d]{1,3}(?:[,][\d]{3})+|[\d]+)\s*([kK])?(?:\s*(?:\/|per\s)\s*(hour|hr|month|mo|year|yr|annum))?/gi;

/**
 * @param {object} args
 * @param {number} [args.minPlausibleAnnual=20000]
 *   Amounts below this are treated as noise (signing bonus, stipend, etc.)
 *   and dropped. Callers who want to detect legitimately-low salaries
 *   (below-floor jobs at $12k/yr etc.) should lower this — the pay-check
 *   gate does exactly that.
 * @returns {{ annual:number, monthly:number, currency:string }|null}
 */
export function extractAnnualSalary({
  compRaw, descriptionText,
  acceptedCurrencies = ['USD', 'EUR', 'GBP'],
  minPlausibleAnnual = 20_000,
}) {
  const buckets = [];
  for (const text of [compRaw, descriptionText]) {
    if (!text) continue;
    for (const m of String(text).matchAll(AMOUNT_RE)) {
      const currency = CURRENCY[m[1]] || CURRENCY[(m[2] || '').toUpperCase()];
      if (!currency || !acceptedCurrencies.includes(currency)) continue;

      const rawNum = Number(m[3].replace(/,/g, ''));
      if (!Number.isFinite(rawNum) || rawNum <= 0) continue;

      const kSuffix = Boolean(m[4]);
      const period = (m[5] || '').toLowerCase();
      const value = kSuffix ? rawNum * 1000 : rawNum;

      const annual = periodToAnnual(value, period);
      // Keep an amount if it clears the noise floor OR if the period is
      // explicit (an explicit "/month" or "/year" is not noise — it's
      // structurally a salary quote, however low).
      const isExplicit = Boolean(period);
      if (annual <= 1_000_000 && (annual >= minPlausibleAnnual || isExplicit)) {
        buckets.push({ annual, currency });
      }
    }
    if (buckets.length) break;                          // prefer comp_raw over description
  }
  if (!buckets.length) return null;

  // If the posting quotes a range (multiple hits), take the median so we neither
  // over- nor under-count.
  buckets.sort((a, b) => a.annual - b.annual);
  const median = buckets[Math.floor(buckets.length / 2)];
  return {
    annual: median.annual,
    monthly: Math.round(median.annual / 12),
    currency: median.currency,
  };
}

function periodToAnnual(value, period) {
  if (!period) {
    // Bare number: heuristic. Below 500 → hourly-ish, treat as annual*40h*52w.
    // Below 15k → monthly. Otherwise annual.
    if (value <= 500) return value * 40 * 52;
    if (value < 15_000) return value * 12;
    return value;
  }
  if (/^(hour|hr)$/.test(period)) return value * 40 * 52;
  if (/^(month|mo)$/.test(period)) return value * 12;
  return value;                                         // year/yr/annum
}
