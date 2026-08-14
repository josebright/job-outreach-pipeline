// adzuna.js - Adzuna job board API integration
// Free tier: 250 requests/day. Covers: US, UK, CA, AU, DE, FR, NL, AT, BR, IN, NZ, PL, RU, SG, ZA
import axios from 'axios';
import { config } from '../config.js';
import { log, sleep } from '../utils.js';

// Adzuna country codes mapped to our target countries
const COUNTRY_MAP = {
  us: 'us', gb: 'gb', ca: 'ca', au: 'au', de: 'de',
  fr: 'fr', nl: 'nl', at: 'at', pl: 'pl', nz: 'nz',
  sg: 'sg', in: 'in', br: 'br', za: 'za',
};

/**
 * Fetch jobs from Adzuna API for a specific country
 */
async function fetchForCountry(country, query, options = {}) {
  const { maxAge = 1, page = 1, resultsPerPage = 50 } = options;

  const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`;

  try {
    const response = await axios.get(url, {
      params: {
        app_id: config.adzunaAppId,
        app_key: config.adzunaAppKey,
        what: query,
        max_days_old: maxAge,
        results_per_page: resultsPerPage,
        sort_by: 'date',
        full_time: 1,
      },
      timeout: 15000,
    });

    const results = response.data?.results || [];
    return results.map(job => normalizeJob(job, country));
  } catch (error) {
    if (error.response?.status === 401) {
      log('warn', `Adzuna: Invalid API credentials for ${country}`);
    } else if (error.response?.status === 429) {
      log('warn', 'Adzuna: Rate limit reached');
    } else {
      log('debug', `Adzuna: Error fetching ${country}: ${error.message}`);
    }
    return [];
  }
}

/**
 * Normalize Adzuna job to common schema
 */
function normalizeJob(job, country) {
  return {
    id: `adzuna-${job.id}`,
    title: job.title || '',
    company: job.company?.display_name || 'Unknown',
    location: job.location?.display_name || '',
    description: job.description || '',
    salary_min: job.salary_min || null,
    salary_max: job.salary_max || null,
    currency: getCurrency(country),
    url: job.redirect_url || '',
    apply_url: job.redirect_url || '',
    posted_date: job.created || new Date().toISOString(),
    source: 'adzuna',
    remote: isRemoteJob(job),
    sponsorship_mentioned: checkSponsorship(job),
    job_type: job.contract_type || 'full_time',
    country: country.toUpperCase(),
  };
}

function getCurrency(country) {
  const map = { us: 'USD', gb: 'GBP', ca: 'CAD', au: 'AUD', de: 'EUR', fr: 'EUR', nl: 'EUR', at: 'EUR', pl: 'PLN', nz: 'NZD' };
  return map[country] || 'USD';
}

function isRemoteJob(job) {
  const text = `${job.title} ${job.description} ${job.location?.display_name}`.toLowerCase();
  return /\b(remote|work from home|wfh|distributed|anywhere)\b/.test(text);
}

function checkSponsorship(job) {
  const text = `${job.title} ${job.description}`.toLowerCase();
  return /\b(sponsor|visa|relocation|h1b|work permit)\b/.test(text);
}

/**
 * Fetch jobs from Adzuna across all target countries
 */
export async function fetchJobs(query, options = {}) {
  if (!config.adzunaAppId || !config.adzunaAppKey) {
    log('info', 'Adzuna: Skipped (no API credentials). Get free keys at https://developer.adzuna.com/');
    return [];
  }

  log('info', 'Adzuna: Fetching jobs...');
  const targetCountries = config.search.targetCountries.filter(c => COUNTRY_MAP[c]);
  const allJobs = [];

  for (const country of targetCountries) {
    const jobs = await fetchForCountry(country, query, options);
    allJobs.push(...jobs);
    await sleep(config.rateLimits.apiRequestDelay);
  }

  log('info', `Adzuna: Found ${allJobs.length} jobs across ${targetCountries.length} countries`);
  return allJobs;
}
