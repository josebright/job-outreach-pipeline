// config/loader.js
// Loads config.yaml + .env. Validates via Zod. Cached.
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { parseConfig } from './schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

let cachedConfig = null;

export function loadConfig(configPath = path.join(ROOT_DIR, 'config.yaml')) {
  if (cachedConfig) return cachedConfig;
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `config.yaml not found at ${configPath}. Copy config.example.yaml to config.yaml and edit.`
    );
  }
  const raw = yaml.load(fs.readFileSync(configPath, 'utf8'));
  cachedConfig = parseConfig(raw);
  return cachedConfig;
}

export const env = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  HUNTER_API_KEY: process.env.HUNTER_API_KEY || '',
  APOLLO_API_KEY: process.env.APOLLO_API_KEY || '',
  SERPER_API_KEY: process.env.SERPER_API_KEY || '',
  SERPAPI_KEY: process.env.SERPAPI_KEY || '',
  PROXYCURL_API_KEY: process.env.PROXYCURL_API_KEY || '',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN || '',
  AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY || '',
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID || '',
};

export function _resetConfigForTests() { cachedConfig = null; }
