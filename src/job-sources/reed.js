// reed.js - Reed.co.uk job board API integration
// Free API key at https://www.reed.co.uk/developers. Covers UK jobs.
import axios from 'axios';
import { config } from '../config.js';
import { log } from '../utils.js';

const API_URL = 'https://www.reed.co.uk/api/1.0/search';

/**
 * Normalize Reed job to common schema
 */
function normalizeJob(job) {
  return {
    id: `reed-${job.jobId}`,
    title: job.jobTitle || '',
    company: job.employerName || 'Unknown',
    location: job.locationName || '',
    description: job.jobDescription || '',
    salary_min: job.minimumSalary || null,
    salary_max: job.maximumSalary || null,
    currency: 'GBP',
    url: job.jobUrl || '',
    apply_url: job.jobUrl || '',
    posted_date: job.date ? new Date(job.date).toISOString() : new Date().toISOString(),
    source: 'reed',
    remote: isRemoteJob(job),
    sponsorship_mentioned: checkSponsorship(job),
    job_type: job.fullTime ? 'full_time' : (job.partTime ? 'part_time' : (job.contractType || 'full_time')),
    country: 'GB',
  };
}

function isRemoteJob(job) {
  const text = `${job.jobTitle} ${job.jobDescription} ${job.locationName}`.toLowerCase();
  return /\b(remote|work from home|wfh|distributed|anywhere)\b/.test(text);
}

function checkSponsorship(job) {
  const text = `${job.jobTitle} ${job.jobDescription}`.toLowerCase();
  return /\b(sponsor|visa|relocation|skilled worker|tier 2)\b/.test(text);
}

/**
 * Fetch jobs from Reed.co.uk
 */
export async function fetchJobs(query, options = {}) {
  if (!config.reedApiKey) {
    log('info', 'Reed: Skipped (no API key). Get a free key at https://www.reed.co.uk/developers');
    return [];
  }

  log('info', 'Reed: Fetching UK jobs...');

  try {
    const response = await axios.get(API_URL, {
      params: {
        keywords: query,
        resultsToTake: 100,
        resultsToSkip: 0,
        postedByDirectEmployer: true,
        distanceFromLocation: 0,
      },
      auth: {
        username: config.reedApiKey,
        password: '',
      },
      timeout: 15000,
    });

    const results = response.data?.results || [];

    // Filter to jobs posted in the last 24 hours
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentJobs = results.filter(job => {
      const posted = new Date(job.date).getTime();
      return posted >= cutoff;
    });

    const normalized = recentJobs.map(normalizeJob);

    log('info', `Reed: Found ${normalized.length} recent jobs (from ${results.length} total)`);
    return normalized;
  } catch (error) {
    if (error.response?.status === 401) {
      log('warn', 'Reed: Invalid API key');
    } else {
      log('warn', `Reed: Error fetching jobs: ${error.message}`);
    }
    return [];
  }
}
