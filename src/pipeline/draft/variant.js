// draft/variant.js
// Deterministically pick which of the 3 draft variants a given company
// should get. Same company slug always maps to the same variant — no
// A/B contamination when we draft multiple contacts at the same co.
//
// Variants (outreach_v3 — all candidate-voiced; they differ only in what the
// first paragraph leads with AFTER the mandatory application sentence):
//   V1_ROLE_FIT — lead with the posting requirement you match (51-500 / unknown)
//   V2_EVIDENCE — lead with the thing you shipped (<=50, founder reads inbox)
//   V3_DIRECT   — safe fallback / variety rotation
//
// The old V2_QUESTION shape ("Is the {role} hire for {team}?") is gone. It
// interrogated why the req existed, which reads as a consultant qualifying an
// opportunity rather than a candidate applying. See prompts/outreach_v3.txt.
//
// Weighting by size band:
//   <=50 employees → 50% V2, 25% V1, 25% V3  (bias V2 for founder inbox)
//   >50 or unknown → even 1/1/1 rotation over V1/V2/V3

/**
 * @param {string} slug   - company.slug (must be stable per company)
 * @param {string|null} sizeBand
 * @returns {'V1_ROLE_FIT'|'V2_EVIDENCE'|'V3_DIRECT'}
 */
export function pickDraftVariant(slug, sizeBand) {
  const h = hashSlug(String(slug || 'unknown'));
  const isSmall = isSmallBand(sizeBand);

  if (isSmall) {
    // 4-slot rotation biased toward V2
    return ['V2_EVIDENCE', 'V2_EVIDENCE', 'V1_ROLE_FIT', 'V3_DIRECT'][h % 4];
  }
  // Even 3-slot rotation for mid+ and unknown
  return ['V1_ROLE_FIT', 'V2_EVIDENCE', 'V3_DIRECT'][h % 3];
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
