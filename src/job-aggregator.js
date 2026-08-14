// job-aggregator.js - Orchestrate all job sources in parallel, deduplicate, normalize
import pLimit from 'p-limit';
import { config } from './config.js';
import { log, simpleHash } from './utils.js';
import { isRemote, offersSponsorship, isNigeriaFriendly } from './eligibility.js';

import { fetchJobs as fetchAdzuna } from './job-sources/adzuna.js';
import { fetchJobs as fetchRemoteOK } from './job-sources/remoteok.js';
import { fetchJobs as fetchArbeitnow } from './job-sources/arbeitnow.js';
import { fetchJobs as fetchHN } from './job-sources/hn-whoishiring.js';
import { fetchJobs as fetchReed } from './job-sources/reed.js';

const limit = pLimit(config.rateLimits.concurrentRequests);

/**
 * Build search queries from config keywords
 */
function buildQueries() {
  // Group keywords into a few broad queries to reduce API calls
  return [
    'software engineer',
    'backend developer',
    'fullstack developer',
    'frontend developer',
    'devops engineer',
  ];
}

/**
 * Deduplicate jobs by title + company similarity
 */
function deduplicateJobs(jobs) {
  const seen = new Map();

  for (const job of jobs) {
    const key = `${job.company.toLowerCase().trim()}-${job.title.toLowerCase().trim()}`;
    const hash = simpleHash(key);

    if (!seen.has(hash)) {
      seen.set(hash, job);
    } else {
      // Keep the one with more description content
      const existing = seen.get(hash);
      if ((job.description || '').length > (existing.description || '').length) {
        seen.set(hash, job);
      }
    }
  }

  return Array.from(seen.values());
}

/**
 * Filter jobs by target country/remote eligibility
 */
function filterByEligibility(jobs) {
  const targetCodes = new Set(config.search.targetCountries.map(c => c.toUpperCase()));

  return jobs.filter(job => {
    // Remote jobs always pass
    if (job.remote) return true;

    // Jobs in target countries pass
    if (job.country && targetCodes.has(job.country.toUpperCase())) return true;

    // Jobs mentioning sponsorship pass
    if (job.sponsorship_mentioned) return true;

    // Check with eligibility module
    if (isRemote(job) || offersSponsorship(job) || isNigeriaFriendly(job)) return true;

    return false;
  });
}

/**
 * Filter jobs posted within the max age window
 */
function filterByAge(jobs, maxAgeHours) {
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;

  return jobs.filter(job => {
    if (!job.posted_date) return true; // Keep if no date (better to include than miss)
    const posted = new Date(job.posted_date).getTime();
    return !isNaN(posted) && posted >= cutoff;
  });
}

/**
 * Fetch from a single source with error handling
 */
async function fetchFromSource(sourceName, fetchFn, query, options) {
  try {
    return await fetchFn(query, options);
  } catch (error) {
    log('error', `${sourceName}: Unhandled error: ${error.message}`);
    return [];
  }
}

/**
 * Aggregate jobs from all sources
 */
export async function aggregateJobs(options = {}) {
  const { maxAgeHours = config.search.maxAgeHours } = options;
  const queries = buildQueries();
  const primaryQuery = queries[0]; // Use primary query for initial fetch

  log('info', `Fetching jobs from all sources (max age: ${maxAgeHours}h)...`);

  // Fetch from all sources in parallel
  const sourceResults = await Promise.allSettled([
    limit(() => fetchFromSource('Adzuna', fetchAdzuna, primaryQuery, { maxAge: Math.ceil(maxAgeHours / 24) || 1 })),
    limit(() => fetchFromSource('RemoteOK', fetchRemoteOK, 'engineer developer', { maxAge: maxAgeHours })),
    limit(() => fetchFromSource('Arbeitnow', fetchArbeitnow, 'software engineer', { maxAge: maxAgeHours })),
    limit(() => fetchFromSource('HN', fetchHN, 'engineer developer software', { maxAge: maxAgeHours })),
    limit(() => fetchFromSource('Reed', fetchReed, 'software engineer', { maxAge: maxAgeHours })),
  ]);

  // Collect all results
  let allJobs = [];
  const sourceStats = {};

  const sourceNames = ['Adzuna', 'RemoteOK', 'Arbeitnow', 'HN Who\'s Hiring', 'Reed'];
  sourceResults.forEach((result, i) => {
    const name = sourceNames[i];
    if (result.status === 'fulfilled') {
      const jobs = result.value;
      sourceStats[name] = jobs.length;
      allJobs.push(...jobs);
    } else {
      sourceStats[name] = 0;
      log('error', `${name}: Failed - ${result.reason}`);
    }
  });

  log('info', `Raw jobs fetched: ${allJobs.length}`);
  log('info', `Source breakdown: ${JSON.stringify(sourceStats)}`);

  // Filter by age
  allJobs = filterByAge(allJobs, maxAgeHours);
  log('info', `After age filter (${maxAgeHours}h): ${allJobs.length}`);

  // Filter by eligibility (remote/sponsorship/target country)
  allJobs = filterByEligibility(allJobs);
  log('info', `After eligibility filter: ${allJobs.length}`);

  // Deduplicate
  allJobs = deduplicateJobs(allJobs);
  log('info', `After deduplication: ${allJobs.length}`);

  // Sort by posted date (newest first)
  allJobs.sort((a, b) => new Date(b.posted_date) - new Date(a.posted_date));

  return {
    jobs: allJobs,
    stats: {
      total: allJobs.length,
      sources: sourceStats,
      fetched_at: new Date().toISOString(),
    },
  };
}
