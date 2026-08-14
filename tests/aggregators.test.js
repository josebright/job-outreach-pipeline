// tests/aggregators.test.js
// Remotive and RemoteOK: verify dedup, hint extraction, software-only filter.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchCompanies as fetchRemotive, hintFromUrl } from '../src/pipeline/discover/aggregators/remotive.js';
import { fetchCompanies as fetchRemoteOk } from '../src/pipeline/discover/aggregators/remoteok.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const remotive = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/remotive.json'), 'utf8'));
const remoteok = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/remoteok.json'), 'utf8'));

vi.mock('../src/pipeline/util/http.js', async () => {
  const actual = await vi.importActual('../src/pipeline/util/http.js');
  return { ...actual, http: { get: vi.fn() } };
});

import { http } from '../src/pipeline/util/http.js';

describe('hintFromUrl', () => {
  it('extracts greenhouse slug', () => {
    expect(hintFromUrl('https://boards.greenhouse.io/acme/jobs/1')).toEqual({ ats: 'greenhouse', slug: 'acme' });
  });
  it('extracts lever slug', () => {
    expect(hintFromUrl('https://jobs.lever.co/delta-ai/xyz')).toEqual({ ats: 'lever', slug: 'delta-ai' });
  });
  it('returns null for unknown host', () => {
    expect(hintFromUrl('https://example.com/x')).toBeNull();
  });
});

describe('remotive fetchCompanies', () => {
  it('dedupes companies by name and extracts hints', async () => {
    http.get.mockResolvedValueOnce({ status: 200, data: remotive });
    const cos = await fetchRemotive();
    // 3 jobs, but Acme Corp appears twice -> 2 unique companies
    expect(cos.length).toBe(2);
    const beta = cos.find(c => c.companyName === 'Beta Labs, Inc.');
    expect(beta.hint).toEqual({ ats: 'greenhouse', slug: 'beta-labs' });
    expect(cos.every(c => c.source === 'remotive')).toBe(true);
  });

  it('returns [] on error', async () => {
    http.get.mockResolvedValueOnce({ status: 500, data: null });
    expect(await fetchRemotive()).toEqual([]);
  });
});

describe('remoteok fetchCompanies', () => {
  it('drops non-software roles and legal notice, dedupes by company', async () => {
    http.get.mockResolvedValueOnce({ status: 200, data: remoteok });
    const cos = await fetchRemoteOk();
    // 3 real jobs: Acme (software), Gamma (marketing - dropped), Delta AI (software)
    expect(cos.map(c => c.companyName).sort()).toEqual(['Acme Corp', 'Delta AI']);
    const delta = cos.find(c => c.companyName === 'Delta AI');
    expect(delta.hint).toEqual({ ats: 'lever', slug: 'delta-ai' });
  });
});
