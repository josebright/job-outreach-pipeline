// draft/profile.js
// Loads data/profile.yaml, the "profile pack" the LLM sees when drafting.
// Cached because it does not change during a run.
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');

let cached = null;

export function loadProfile(filePath = path.join(ROOT_DIR, 'data', 'profile.yaml')) {
  if (cached) return cached;
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Profile not found at ${filePath}. Copy data/profile.example.yaml to data/profile.yaml and fill in achievements.`
    );
  }
  cached = yaml.load(fs.readFileSync(filePath, 'utf8'));

  // Minimum sanity: real quantified achievements, not the placeholder text.
  const achievements = cached.achievements || [];
  const placeholderCount = achievements.filter(a =>
    String(a).toUpperCase().includes('REPLACE:')
  ).length;
  if (achievements.length === 0 || placeholderCount === achievements.length) {
    throw new Error(
      'profile.yaml has no real achievements. Replace the "REPLACE:" lines with quantified outcomes before generating drafts.'
    );
  }
  return cached;
}

export function _resetProfileForTests() { cached = null; }
