// draft/rejection-rules.js
// Turn the applicant's free-text /reject reason into durable effects.
//
// Rejecting a draft used to change nothing unless the reason happened to match
// the company-suppression regex. "has founders in the email" matched nothing,
// so the next /run regenerated the same draft to the same address for the same
// role (#124 -> #126, #125 -> #127).
//
// Deterministic on purpose - no LLM call. Every effect is spelled out in the
// /reject reply, so a misread reason is visible immediately and /forget undoes
// the rule.

// Shared-inbox local parts, grouped so singular/plural and obvious variants
// count as one thing. A learned rule stores the family name.
export const ROLE_ALIAS_FAMILIES = {
  founders:   ['founders', 'founder', 'cofounders', 'cofounder', 'co-founders', 'co-founder'],
  ceo:        ['ceo'],
  cto:        ['cto'],
  hello:      ['hello', 'hi', 'hey'],
  team:       ['team'],
  contact:    ['contact', 'contacts', 'contactus', 'contact-us'],
  info:       ['info'],
  hr:         ['hr'],
  hiring:     ['hiring', 'hire'],
  talent:     ['talent'],
  careers:    ['careers', 'career'],
  jobs:       ['jobs', 'job'],
  recruiting: ['recruiting', 'recruitment', 'recruiter', 'recruiters'],
  support:    ['support', 'help'],
  admin:      ['admin', 'office'],
  sales:      ['sales'],
};

// Families whose word is distinctive enough to learn from a match against the
// recipient's own address with no explicit address word in the reason. "jobs"
// is not: "wrong job" rejecting a jobs@ draft is about the role, not the inbox.
const UNAMBIGUOUS = new Set(['founders', 'ceo', 'cto', 'hello', 'info', 'hr', 'careers', 'recruiting']);

const FAMILY_OF = new Map(
  Object.entries(ROLE_ALIAS_FAMILIES).flatMap(([fam, parts]) => parts.map(p => [p, fam])),
);

const FAMILY_PATTERNS = Object.entries(ROLE_ALIAS_FAMILIES).map(([fam, parts]) => [
  fam, new RegExp(`(^|[^a-z])(${parts.join('|')})(@|[^a-z]|$)`, 'i'),
]);

export function localPartOf(email) {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at > 0 ? s.slice(0, at) : '';
}

/** Alias family for an address, or null when it belongs to a named person. */
export function aliasFamilyOf(email) {
  return FAMILY_OF.get(localPartOf(email)) || null;
}

/** "founders@ / founder@" - for human-readable replies. */
export function describeFamily(fam) {
  return (ROLE_ALIAS_FAMILIES[fam] || [fam]).slice(0, 2).map(p => `${p}@`).join(' / ');
}

/**
 * @param {string} email
 * @param {{ families: Set<string>, allRoleAliases: boolean }} rules
 */
export function isAddressBlocked(email, rules) {
  if (!rules) return false;
  const fam = aliasFamilyOf(email);
  if (!fam) return false;
  return Boolean(rules.allRoleAliases) || rules.families.has(fam);
}

const COMPANY_RE = /\b(too\s*big|too\s*large|too\s*small|wrong\s*(size|industry|company)|us\s*only|us\s*based|onsite|on-site|in-office|hybrid|us\s*timezone|us\s*residents?|not\s*remote|not\s*interested|already\s*applied|applied\s*already|scam|agency|outsourc\w*|consultancy|staffing|bad\s*company|avoid\s*(this\s*)?company)\b/i;

const JOB_RE = /\b(wrong\s*(role|job|position|title)|not\s*(an?\s*)?(engineering|software|dev(eloper)?|backend|frontend|full\s*-?\s*stack)(\s*(role|job|position))?|not\s*my\s*(stack|role)|stack\s*mismatch|too\s*junior|too\s*senior|junior\s*role|management\s*role|manager\s*role|people\s*manager|(php|java|golang|rust|ruby|c\+\+|\.net|c#|scala|elixir)\s*(only|role|heavy)|devops\s*role|data\s*(role|engineer)|ml\s*role|qa\s*role|(role|job)\s*(is\s*)?closed|position\s*filled|no\s*longer\s*(open|hiring))\b/i;

// The reason is about the address or the recipient.
const ADDRESS_WORD_RE = /\b(e-?mail|address|inbox|mailbox|recipient)\b|@/i;
const WRONG_PERSON_RE = /\b(wrong\s*(person|contact|recipient|email|address)|not\s*the\s*right\s*(person|contact)|left\s*the\s*company|no\s*longer\s*(there|works)|bad\s*(email|address)|invalid\s*(email|address)|bounced?)\b/i;
const ALL_ALIASES_RE = /\b(generic|shared\s*inbox|role\s*(email|address|account|inbox)|alias|not\s*a\s*(real\s*)?person|no\s*(real\s*)?name|real\s*person|named\s*person)\b/i;
const GENERIC_COPY_RE = /\bgeneric\s*(copy|text|message|body|wording|pitch|content|draft)\b/i;

const WORDING_RE = /\b(body|wording|tone|subject|too\s*long|rewrite|typo|grammar|sounds?|consultant|pitch|salesy|robotic|awkward|off|weak|generic\s*(copy|text|message|body|wording|pitch|content|draft))\b/i;

/**
 * @param {string} reason          the applicant's words
 * @param {{ email?: string }} ctx the rejected draft's recipient
 */
export function classifyRejectReason(reason, { email = '' } = {}) {
  const r = String(reason || '').trim();
  const out = {
    company: false, job: false, contact: false,
    aliasFamilies: [], allRoleAliases: false, wording: false, recognized: false,
  };
  if (!r) return out;

  out.company = COMPANY_RE.test(r);
  out.job = JOB_RE.test(r);

  const recipientFamily = aliasFamilyOf(email);
  const mentionsAddress = ADDRESS_WORD_RE.test(r);
  for (const [fam, re] of FAMILY_PATTERNS) {
    if (!re.test(r)) continue;
    // Learn when the reason names the family alongside an address word
    // ("no hello@ emails"), or names the recipient's own distinctive alias
    // ("has founders in the email" rejecting founders@nango.com).
    if (mentionsAddress || (fam === recipientFamily && UNAMBIGUOUS.has(fam))) {
      out.aliasFamilies.push(fam);
    }
  }

  out.allRoleAliases = ALL_ALIASES_RE.test(r) && !GENERIC_COPY_RE.test(r)
    && (mentionsAddress || recipientFamily !== null);

  out.contact = WRONG_PERSON_RE.test(r) || out.aliasFamilies.length > 0 || out.allRoleAliases;
  out.wording = WORDING_RE.test(r) && !out.company && !out.job && !out.contact;
  out.recognized = out.company || out.job || out.contact || out.wording;
  return out;
}
