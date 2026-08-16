// enrich/target.js
// Per PRD Module 4, target the right people by company size — but do it as
// a *ranking*, not a hard filter. On small startups Hunter's data is thin,
// so filtering by exec seniority + a strict title list drops almost every
// hit. Instead we query broadly and score each returned person; the caller
// picks the top N.
//
// Rank buckets (higher = better):
//   founder / CEO / CTO / COO           → 100 (or 60 at large co's, where
//                                              they never read cold email)
//   VP Engineering / Head of Eng /       → 80
//     Director of Engineering / Eng Lead
//   Engineering Manager                  → 60
//   Head of Talent / People / HR         → 40
//   Recruiter / Technical Recruiter      → 30
//   Staff / Principal / Senior Engineer  → 25
//   Anyone else                          → 10

const RE = {
  founder: /\b(co-?founder|founder|founding\s+(engineer|team)|ceo|cto|coo|chief\s+(technology|executive|operating))\b/,
  vpEng: /\b(vp|vice\s+president)\s+(of\s+)?engineering|head of engineering|director of engineering|engineering director|engineering lead|head of technology|head of tech\b/,
  em: /\bengineering\s+manager\b|\bem\b/,
  talentHead: /head of (talent|people|hr)|director of (talent|people|hr)|hr director|talent director|chief people/,
  recruiter: /\brecruit(er|ing)|talent (acquisition|partner)|technical recruiter|talent lead\b/,
  seniorIc: /\b(staff|principal|senior|sr\.?|lead)\s+(software\s+)?(engineer|developer|swe)\b|\btech(nical)?\s+lead\b/,
};

/**
 * Score a Hunter person object by title + seniority.
 * @param {{ position?:string, seniority?:string }} person
 * @param {{ isSmall?:boolean }} [ctx]
 * @returns {number} 0-100
 */
export function rankPerson(person, { isSmall = false } = {}) {
  const title = String(person?.position || '').toLowerCase();
  const sen = String(person?.seniority || '').toLowerCase();

  let score = 0;
  if (RE.founder.test(title))          score = isSmall ? 100 : 60;
  else if (RE.vpEng.test(title))       score = 80;
  else if (RE.em.test(title))          score = 60;
  else if (RE.talentHead.test(title))  score = 40;
  else if (RE.recruiter.test(title))   score = 30;
  else if (RE.seniorIc.test(title))    score = 25;
  else                                 score = 10;

  // Small nudge from Hunter's own seniority tag when title text was thin.
  if (score <= 10) {
    if (sen === 'executive') score += 20;
    else if (sen === 'senior') score += 10;
  }
  return score;
}

/**
 * Map a returned person's title to our contact.role_type label.
 */
export function roleTypeForTitle(title) {
  const t = String(title || '').toLowerCase();
  if (RE.founder.test(t))     return 'founder';
  if (RE.vpEng.test(t) || RE.em.test(t)) return 'eng_leader';
  if (RE.recruiter.test(t) || RE.talentHead.test(t)) return 'recruiter';
  if (RE.seniorIc.test(t))    return 'engineer';
  return 'engineer';
}

/**
 * Hunter domain-search query plan, ordered by expected yield for the given
 * company. Executed in order; results are merged & de-duped by email.
 * Kept short (2-3 queries) so we don't chew credits.
 */
export function queriesFor(company) {
  const band = String(company?.size_band || '').toLowerCase();
  const small = /^(1-10|11-50|1-50|2-10|small)$/.test(band) || band === '';

  const queries = [];
  if (small) {
    // Small co: try execs first (typically 5-15 total employees in Hunter's
    // index for a seed-stage company; execs are almost all of them).
    queries.push({ seniority: 'executive', department: null, limit: 25 });
    queries.push({ seniority: null, department: 'engineering', limit: 25 });
  } else {
    queries.push({ seniority: null, department: 'engineering', limit: 25 });
    queries.push({ seniority: 'executive', department: 'engineering', limit: 25 });
  }
  // Final catch-all so we never leave the domain empty-handed when Hunter
  // has any data at all.
  queries.push({ seniority: null, department: null, limit: 25 });
  return queries;
}

/**
 * Return whether a company should be treated as small-stage.
 */
export function isSmallCo(company) {
  const band = String(company?.size_band || '').toLowerCase();
  return /^(1-10|11-50|1-50|2-10|small)$/.test(band) || band === '';
}

/* ── legacy API kept for backward-compatibility ─────────── */
// Older tests + callers may still import these. Preserved so we don't have
// to rip up other imports.

export function targetHintsFor(company) {
  const small = isSmallCo(company);
  const band = String(company?.size_band || '').toLowerCase();
  const mid = /^(51-200|51-500|201-500|11-200|11-500|mid)$/.test(band);
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
  return [
    { seniority: 'senior',    department: 'engineering', roleType: 'eng_leader', titleAny: ['engineering manager', 'director of engineering'] },
    { seniority: 'senior',    department: 'engineering', roleType: 'engineer',   titleAny: ['staff engineer', 'senior engineer', 'principal engineer'] },
  ];
}

export function titleMatches(title, needles) {
  const t = (title || '').toLowerCase();
  return needles.some(n => {
    const tokens = String(n).toLowerCase().split(/\s+/).filter(Boolean);
    return tokens.every(tok => t.includes(tok));
  });
}
