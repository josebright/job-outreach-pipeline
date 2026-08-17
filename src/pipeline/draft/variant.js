// draft/variant.js
// Deterministically pick which of the 3 draft variants a given company
// should get. Same company slug always maps to the same variant — no
// A/B contamination when we draft multiple contacts at the same co.
//
// Variants:
//   V1_OBSERVATION — best for 51-500 employee co's (Lavender 2025)
//   V2_QUESTION    — best for founder-read inboxes (<=50 employees)
//   V3_DIRECT      — safe fallback / variety rotation
//
// Weighting by size band:
//   <=50 employees → 50% V2, 25% V1, 25% V3  (bias V2 for founder inbox)
//   >50 or unknown → even 1/1/1 rotation over V1/V2/V3

/**
 * @param {string} slug   - company.slug (must be stable per company)
 * @param {string|null} sizeBand
 * @returns {'V1_OBSERVATION'|'V2_QUESTION'|'V3_DIRECT'}
 */
export function pickDraftVariant(slug, sizeBand) {
  const h = hashSlug(String(slug || 'unknown'));
  const isSmall = isSmallBand(sizeBand);

  if (isSmall) {
    // 4-slot rotation biased toward V2
    return ['V2_QUESTION', 'V2_QUESTION', 'V1_OBSERVATION', 'V3_DIRECT'][h % 4];
  }
  // Even 3-slot rotation for mid+ and unknown
  return ['V1_OBSERVATION', 'V2_QUESTION', 'V3_DIRECT'][h % 3];
}

function isSmallBand(band) {
  if (!band) return false;
  const s = String(band).toLowerCase();
  return /^(1-10|11-50|1-50|2-10|2-50|small)$/.test(s);
}

/**
 * djb2-style deterministic hash → non-negative integer.
 * Exported for tests so we can assert the routing.
 */
export function hashSlug(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
