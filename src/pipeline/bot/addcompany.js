// bot/addcompany.js
// Helper for the /addcompany Telegram command. Given a LinkedIn company URL
// (or a plain "name slug ats" triple), figure out the ATS + slug and add
// the row to the pipeline. Manual, legal path — no scraping of LinkedIn
// itself. LinkedIn's role here is only to give us a canonical company
// handle we can probe against ATS endpoints.
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

/**
 * Main entrypoint: given a raw input (LinkedIn URL, ATS URL, or `name slug ats`),
 * figure out the ATS + slug, probe to confirm, and upsert into the DB.
 * Returns `{ status, company?, message }`.
 *   status: 'added' | 'exists' | 'not_found' | 'invalid'
 */
export async function addCompanyFromInput(input, { probe = probeAtsForSlug } = {}) {
  const raw = String(input || '').trim();
  if (!raw) return { status: 'invalid', message: 'Empty input.' };

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

  // 2. LinkedIn URL → derive slug, then probe each ATS.
  const liSlug = parseLinkedInCompanySlug(raw);
  if (liSlug) {
    const hit = await probe(liSlug);
    if (!hit) {
      return {
        status: 'not_found',
        message: `Parsed LinkedIn slug "${liSlug}" but no supported ATS returned jobs for it. ` +
                 `Find the company's careers page and pass the ATS URL directly.`,
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

  // 3. Fallback: literal `name slug ats` triple.
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
    message: 'Pass a LinkedIn company URL, an ATS URL, or `<name> <slug> <ats>`.',
  };
}
