// salary.js - Salary parsing and currency conversion system
import fetch from 'node-fetch';
import { log, formatCurrency } from './utils.js';

// Comprehensive salary regex patterns
const SALARY_PATTERNS = [
  // Standard formats: $50,000 - $70,000 per year
  /(?:(USD|EUR|GBP|AUD|CAD|€|£|\$)\s*)?([\d,]+(?:\.\d+)?)(?:\s*(?:-|to)\s*([\d,]+(?:\.\d+)?))?\s*([\w\s]*)(?:per\s+(year|month|hour|annum|yr|mo|hr))?/gi,
  
  // Range formats: 50k-70k, 50K-70K
  /(?:(USD|EUR|GBP|AUD|CAD|€|£|\$)\s*)?([\d,]+(?:\.\d+)?)[kK](?:\s*(?:-|to)\s*([\d,]+(?:\.\d+)?)[kK])?\s*([\w\s]*)(?:per\s+(year|month|hour|annum|yr|mo|hr))?/gi,
  
  // Hourly formats: $25-35/hour, €20-30/hr
  /(?:(USD|EUR|GBP|AUD|CAD|€|£|\$)\s*)?([\d,]+(?:\.\d+)?)(?:\s*(?:-|to)\s*([\d,]+(?:\.\d+)?))?\s*\/\s*(hour|hr|h)\b/gi,
  
  // Annual formats: 50,000-70,000 annually, €60,000 per annum
  /(?:(USD|EUR|GBP|AUD|CAD|€|£|\$)\s*)?([\d,]+(?:\.\d+)?)(?:\s*(?:-|to)\s*([\d,]+(?:\.\d+)?))?\s*(?:annually|per\s+annum|per\s+year|\/yr|\/year)/gi,
  
  // Monthly formats: $4,000-5,000/month, €3,500 per month
  /(?:(USD|EUR|GBP|AUD|CAD|€|£|\$)\s*)?([\d,]+(?:\.\d+)?)(?:\s*(?:-|to)\s*([\d,]+(?:\.\d+)?))?\s*(?:per\s+month|\/mo|\/month)/gi,
  
  // Simple formats: $50k, €60k, £45k
  /(?:(USD|EUR|GBP|AUD|CAD|€|£|\$)\s*)?([\d,]+(?:\.\d+)?)[kK]\b/gi
];

// Currency symbols to codes mapping
const CURRENCY_SYMBOLS = {
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  'A$': 'AUD',
  'C$': 'CAD'
};

// Currency codes that are ambiguous (need context)
const AMBIGUOUS_CURRENCIES = ['$'];

// Default currency for ambiguous symbols
const DEFAULT_CURRENCY = 'USD';

// Hours per month for hourly conversion (160 hours = 40 hours/week * 4 weeks)
const HOURS_PER_MONTH = 160;

// Months per year
const MONTHS_PER_YEAR = 12;

// Cache for exchange rates to avoid repeated API calls
const exchangeRateCache = new Map();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Parse salary text and extract structured salary information
 * @param {string} text - Text containing salary information
 * @returns {Object|null} - Parsed salary object or null
 */
export function parseSalaryText(text) {
  if (!text || typeof text !== 'string') return null;
  
  const cleanedText = text
    .replace(/\u00A0/g, ' ') // Replace non-breaking spaces
    .replace(/,/g, '') // Remove commas for easier parsing
    .trim();
  
  if (cleanedText.length < 3) return null;
  
  log('info', `Parsing salary text: "${cleanedText}"`);
  
  // Try each pattern until we find a match
  for (const pattern of SALARY_PATTERNS) {
    const matches = [...cleanedText.matchAll(pattern)];
    
    for (const match of matches) {
      const result = parseSalaryMatch(match);
      if (result) {
        log('info', `Parsed salary: ${formatCurrency(result.low, result.currency)} - ${formatCurrency(result.high, result.currency)} ${result.period}`);
        return result;
      }
    }
  }
  
  log('warn', `No salary pattern matched for: "${cleanedText}"`);
  return null;
}

/**
 * Parse a single salary regex match
 * @param {Array} match - Regex match array
 * @returns {Object|null} - Parsed salary object or null
 */
