// ingest/index.js
// Pulls jobs from each live slug's ATS endpoint. Upserts into DB.
import { getAts } from './ats/index.js';
import { companiesByStatus, upsertJob, setCompanyStatus, markSlugDead } from '../db/repo.js';
import { logger } from '../util/logger.js';

/**
 * Ingest all companies in status = 'discovered' | 'ingested' | 'qualified'.
 * (Re-ingest already-known companies to pick up new postings.)
 */
export async function runIngest({ statusFilter = ['discovered', 'ingested', 'qualified'] } = {}) {
  let processed = 0;
  let jobsUpserted = 0;
  let dead = 0;

  for (const status of statusFilter) {
    const companies = companiesByStatus(status);
    for (const company of companies) {
      try {
        const ats = getAts(company.ats);
        const jobs = await ats.fetchJobs(company.slug);

        if (jobs.length === 0 && status === 'discovered') {
          // No jobs and never seen alive: mark dead so we skip for 30 days.
          markSlugDead(company.ats, company.slug);
          dead++;
          logger.warn({ ats: company.ats, slug: company.slug }, 'no jobs returned, marked dead');
          continue;
        }

        for (const j of jobs) {
          const result = upsertJob({ companyId: company.id, ...j });
          if (result.created) jobsUpserted++;
        }

        // First successful ingest promotes from discovered -> ingested.
        if (status === 'discovered' && jobs.length > 0) {
          setCompanyStatus(company.id, 'ingested', { jobCount: jobs.length });
        }
        processed++;
      } catch (err) {
        logger.error({ err: err.message, company: company.slug }, 'ingest failed');
      }
    }
  }

  return { processed, jobsUpserted, dead };
}
