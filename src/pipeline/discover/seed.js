// discover/seed.js
// Manual seed loader. CSV format: name,ats,slug,notes
// One row per known company. Highest-quality input source.
import fs from 'fs';
import path from 'path';

export function loadSeedCsv(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];

  const [headerLine, ...rows] = raw.split(/\r?\n/);
  const headers = headerLine.split(',').map(h => h.trim().toLowerCase());
  const idxName = headers.indexOf('name');
  const idxAts = headers.indexOf('ats');
  const idxSlug = headers.indexOf('slug');
  if (idxName < 0 || idxAts < 0 || idxSlug < 0) {
    throw new Error(`Seed CSV ${filePath} must have columns: name, ats, slug`);
  }

  return rows
    .map(line => splitCsvLine(line))
    .filter(cols => cols.length && cols[idxSlug])
    .map(cols => ({
      name: cols[idxName]?.trim(),
      ats: cols[idxAts]?.trim().toLowerCase(),
      slug: cols[idxSlug]?.trim().toLowerCase(),
    }));
}

// Minimal CSV split: handles simple quoted commas. Good enough for a
// hand-maintained seed list.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