function parseSalaryMatch(match) {
  try {
    let currency = match[1] || '';
    const lowAmount = parseFloat(match[2]);
    const highAmount = match[3] ? parseFloat(match[3]) : lowAmount;
    const context = match[4] || '';
    const period = match[5] || '';
    
    // Validate amounts
    if (isNaN(lowAmount) || lowAmount <= 0) return null;
    if (isNaN(highAmount) || highAmount <= 0) return null;
    if (highAmount < lowAmount) return null;
    
    // Normalize currency
    currency = normalizeCurrency(currency, context);
    
    // Determine period
    const normalizedPeriod = normalizePeriod(period, context);
    
    // Handle 'k' suffix (multiply by 1000)
    const multiplier = (match[0].toLowerCase().includes('k') && !period) ? 1000 : 1;
    
    return {
      low: lowAmount * multiplier,
      high: highAmount * multiplier,
      currency: currency,
      period: normalizedPeriod,
      original_text: match[0]
    };
    
  } catch (error) {
    log('error', `Error parsing salary match: ${error.message}`);
    return null;
  }
}

/**
 * Normalize currency code
 * @param {string} currency - Currency symbol or code
 * @param {string} context - Additional context
 * @returns {string} - Normalized currency code
 */
function normalizeCurrency(currency, context) {
  if (!currency) return DEFAULT_CURRENCY;
  
  // Check symbol mapping first
  if (CURRENCY_SYMBOLS[currency]) {
    return CURRENCY_SYMBOLS[currency];
  }
  
  // Handle ambiguous currencies
  if (AMBIGUOUS_CURRENCIES.includes(currency)) {
    // Try to infer from context
    const contextLower = context.toLowerCase();
    if (contextLower.includes('australia') || contextLower.includes('aud')) return 'AUD';
    if (contextLower.includes('canada') || contextLower.includes('cad')) return 'CAD';
    if (contextLower.includes('europe') || contextLower.includes('eur')) return 'EUR';
    if (contextLower.includes('uk') || contextLower.includes('gbp')) return 'GBP';
    return DEFAULT_CURRENCY;
  }
  
  // Return as-is if it's already a valid currency code
  return currency.toUpperCase();
}

/**
 * Normalize period (year, month, hour)
 * @param {string} period - Period string
 * @param {string} context - Additional context
 * @returns {string} - Normalized period
 */
function normalizePeriod(period, context) {
  if (!period) {
    // Try to infer from context
    const contextLower = context.toLowerCase();
    if (contextLower.includes('hour') || contextLower.includes('hr')) return 'hour';
    if (contextLower.includes('month') || contextLower.includes('mo')) return 'month';
    if (contextLower.includes('year') || contextLower.includes('annum') || contextLower.includes('annual')) return 'year';
    return 'year'; // Default to year
  }
  
  const periodLower = period.toLowerCase();
  if (periodLower.includes('hour') || periodLower.includes('hr')) return 'hour';
  if (periodLower.includes('month') || periodLower.includes('mo')) return 'month';
  if (periodLower.includes('year') || periodLower.includes('annum') || periodLower.includes('annual')) return 'year';
  
  return 'year'; // Default to year
}

/**
 * Convert salary to monthly amount in target currency
 * @param {Object} parsedSalary - Parsed salary object
 * @param {string} targetCurrency - Target currency code
 * @returns {Promise<Object|null>} - Converted salary or null
 */
export async function toMonthlyInTarget(parsedSalary, targetCurrency = 'USD') {
  if (!parsedSalary) return null;
  
  try {
    let { low, high, currency, period } = parsedSalary;
    
    // Convert to monthly amounts
    if (period === 'hour') {
      low = low * HOURS_PER_MONTH;
      high = high * HOURS_PER_MONTH;
    } else if (period === 'year') {
      low = low / MONTHS_PER_YEAR;
      high = high / MONTHS_PER_YEAR;
    }
    // If already monthly, no conversion needed
    
    // Convert currency if needed
    if (currency !== targetCurrency) {
      const exchangeRate = await getExchangeRate(currency, targetCurrency);
      if (exchangeRate) {
        low = low * exchangeRate;
        high = high * exchangeRate;
      } else {
        log('warn', `Could not get exchange rate for ${currency} to ${targetCurrency}, using original values`);
      }
    }
    
    return {
      monthly_low: Math.round(low * 100) / 100, // Round to 2 decimal places
      monthly_high: Math.round(high * 100) / 100,
      currency: targetCurrency,
      original_currency: parsedSalary.currency,
      original_period: parsedSalary.period
    };
    
  } catch (error) {
    log('error', `Error converting salary: ${error.message}`);
    return null;
  }
}

