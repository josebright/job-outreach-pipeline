// remoteok.js - RemoteOK job board API integration
// Free, no auth required. Global remote tech jobs.
import axios from 'axios';
import { log } from '../utils.js';

const API_URL = 'https://remoteok.com/api';

/**
 * Normalize RemoteOK job to common schema
 */
function normalizeJob(job) {
  const postedDate = job.date ? new Date(job.date).toISOString() : new Date().toISOString();

  return {
    id: `remoteok-${job.id}`,
    title: job.position || '',
    company: job.company || 'Unknown',
    location: job.location || 'Remote',
    description: (job.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    salary_min: job.salary_min ? parseInt(job.salary_min, 10) : null,
    salary_max: job.salary_max ? parseInt(job.salary_max, 10) : null,
    currency: 'USD',
    url: job.url ? `https://remoteok.com${job.url}` : '',
    apply_url: job.apply_url || (job.url ? `https://remoteok.com${job.url}` : ''),
    posted_date: postedDate,
    source: 'remoteok',
    remote: true,
    sponsorship_mentioned: checkSponsorship(job),
    job_type: 'full_time',
    country: 'REMOTE',
    tags: job.tags || [],
  };
}

function checkSponsorship(job) {
  const text = `${job.position} ${job.description} ${(job.tags || []).join(' ')}`.toLowerCase();
  return /\b(sponsor|visa|relocation|h1b|work permit)\b/.test(text);
}

/**
 * Filter jobs posted within the last N hours
 */
function filterByAge(jobs, maxAgeHours) {
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  return jobs.filter(job => {
    const posted = new Date(job.posted_date).getTime();
    return posted >= cutoff;
  });
}

/**
 * Fetch jobs from RemoteOK
 */
export async function fetchJobs(query, options = {}) {
  const { maxAge = 24 } = options;

  log('info', 'RemoteOK: Fetching jobs...');

  try {
    const response = await axios.get(API_URL, {
      headers: {
        'User-Agent': 'JobFinder/2.0 (job search tool)',
      },
      timeout: 15000,
    });

    // RemoteOK returns array where first element is metadata
    let jobs = Array.isArray(response.data) ? response.data.slice(1) : [];

    // Filter by query keywords
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);
    jobs = jobs.filter(job => {
      const text = `${job.position || ''} ${(job.tags || []).join(' ')} ${job.description || ''}`.toLowerCase();
      return queryWords.some(word => text.includes(word));
    });

    // Normalize and filter by age
    const normalized = jobs.map(normalizeJob);
    const filtered = filterByAge(normalized, maxAge);

    log('info', `RemoteOK: Found ${filtered.length} jobs (from ${normalized.length} total)`);
    return filtered;
  } catch (error) {
    log('warn', `RemoteOK: Error fetching jobs: ${error.message}`);
    return [];
  }
}
