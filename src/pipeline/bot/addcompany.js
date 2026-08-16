// bot/addcompany.js
// Helper for the /addcompany Telegram command. Given a LinkedIn company URL
// (or a plain "name slug ats" triple), figure out the ATS + slug and add
// the row to the pipeline. Manual, legal path — no scraping of LinkedIn
// itself. LinkedIn's role here is only to give us a canonical company
// handle we can probe against ATS endpoints.
//
// If the URL doesn't fit any supported shape, return a targeted message
// explaining what would work — never a generic "invalid" without context.
// The applicant is a human trying to help the pipeline; unhelpful errors
// waste their time.
import { upsertCompany } from '../db/repo.js';
import { getAts, listAts } from '../ingest/ats/index.js';

// Extract the company slug from a LinkedIn company URL.
// e.g., https://www.linkedin.com/company/modal-labs/ -> "modal-labs"
export function parseLinkedInCompanySlug(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/linkedin\.com\/company\/([a-z0-9][a-z0-9-]*[a-z0-9])/i);
  return m ? m[1].toLowerCase() : null;
}

// Detect LinkedIn *job* URLs — we can't extract the company from just a
// job ID without scraping LinkedIn (against ToS).
export function isLinkedInJobUrl(input) {
  return /linkedin\.com\/jobs\/view\/\d+/i.test(String(input || ''));
}

