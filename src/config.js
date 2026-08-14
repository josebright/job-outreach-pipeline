// config.js - Centralized configuration from environment variables
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');

export const config = {
  // Paths
  rootDir: ROOT_DIR,
  dataDir: path.join(ROOT_DIR, 'data'),
  outputDir: path.join(ROOT_DIR, 'output'),
  templatesDir: path.join(ROOT_DIR, 'templates'),

  // API Keys
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  adzunaAppId: process.env.ADZUNA_APP_ID || '',
  adzunaAppKey: process.env.ADZUNA_APP_KEY || '',
  reedApiKey: process.env.REED_API_KEY || '',

  // Email / SMTP
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
  userEmail: process.env.USER_EMAIL || '',
  userName: process.env.USER_NAME || '',

  // Job search defaults
  search: {
    maxAgeHours: 24,
    minMatchScore: 95,
    targetCountries: ['us', 'gb', 'ca', 'au', 'de', 'fr', 'nl', 'ie', 'se', 'dk', 'no', 'fi', 'es', 'pt', 'at', 'ch', 'be', 'pl'],
    targetCountryNames: ['United States', 'United Kingdom', 'Canada', 'Australia', 'Germany', 'France', 'Netherlands', 'Ireland', 'Sweden', 'Denmark', 'Norway', 'Finland', 'Spain', 'Portugal', 'Austria', 'Switzerland', 'Belgium', 'Poland'],
    keywords: [
      'software engineer', 'software developer', 'backend engineer', 'frontend engineer',
      'fullstack engineer', 'full stack developer', 'web developer', 'node.js developer',
      'python developer', 'senior engineer', 'staff engineer', 'devops engineer',
      'cloud engineer', 'platform engineer', 'site reliability engineer'
    ],
    includeRemote: true,
    requireSponsorshipOrRemote: true,
  },

  // Rate limits
  rateLimits: {
    emailsPerHour: 5,
    apiRequestDelay: 600, // ms between API requests
    concurrentRequests: 5,
  },

  // Claude model for AI tasks
  claudeModel: 'claude-sonnet-4-20250514',
};

export function validateConfig() {
  const errors = [];

  if (!config.anthropicApiKey) {
    errors.push('ANTHROPIC_API_KEY is required. Set it in .env file.');
  }

  return { valid: errors.length === 0, errors };
}
