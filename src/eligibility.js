// eligibility.js - Job eligibility filtering for remote/sponsorship/Nigeria-friendly positions
import { log } from './utils.js';

// Keywords that indicate visa sponsorship
const SPONSOR_KEYWORDS = [
  'sponsor', 'sponsorship', 'visa sponsorship', 'work visa', 'work permit',
  'relocation', 'relocation assistance', 'h1b', 'h-1b', 'h1b sponsorship',
  'green card', 'permanent residence', 'immigration', 'international',
  'global talent', 'talent visa', 'skilled worker visa', 'work authorization',
  'sponsor visa', 'visa support', 'immigration support', 'legal status',
  'work authorization', 'employment authorization', 'e-verify', 'i-9',
  'foreign worker', 'international worker', 'overseas', 'expat', 'expatriate'
];

// Keywords that indicate remote work
const REMOTE_KEYWORDS = [
  'remote', 'work from home', 'wfh', 'anywhere', 'distributed', 'fully remote',
  'remote-first', 'remote work', 'telecommute', 'telecommuting', 'virtual',
  'online', 'digital nomad', 'location independent', 'work anywhere',
  'flexible location', 'no location requirement', 'global remote',
  'worldwide remote', 'international remote', 'remote friendly',
  'remote option', 'hybrid remote', 'partially remote', 'mostly remote'
];

// Keywords that indicate Nigeria/Nigerian-friendly positions
const NIGERIA_KEYWORDS = [
  'nigeria', 'nigerian', 'lagos', 'abuja', 'kano', 'ibadan', 'port harcourt',
  'benin city', 'kaduna', 'maiduguri', 'zaria', 'aba', 'jos', 'ilorin',
  'oyo', 'enugu', 'abeokuta', 'sokoto', 'onitsha', 'warri', 'calabar',
  'africa', 'african', 'west africa', 'sub-saharan', 'developing country',
  'emerging market', 'global south', 'international applicant',
  'open to international', 'worldwide', 'global', 'international',
  'diverse', 'inclusive', 'equal opportunity', 'non-discriminatory'
];

// Target countries for job search
const TARGET_COUNTRY_KEYWORDS = {
  us: ['united states', 'usa', 'u.s.', 'new york', 'san francisco', 'seattle', 'austin', 'boston', 'chicago', 'los angeles', 'denver'],
  gb: ['united kingdom', 'uk', 'u.k.', 'london', 'manchester', 'edinburgh', 'birmingham', 'bristol', 'cambridge', 'oxford'],
  ca: ['canada', 'toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', 'waterloo'],
  au: ['australia', 'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide'],
  de: ['germany', 'berlin', 'munich', 'hamburg', 'frankfurt', 'stuttgart', 'cologne'],
  fr: ['france', 'paris', 'lyon', 'toulouse', 'marseille'],
  nl: ['netherlands', 'amsterdam', 'rotterdam', 'the hague', 'eindhoven', 'utrecht'],
  ie: ['ireland', 'dublin', 'cork', 'galway'],
  se: ['sweden', 'stockholm', 'gothenburg', 'malmo'],
  dk: ['denmark', 'copenhagen'],
  no: ['norway', 'oslo', 'bergen'],
  fi: ['finland', 'helsinki', 'espoo', 'tampere'],
  es: ['spain', 'barcelona', 'madrid'],
  pt: ['portugal', 'lisbon', 'porto'],
  at: ['austria', 'vienna', 'graz'],
  ch: ['switzerland', 'zurich', 'geneva', 'basel', 'bern'],
  be: ['belgium', 'brussels', 'antwerp', 'ghent'],
  pl: ['poland', 'warsaw', 'krakow', 'wroclaw', 'gdansk'],
};

// Keywords that indicate location restrictions (negative indicators)
const LOCATION_RESTRICTION_KEYWORDS = [
  'us only', 'usa only', 'united states only', 'american only',
  'eu only', 'europe only', 'european only', 'uk only', 'british only',
  'canada only', 'canadian only', 'australia only', 'australian only',
  'must be located in', 'must reside in', 'local only', 'onsite only',
  'no remote', 'no work from home', 'office based', 'in-person',
  'physical presence', 'local candidate', 'citizen only', 'permanent resident only'
];

// Keywords that indicate seniority levels
const SENIORITY_KEYWORDS = {
  senior: ['senior', 'sr', 'lead', 'principal', 'staff', 'architect', 'expert'],
  mid: ['mid-level', 'mid level', 'intermediate', 'experienced', 'mid-senior'],
  junior: ['junior', 'jr', 'entry', 'entry-level', 'entry level', 'graduate', 'trainee'],
  manager: ['manager', 'mgr', 'director', 'head', 'chief', 'vp', 'vice president', 'cto', 'ceo']
};

// Keywords that indicate job types
const JOB_TYPE_KEYWORDS = {
  fulltime: ['full-time', 'full time', 'permanent', 'salaried', 'employee'],
  parttime: ['part-time', 'part time', 'contractor', 'freelance', 'consultant'],
  contract: ['contract', 'temporary', 'temp', 'project-based', 'gig'],
  internship: ['intern', 'internship', 'co-op', 'coop', 'trainee', 'apprentice']
};