// Detect a generic company website URL. Anything that looks like a URL
// but isn't a known ATS or LinkedIn shape. Used to give the "we need an
// ATS" message rather than a generic reject.
export function extractDomain(input) {
  try {
    const s = String(input || '').trim();
    if (!/^https?:\/\//i.test(s)) return null;
    const u = new URL(s);
    return u.hostname.replace(/^www\./, '');
  } catch { return null; }
}

// Extract a slug from any known ATS URL.
const ATS_URL_MATCHERS = [
  { ats: 'greenhouse',      re: /boards\.greenhouse\.io\/([a-z0-9-]+)/i },
  { ats: 'greenhouse',      re: /job-boards\.greenhouse\.io\/([a-z0-9-]+)/i },
  { ats: 'lever',           re: /jobs\.lever\.co\/([a-z0-9-]+)/i },
  { ats: 'ashby',           re: /jobs\.ashbyhq\.com\/([a-z0-9-]+)/i },
  { ats: 'workable',        re: /apply\.workable\.com\/([a-z0-9-]+)/i },
  { ats: 'smartrecruiters', re: /jobs\.smartrecruiters\.com\/([a-z0-9-]+)/i },
];

export function parseAtsUrl(input) {
  const s = String(input || '').trim();
  for (const { ats, re } of ATS_URL_MATCHERS) {
    const m = s.match(re);
    if (m) return { ats, slug: m[1].toLowerCase() };
  }
  return null;
}

// Probe each ATS with a candidate slug. Returns the first one that
// returns >=1 job (i.e., is live). Tries a small set of slug variants
// (as-typed and common punctuation collapses).
export async function probeAtsForSlug(candidateSlug) {
  const variants = slugVariants(candidateSlug);
  for (const ats of listAts()) {
    const client = getAts(ats);
    for (const slug of variants) {
      try {
        const jobs = await client.fetchJobs(slug);
        if (Array.isArray(jobs) && jobs.length > 0) {
          return { ats, slug, jobCount: jobs.length };
        }
      } catch { /* try next */ }
    }
  }
  return null;
}

function slugVariants(slug) {
  const base = String(slug || '').toLowerCase().trim();
  if (!base) return [];
  const noPunct = base.replace(/[^a-z0-9]/g, '');
  const dashed = base.replace(/[_.]/g, '-');
  return Array.from(new Set([base, dashed, noPunct]));
}

// Country TLDs that would fail gate 2 (pay in USD/EUR/GBP) — the
// applicant's priority rules explicitly reject Nigerian companies
// because they pay in NGN. Flag these upfront so we don't waste an
// enrich cycle only to have qualify reject them.
const HIGH_RISK_TLDS = /\.(ng|in|br|ar|za|ke|gh|eg|pk|bd|ph|vn|id)$/i;

/**
 * Main entrypoint: given a raw input (LinkedIn URL, ATS URL, or `name slug ats`),
 * figure out the ATS + slug, probe to confirm, and upsert into the DB.
 * Returns `{ status, company?, message }`.
 *   status: 'added' | 'exists' | 'not_found' | 'invalid' | 'unsupported'
 */
export async function addCompanyFromInput(input, { probe = probeAtsForSlug } = {}) {
  const raw = String(input || '').trim();
  if (!raw) {
    return { status: 'invalid', message: 'Empty input. Usage: /addcompany <linkedin-url | ats-url | name slug ats>' };
  }

  // 1. ATS URL is the strongest signal — no probe needed.
  const atsHit = parseAtsUrl(raw);
  if (atsHit) {
    const r = upsertCompany({
      name: atsHit.slug, ats: atsHit.ats, slug: atsHit.slug, source: 'manual',
    });
    return {
      status: r.created ? 'added' : 'exists',
      company: { ats: atsHit.ats, slug: atsHit.slug },
      message: `${r.created ? 'Added' : 'Already tracked'}: ${atsHit.ats}/${atsHit.slug}`,
    };
  }

  // 2. LinkedIn JOB URL — specific case, needs a specific message.
  //    We can't extract the company from a job ID without scraping
  //    LinkedIn (against ToS).
  if (isLinkedInJobUrl(raw)) {
    return {
      status: 'unsupported',
      message: [
        "This is a LinkedIn *job* URL, not a company URL. I can't extract",
        "the company from a job ID without scraping LinkedIn.",
        '',
        'What to do:',
        '  1. Open the job in your browser',
        "  2. Click the company logo/name at the top of the posting",
        "  3. Copy that page's URL — it should look like",
        "     https://linkedin.com/company/<company-name>",
        '  4. Pass it back to /addcompany',
      ].join('\n'),
    };
  }

  // 3. LinkedIn COMPANY URL → derive slug, then probe each ATS.
  const liSlug = parseLinkedInCompanySlug(raw);
  if (liSlug) {
    const hit = await probe(liSlug);
    if (!hit) {
      return {
        status: 'not_found',
        message: [
          `Parsed LinkedIn slug "${liSlug}" but none of our supported ATSes`,
          'returned jobs for it. Supported: greenhouse, lever, ashby, workable, smartrecruiters.',
          '',
          'This usually means one of:',
          '  • The company uses a different ATS (Rippling, BambooHR, Notion careers page, etc.)',
          '    → our pipeline can\'t auto-ingest from those',
          '  • The company posts on their own careers page directly',
          '    → same limitation',
          '  • The LinkedIn slug differs from their ATS slug',
          '    → find their careers page and share the ATS URL directly',
          '',
          `If you know they're on greenhouse/lever/ashby/workable/smartrecruiters,`,
          'paste that direct URL (e.g. https://jobs.lever.co/<company>).',
        ].join('\n'),
      };
    }
    const r = upsertCompany({
      name: liSlug, ats: hit.ats, slug: hit.slug, source: 'manual',
    });
    return {
      status: r.created ? 'added' : 'exists',
      company: { ats: hit.ats, slug: hit.slug, jobs: hit.jobCount },
      message: `${r.created ? 'Added' : 'Already tracked'}: ${hit.ats}/${hit.slug} (${hit.jobCount} live jobs)`,
    };
  }

  // 4. Generic website URL (e.g., https://herakonlab.com.ng/careers/...).
  //    We can extract a domain but can't auto-ingest jobs without ATS integration.
  const domain = extractDomain(raw);
  if (domain) {
    const lines = [
      `This looks like the company's own careers page (${domain}).`,
      '',
      "Our pipeline auto-ingests jobs from Greenhouse, Lever, Ashby,",
      "Workable, or SmartRecruiters. Companies that post only on their",
      "own site can't be auto-ingested.",
    ];
    if (HIGH_RISK_TLDS.test(domain)) {
      lines.push('',
        `⚠️ The .${domain.split('.').pop()} TLD suggests a company that likely pays in local currency.`,
        'Your priority rules (gate 2) require USD/EUR/GBP, so even if we added',
        'this company, its jobs would be disqualified at the pay-currency check.');
    }
    lines.push('',
      "If they're actually on one of the supported ATSes, find that URL",
      "(e.g. https://jobs.ashbyhq.com/<slug>) and pass it here.");
    return { status: 'unsupported', message: lines.join('\n') };
  }

  // 5. Fallback: literal `name slug ats` triple.
  const parts = raw.split(/\s+/);
  if (parts.length >= 3) {
    const ats = parts[parts.length - 1].toLowerCase();
    const slug = parts[parts.length - 2].toLowerCase();
    const name = parts.slice(0, -2).join(' ');
    if (!listAts().includes(ats)) {
      return { status: 'invalid', message: `Unknown ATS "${ats}". Supported: ${listAts().join(', ')}.` };
    }
    const r = upsertCompany({ name, ats, slug, source: 'manual' });
    return {
      status: r.created ? 'added' : 'exists',
      company: { ats, slug },
      message: `${r.created ? 'Added' : 'Already tracked'}: ${ats}/${slug}`,
    };
  }

  return {
    status: 'invalid',
    message: [
      "I couldn't parse that input. Supported forms:",
      '  • ATS URL: https://boards.greenhouse.io/<slug>  (or lever, ashby, workable, smartrecruiters)',
      '  • LinkedIn company URL: https://linkedin.com/company/<slug>',
      '  • Manual triple: <name> <slug> <ats>',
    ].join('\n'),
  };
}
