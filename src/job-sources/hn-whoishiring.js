// hn-whoishiring.js - Hacker News "Who's Hiring" thread via Algolia API
// Free, no auth required. Monthly threads with high-quality tech jobs.
import axios from 'axios';
import { log } from '../utils.js';
import { config } from '../config.js';

const ALGOLIA_API = 'https://hn.algolia.com/api/v1';

/**
 * Find the latest "Who is hiring?" thread
 */
async function findLatestThread() {
  try {
    const response = await axios.get(`${ALGOLIA_API}/search`, {
      params: {
        query: 'Ask HN: Who is hiring?',
        tags: 'ask_hn',
        numericFilters: `created_at_i>${Math.floor(Date.now() / 1000) - 35 * 24 * 3600}`,
      },
      timeout: 15000,
    });

    const hits = response.data?.hits || [];
    const thread = hits.find(h =>
      h.title && h.title.toLowerCase().includes('who is hiring')
    );

    return thread?.objectID || null;
  } catch (error) {
    log('warn', `HN: Error finding latest thread: ${error.message}`);
    return null;
  }
}

/**
 * Fetch comments from a thread
 */
async function fetchComments(threadId) {
  try {
    const response = await axios.get(`${ALGOLIA_API}/items/${threadId}`, {
      timeout: 30000,
    });

    return response.data?.children || [];
  } catch (error) {
    log('warn', `HN: Error fetching comments: ${error.message}`);
    return [];
  }
}

/**
 * Parse a HN hiring comment into job data
 */
function parseComment(comment) {
  const text = comment.text || '';
  if (!text || text.length < 50) return null;

  // Clean HTML
  const cleanedText = text.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

  // Extract company name (usually first line before | or -)
  const firstLine = cleanedText.split(/[|\n]/)[0].trim();
  const companyMatch = firstLine.match(/^([^|]+?)(?:\s*\||\s*-|\s*–)/);
  const company = companyMatch ? companyMatch[1].trim() : firstLine.substring(0, 50);

  // Extract title/role
  const titleMatch = cleanedText.match(/\b((?:Senior|Staff|Lead|Principal|Junior)?\s*(?:Software|Backend|Frontend|Full[- ]?Stack|DevOps|SRE|Platform|Cloud|Data|ML|AI)\s*(?:Engineer|Developer|Architect))\b/i);
  const title = titleMatch ? titleMatch[1] : 'Software Engineer';

  // Extract location
  const locationMatch = cleanedText.match(/\b(Remote|REMOTE|Onsite|ONSITE|Hybrid|HYBRID)\b/i);
  const remote = /\bremote\b/i.test(cleanedText);
  const location = locationMatch ? locationMatch[1] : (remote ? 'Remote' : 'Unknown');

  // Check for visa/sponsorship
  const sponsorship = /\b(visa|sponsor|relocation|h1b|h-1b|work permit)\b/i.test(cleanedText);

  // Extract URL
  const urlMatch = cleanedText.match(/https?:\/\/[^\s,)]+/);

  return {
    id: `hn-${comment.id}`,
    title: title,
    company: company.substring(0, 100),
    location: location,
    description: cleanedText,
    salary_min: null,
    salary_max: null,
    currency: 'USD',
    url: urlMatch ? urlMatch[0] : `https://news.ycombinator.com/item?id=${comment.id}`,
    apply_url: urlMatch ? urlMatch[0] : `https://news.ycombinator.com/item?id=${comment.id}`,
    posted_date: comment.created_at || new Date().toISOString(),
    source: 'hackernews',
    remote: remote,
    sponsorship_mentioned: sponsorship,
    job_type: 'full_time',
    country: 'VARIOUS',
  };
}

/**
 * Filter for software engineering jobs matching our criteria
 */
function filterRelevantJobs(jobs, query) {
  const queryWords = query.toLowerCase().split(/\s+/);
  const targetCountries = config.search.targetCountryNames.map(c => c.toLowerCase());

  return jobs.filter(job => {
    const text = `${job.title} ${job.description}`.toLowerCase();

    // Must match at least one query keyword
    const matchesQuery = queryWords.some(word => text.includes(word));

    // Must be remote or in target countries
    const isRemote = job.remote;
    const inTargetCountry = targetCountries.some(c => text.includes(c)) ||
      /\b(us|usa|uk|canada|australia|europe|eu)\b/i.test(text);

    return matchesQuery && (isRemote || inTargetCountry || job.sponsorship_mentioned);
  });
}

/**
 * Fetch jobs from HN Who's Hiring
 */
export async function fetchJobs(query, options = {}) {
  log('info', 'HN Who\'s Hiring: Fetching jobs...');

  try {
    const threadId = await findLatestThread();
    if (!threadId) {
      log('warn', 'HN: No recent "Who is hiring?" thread found');
      return [];
    }

    log('info', `HN: Found thread ${threadId}, fetching comments...`);
    const comments = await fetchComments(threadId);

    // Parse comments into jobs
    const jobs = comments
      .map(parseComment)
      .filter(Boolean);

    // Filter relevant jobs
    const filtered = filterRelevantJobs(jobs, query);

    log('info', `HN: Found ${filtered.length} relevant jobs (from ${jobs.length} total comments)`);
    return filtered;
  } catch (error) {
    log('warn', `HN: Error: ${error.message}`);
    return [];
  }
}
