// discover/seed.js
// Manual seed loader. CSV format (required cols first):
//   name,ats,slug[,website,hq_country,size_band,nigeria_presence,notes]
// Only name, ats, slug are required. Extra columns are optional.
// nigeria_presence: 1|true|yes for present, 0|false|no or blank for absent.
// website: bare domain or full URL; used by Module 4 to run Hunter searches.
import fs from 'fs';

export function loadSeedCsv(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];

  const [headerLine, ...rows] = raw.split(/\r?\n/);
  const headers = headerLine.split(',').map(h => h.trim().toLowerCase());

  const req = ['name', 'ats', 'slug'];
  for (const r of req) {
    if (!headers.includes(r)) {
      throw new Error(`Seed CSV ${filePath} must have columns: name, ats, slug`);
    }
  }

  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

  return rows
    .map(line => splitCsvLine(line))
    .filter(cols => cols.length && cols[idx.slug])
    .map(cols => ({
      name: cols[idx.name]?.trim(),
      ats: cols[idx.ats]?.trim().toLowerCase(),
      slug: cols[idx.slug]?.trim().toLowerCase(),
      website: idx.website != null ? nullable(cols[idx.website]) : null,
      hqCountry: idx.hq_country != null ? nullable(cols[idx.hq_country]) : null,
      sizeBand: idx.size_band != null ? nullable(cols[idx.size_band]) : null,
      nigeriaPresence: idx.nigeria_presence != null ? truthy(cols[idx.nigeria_presence]) : false,
    }));
}

function nullable(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function truthy(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

// Minimal CSV split: handles simple quoted commas.
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
