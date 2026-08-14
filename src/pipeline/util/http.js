// util/http.js
// Shared axios instance with retry + polite defaults.
// Per-host rate limiting via p-limit.
import axios from 'axios';
import axiosRetry from 'axios-retry';
import pLimit from 'p-limit';

const USER_AGENT = 'job-outreach-pipeline/3.0 (+https://github.com/, personal job-search research)';

export const http = axios.create({
  timeout: 15_000,
  headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
});

axiosRetry(http, {
  retries: 4,
  retryDelay: (retryCount, error) => {
    // Honor Retry-After if present, else exponential with jitter.
    const retryAfter = error?.response?.headers?.['retry-after'];
    if (retryAfter) return Number(retryAfter) * 1000;
    const base = 1000 * Math.pow(2, retryCount - 1);
    return base + Math.random() * 500;
  },
  retryCondition: (error) => {
    if (axiosRetry.isNetworkOrIdempotentRequestError(error)) return true;
    const status = error?.response?.status;
    return status === 429 || (status >= 500 && status < 600);
  },
});

// One concurrency limiter per host. Default 1 req at a time (~1 rps upper bound
// once combined with request duration).
const limiters = new Map();

export function hostLimiter(host, concurrency = 1) {
  if (!limiters.has(host)) limiters.set(host, pLimit(concurrency));
  return limiters.get(host);
}
