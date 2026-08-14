// enrich/target.js
// Per PRD Module 4, target the right people by company size.
//
//   <= 50   -> founder/CEO/CTO
//   51-500  -> VP Engineering / Head of Eng / Engineering Manager
//   any     -> senior/staff engineer (referral fallback) + recruiter on posting

/**
 * Return Hunter "seniority" and "department" hints for domain-search,
 * plus the role_type label to store on each contact we accept.
 */
export function targetHintsFor(company) {
  const band = String(company?.size_band || '').toLowerCase();
  const small = /^(1-10|11-50|1-50|small)$/.test(band) || band === '';
  const mid = /^(51-200|51-500|201-500|11-200|11-500|mid)$/.test(band);

  // Hunter supports comma-separated seniority: executive, senior, junior
  // and department: executive, it, engineering, marketing, sales, ...
  if (small) {
    return [
      { seniority: 'executive', department: 'executive', roleType: 'founder',      titleAny: ['founder', 'ceo', 'cto'] },
      { seniority: 'executive', department: 'engineering', roleType: 'eng_leader', titleAny: ['cto', 'vp engineering'] },
    ];
  }
  if (mid) {
    return [
      { seniority: 'executive', department: 'engineering', roleType: 'eng_leader', titleAny: ['vp engineering', 'head of engineering', 'engineering director'] },
      { seniority: 'senior',    department: 'engineering', roleType: 'eng_leader', titleAny: ['engineering manager', 'director of engineering'] },
    ];
  }
  // Large default: eng leaders + a referral-angle senior engineer.
  return [
    { seniority: 'senior',    department: 'engineering', roleType: 'eng_leader', titleAny: ['engineering manager', 'director of engineering'] },
    { seniority: 'senior',    department: 'engineering', roleType: 'engineer',   titleAny: ['staff engineer', 'senior engineer', 'principal engineer'] },
  ];
}

/**
 * Loose title matcher. For each needle, all whitespace-separated tokens
 * of the needle must appear as substrings of the title (order-independent).
 * "vp engineering" therefore matches "VP of Engineering".
 */
export function titleMatches(title, needles) {
  const t = (title || '').toLowerCase();
  return needles.some(n => {
    const tokens = String(n).toLowerCase().split(/\s+/).filter(Boolean);
    return tokens.every(tok => t.includes(tok));
  });
}