/**
 * Check if text contains any of the specified keywords
 * @param {string} text - Text to search
 * @param {string[]} keywords - Keywords to search for
 * @param {boolean} caseSensitive - Whether to perform case-sensitive search
 * @returns {boolean} - True if any keyword is found
 */
function hasAnyKeyword(text, keywords, caseSensitive = false) {
  if (!text || !keywords || keywords.length === 0) return false;
  
  const searchText = caseSensitive ? text : text.toLowerCase();
  const searchKeywords = caseSensitive ? keywords : keywords.map(k => k.toLowerCase());
  
  return searchKeywords.some(keyword => searchText.includes(keyword));
}

/**
 * Check if job offers remote work
 * @param {Object} job - Job object
 * @returns {boolean} - True if remote work is offered
 */
export function isRemote(job) {
  if (!job) return false;
  
  const searchText = [
    job.title || '',
    job.description || '',
    job.location || '',
    job.salary || ''
  ].join(' ').toLowerCase();
  
  // Check for remote keywords
  const hasRemoteKeywords = hasAnyKeyword(searchText, REMOTE_KEYWORDS);
  
  // Check for location restriction keywords (negative indicators)
  const hasLocationRestrictions = hasAnyKeyword(searchText, LOCATION_RESTRICTION_KEYWORDS);
  
  return hasRemoteKeywords && !hasLocationRestrictions;
}

/**
 * Check if job offers visa sponsorship
 * @param {Object} job - Job object
 * @returns {boolean} - True if visa sponsorship is offered
 */
export function offersSponsorship(job) {
  if (!job) return false;
  
  const searchText = [
    job.title || '',
    job.description || '',
    job.location || ''
  ].join(' ').toLowerCase();
  
  return hasAnyKeyword(searchText, SPONSOR_KEYWORDS);
}

/**
 * Check if job is Nigeria/Nigerian-friendly
 * @param {Object} job - Job object
 * @returns {boolean} - True if Nigeria-friendly
 */
export function isNigeriaFriendly(job) {
  if (!job) return false;
  
  const searchText = [
    job.title || '',
    job.description || '',
    job.location || ''
  ].join(' ').toLowerCase();
  
  return hasAnyKeyword(searchText, NIGERIA_KEYWORDS);
}

/**
 * Check if job has location restrictions
 * @param {Object} job - Job object
 * @returns {boolean} - True if has location restrictions
 */
export function hasLocationRestrictions(job) {
  if (!job) return false;
  
  const searchText = [
    job.title || '',
    job.description || '',
    job.location || ''
  ].join(' ').toLowerCase();
  
  return hasAnyKeyword(searchText, LOCATION_RESTRICTION_KEYWORDS);
}

/**
 * Check if job is eligible based on all criteria
 * @param {Object} job - Job object
 * @param {Object} options - Eligibility options
 * @returns {boolean} - True if job is eligible
 */
export function isEligible(job, options = {}) {
  if (!job) return false;
  
  const {
    requireRemote = true,
    requireSponsorship = false,
    requireNigeriaFriendly = false,
    allowLocationRestrictions = false
  } = options;
  
  // Check location restrictions first
  if (!allowLocationRestrictions && hasLocationRestrictions(job)) {
    log('debug', `Job rejected due to location restrictions: ${job.title || 'Unknown'}`);
    return false;
  }
  
  // Check remote work requirement
  if (requireRemote && !isRemote(job)) {
    log('debug', `Job rejected - not remote: ${job.title || 'Unknown'}`);
    return false;
  }
  
  // Check sponsorship requirement
  if (requireSponsorship && !offersSponsorship(job)) {
    log('debug', `Job rejected - no sponsorship: ${job.title || 'Unknown'}`);
    return false;
  }
  
  // Check Nigeria-friendly requirement
  if (requireNigeriaFriendly && !isNigeriaFriendly(job)) {
    log('debug', `Job rejected - not Nigeria-friendly: ${job.title || 'Unknown'}`);
    return false;
  }
  
  // If we reach here, job meets all requirements
  log('debug', `Job eligible: ${job.title || 'Unknown'}`);
  return true;
}

/**
 * Get detailed eligibility analysis for a job
 * @param {Object} job - Job object
 * @returns {Object} - Detailed eligibility analysis
 */
export function getEligibilityAnalysis(job) {
  if (!job) {
    return {
      isEligible: false,
      reasons: ['No job data provided'],
      remote: false,
      sponsorship: false,
      nigeriaFriendly: false,
      locationRestrictions: false
    };
  }
  
  const remote = isRemote(job);
  const sponsorship = offersSponsorship(job);
  const nigeriaFriendly = isNigeriaFriendly(job);
  const locationRestrictions = hasLocationRestrictions(job);
  
  const reasons = [];
  
  if (locationRestrictions) {
    reasons.push('Has location restrictions');
  }
  
  if (!remote) {
    reasons.push('Not remote');
  }
  
  if (!sponsorship) {
    reasons.push('No visa sponsorship mentioned');
  }
  
  if (!nigeriaFriendly) {
    reasons.push('Not explicitly Nigeria-friendly');
  }
  
  const isEligible = !locationRestrictions && (remote || sponsorship || nigeriaFriendly);
  
  if (isEligible) {
    reasons.push('Meets eligibility criteria');
  }
  
  return {
    isEligible,
    reasons,
    remote,
    sponsorship,
    nigeriaFriendly,
    locationRestrictions,
    confidence: calculateEligibilityConfidence(remote, sponsorship, nigeriaFriendly, locationRestrictions)
  };
}