/**
 * Get exchange rate between two currencies
 * @param {string} fromCurrency - Source currency
 * @param {string} toCurrency - Target currency
 * @returns {Promise<number|null>} - Exchange rate or null
 */
async function getExchangeRate(fromCurrency, toCurrency) {
  if (fromCurrency === toCurrency) return 1;
  
  const cacheKey = `${fromCurrency}_${toCurrency}`;
  const cached = exchangeRateCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
    log('info', `Using cached exchange rate: ${fromCurrency} to ${toCurrency} = ${cached.rate}`);
    return cached.rate;
  }
  
  try {
    log('info', `Fetching exchange rate: ${fromCurrency} to ${toCurrency}`);
    
    const response = await fetch(
      `https://api.exchangerate.host/convert?from=${encodeURIComponent(fromCurrency)}&to=${encodeURIComponent(toCurrency)}&amount=1`,
      { timeout: 10000 }
    );
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (data.success && data.info && data.info.rate) {
      const rate = data.info.rate;
      
      // Cache the rate
      exchangeRateCache.set(cacheKey, {
        rate: rate,
        timestamp: Date.now()
      });
      
      log('info', `Exchange rate: ${fromCurrency} to ${toCurrency} = ${rate}`);
      return rate;
    } else {
      throw new Error(`Invalid response: ${JSON.stringify(data)}`);
    }
    
  } catch (error) {
    log('error', `Failed to get exchange rate ${fromCurrency} to ${toCurrency}: ${error.message}`);
    return null;
  }
}

/**
 * Extract all salary information from job text
 * @param {string} jobText - Job description text
 * @returns {Object[]} - Array of parsed salary objects
 */
export function extractAllSalaries(jobText) {
  if (!jobText) return [];
  
  const salaries = [];
  const lines = jobText.split('\n');
  
  for (const line of lines) {
    const salary = parseSalaryText(line);
    if (salary) {
      salaries.push(salary);
    }
  }
  
  // Also try parsing the entire text
  const fullTextSalary = parseSalaryText(jobText);
  if (fullTextSalary && !salaries.some(s => s.original_text === fullTextSalary.original_text)) {
    salaries.push(fullTextSalary);
  }
  
  return salaries;
}

/**
 * Check if salary meets minimum requirements
 * @param {Object} monthlySalary - Monthly salary object
 * @param {number} minMonthly - Minimum monthly salary
 * @returns {boolean} - True if meets requirements
 */
export function meetsMinimumSalary(monthlySalary, minMonthly) {
  if (!monthlySalary || !minMonthly) return true; // No requirements specified
  
  return monthlySalary.monthly_low >= minMonthly;
}

/**
 * Format salary for display
 * @param {Object} salary - Salary object
 * @returns {string} - Formatted salary string
 */
export function formatSalary(salary) {
  if (!salary) return 'Not specified';
  
  const { monthly_low, monthly_high, currency } = salary;
  
  if (monthly_low === monthly_high) {
    return formatCurrency(monthly_low, currency);
  } else {
    return `${formatCurrency(monthly_low, currency)} - ${formatCurrency(monthly_high, currency)}`;
  }
}

/**
 * Get salary range description
 * @param {Object} salary - Salary object
 * @returns {string} - Salary range description
 */
export function getSalaryRangeDescription(salary) {
  if (!salary) return 'Salary not specified';
  
  const { monthly_low, monthly_high, currency, original_period } = salary;
  
  let description = `Monthly: ${formatSalary(salary)}`;
  
  if (original_period === 'year') {
    const annualLow = monthly_low * 12;
    const annualHigh = monthly_high * 12;
    description += ` (Annual: ${formatCurrency(annualLow, currency)} - ${formatCurrency(annualHigh, currency)})`;
  } else if (original_period === 'hour') {
    const hourlyLow = monthly_low / HOURS_PER_MONTH;
    const hourlyHigh = monthly_high / HOURS_PER_MONTH;
    description += ` (Hourly: ${formatCurrency(hourlyLow, currency)} - ${formatCurrency(hourlyHigh, currency)})`;
  }
  
  return description;
}

/**
 * Clear exchange rate cache
 */
export function clearExchangeRateCache() {
  exchangeRateCache.clear();
  log('info', 'Exchange rate cache cleared');
}
