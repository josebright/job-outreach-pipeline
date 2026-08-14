// arbeitnow.js - Arbeitnow job board API integration
// Free, no auth required. European tech jobs with relocation assistance.
import axios from 'axios';
import { log } from '../utils.js';

const API_URL = 'https://www.arbeitnow.com/api/job-board-api';

/**
 * Normalize Arbeitnow job to common schema
 */
function normalizeJob(job) {
  return {
    id: `arbeitnow-${job.slug || job.title?.replace(/\s+/g, '-').toLowerCase()}`,
    title: job.title || '',
    company: job.company_name || 'Unknown',
    location: job.location || '',
    description: job.description || '',
    salary_min: null,
    salary_max: null,
    currency: 'EUR',
    url: job.url || '',
    apply_url: job.url || '',
    posted_date: job.created_at ? new Date(job.created_at * 1000).toISOString() : new Date().toISOString(),
    source: 'arbeitnow',
    remote: job.remote || false,
    sponsorship_mentioned: job.visa_sponsorship || checkSponsorship(job),
    job_type: 'full_time',
    country: extractCountry(job.location),
    tags: job.tags || [],
  };
}

function checkSponsorship(job) {
  const text = `${job.title} ${job.description} ${(job.tags || []).join(' ')}`.toLowerCase();
  return /\b(sponsor|visa|relocation|h1b|work permit)\b/.test(text);
}

function extractCountry(location) {
  if (!location) return 'EU';
  const loc = location.toLowerCase();
  if (loc.includes('germany') || loc.includes('berlin') || loc.includes('munich') || loc.includes('hamburg')) return 'DE';
  if (loc.includes('netherlands') || loc.includes('amsterdam')) return 'NL';
  if (loc.includes('france') || loc.includes('paris')) return 'FR';
  if (loc.includes('austria') || loc.includes('vienna')) return 'AT';
  if (loc.includes('switzerland') || loc.includes('zurich')) return 'CH';
  if (loc.includes('spain') || loc.includes('barcelona') || loc.includes('madrid')) return 'ES';
  if (loc.includes('portugal') || loc.includes('lisbon')) return 'PT';
  if (loc.includes('ireland') || loc.includes('dublin')) return 'IE';
  if (loc.includes('sweden') || loc.includes('stockholm')) return 'SE';
  if (loc.includes('denmark') || loc.includes('copenhagen')) return 'DK';
  if (loc.includes('poland') || loc.includes('warsaw')) return 'PL';
  if (loc.includes('belgium') || loc.includes('brussels')) return 'BE';
  if (loc.includes('united kingdom') || loc.includes('london')) return 'GB';
  return 'EU';
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
 * Fetch jobs from Arbeitnow
 */
export async function fetchJobs(query, options = {}) {
  const { maxAge = 24 } = options;

  log('info', 'Arbeitnow: Fetching jobs...');

  try {
    let allJobs = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 3) {
      const response = await axios.get(API_URL, {
        params: { page },
        timeout: 15000,
      });

      const data = response.data;
      const jobs = data?.data || [];

      if (jobs.length === 0) {
        hasMore = false;
        break;
      }

      allJobs.push(...jobs);
      hasMore = !!data?.links?.next;
      page++;
    }

    // Filter by query keywords
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);
    allJobs = allJobs.filter(job => {
      const text = `${job.title || ''} ${(job.tags || []).join(' ')} ${job.description || ''}`.toLowerCase();
      return queryWords.some(word => text.includes(word));
    });

    // Normalize and filter by age
    const normalized = allJobs.map(normalizeJob);
    const filtered = filterByAge(normalized, maxAge);

    log('info', `Arbeitnow: Found ${filtered.length} jobs (from ${normalized.length} total)`);
    return filtered;
  } catch (error) {
    log('warn', `Arbeitnow: Error fetching jobs: ${error.message}`);
    return [];
  }
}
