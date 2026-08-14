// tests/config.test.js
// Verifies config.example.yaml parses cleanly against the Zod schema.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { parseConfig } from '../src/pipeline/config/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

describe('config schema', () => {
  it('accepts config.example.yaml', () => {
    const raw = yaml.load(fs.readFileSync(path.join(ROOT, 'config.example.yaml'), 'utf8'));
    const parsed = parseConfig(raw);
    expect(parsed.tracks_enabled).toContain('A');
    expect(parsed.send.daily_cap_initial).toBeGreaterThan(0);
    expect(parsed.scoring.threshold).toBeGreaterThanOrEqual(0);
  });

  it('rejects a missing required section', () => {
    expect(() => parseConfig({})).toThrow();
  });
});