/**
 * Calculate confidence score for eligibility
 * @param {boolean} remote - Is remote
 * @param {boolean} sponsorship - Offers sponsorship
 * @param {boolean} nigeriaFriendly - Is Nigeria-friendly
 * @param {boolean} locationRestrictions - Has location restrictions
 * @returns {number} - Confidence score (0-1)
 */
function calculateEligibilityConfidence(remote, sponsorship, nigeriaFriendly, locationRestrictions) {
  if (locationRestrictions) return 0;
  
  let score = 0;
  let factors = 0;
  
  if (remote) {
    score += 0.4;
    factors++;
  }
  
  if (sponsorship) {
    score += 0.4;
    factors++;
  }
  
  if (nigeriaFriendly) {
    score += 0.2;
    factors++;
  }
  
  return factors > 0 ? score : 0;
}

/**
 * Filter jobs based on eligibility criteria
 * @param {Object[]} jobs - Array of job objects
 * @param {Object} options - Eligibility options
 * @returns {Object[]} - Filtered array of eligible jobs
 */
export function filterEligibleJobs(jobs, options = {}) {
  if (!jobs || !Array.isArray(jobs)) return [];
  
  log('info', `Filtering ${jobs.length} jobs for eligibility`);
  
  const eligibleJobs = jobs.filter(job => isEligible(job, options));
  
  log('info', `Found ${eligibleJobs.length} eligible jobs out of ${jobs.length} total`);
  
  return eligibleJobs;
}

/**
 * Get eligibility statistics for a set of jobs
 * @param {Object[]} jobs - Array of job objects
 * @returns {Object} - Eligibility statistics
 */
export function getEligibilityStats(jobs) {
  if (!jobs || !Array.isArray(jobs)) {
    return {
      total: 0,
      remote: 0,
      sponsorship: 0,
      nigeriaFriendly: 0,
      locationRestrictions: 0,
      eligible: 0
    };
  }
  
  const stats = {
    total: jobs.length,
    remote: 0,
    sponsorship: 0,
    nigeriaFriendly: 0,
    locationRestrictions: 0,
    eligible: 0
  };
  
  jobs.forEach(job => {
    if (isRemote(job)) stats.remote++;
    if (offersSponsorship(job)) stats.sponsorship++;
    if (isNigeriaFriendly(job)) stats.nigeriaFriendly++;
    if (hasLocationRestrictions(job)) stats.locationRestrictions++;
    if (isEligible(job)) stats.eligible++;
  });
  
  return stats;
}

/**
 * Check if job matches seniority level
 * @param {Object} job - Job object
 * @param {string} targetSeniority - Target seniority level
 * @returns {boolean} - True if matches seniority
 */
export function matchesSeniority(job, targetSeniority) {
  if (!job || !targetSeniority) return true;
  
  const searchText = [
    job.title || '',
    job.description || ''
  ].join(' ').toLowerCase();
  
  const targetKeywords = SENIORITY_KEYWORDS[targetSeniority.toLowerCase()];
  if (!targetKeywords) return true;
  
  return hasAnyKeyword(searchText, targetKeywords);
}

/**
 * Check if job matches job type
 * @param {Object} job - Job object
 * @param {string} targetJobType - Target job type
 * @returns {boolean} - True if matches job type
 */
export function matchesJobType(job, targetJobType) {
  if (!job || !targetJobType) return true;
  
  const searchText = [
    job.title || '',
    job.description || ''
  ].join(' ').toLowerCase();
  
  const targetKeywords = JOB_TYPE_KEYWORDS[targetJobType.toLowerCase()];
  if (!targetKeywords) return true;
  
  return hasAnyKeyword(searchText, targetKeywords);
}

/**
 * Check if job is in one of the target countries
 * @param {Object} job - Job object
 * @returns {string|null} - Country code if in target country, null otherwise
 */
export function detectTargetCountry(job) {
  if (!job) return null;

  const searchText = [
    job.title || '',
    job.location || '',
    job.description || ''
  ].join(' ').toLowerCase();

  for (const [code, keywords] of Object.entries(TARGET_COUNTRY_KEYWORDS)) {
    if (keywords.some(kw => searchText.includes(kw))) {
      return code.toUpperCase();
    }
  }

  return null;
}

/**
 * Check if job is accessible to a Nigerian applicant
 * (remote, offers sponsorship, or in a target country)
 */
export function isAccessible(job) {
  if (!job) return false;
  return isRemote(job) || offersSponsorship(job) || isNigeriaFriendly(job) || detectTargetCountry(job) !== null;
}
