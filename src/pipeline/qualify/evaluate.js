// qualify/evaluate.js
// Measures qualify precision + recall against a labeled test set.
// Labels live in a CSV: job_id,expected  where expected is one of
// qualified | disqualified | needs_review.
//
// Usage:
//   node src/pipeline/cli.js qualify --eval data/labeled_postings.csv
//
// The eval loads each labeled job from the DB, runs evaluateTrack against
// each enabled track (Track A first), and compares to the label.
import fs from 'fs';
import { jobById, companyById } from '../db/repo.js';
import { evaluateTrack } from './index.js';

const VALID = new Set(['qualified', 'disqualified', 'needs_review']);

/**
 * @returns {{ precision:number, recall:number, f1:number, confusion:object, misses:Array }}
 */
export function evaluateAgainstLabels({ csvPath, config }) {
  if (!fs.existsSync(csvPath)) throw new Error(`Label file not found: ${csvPath}`);
  const raw = fs.readFileSync(csvPath, 'utf8').trim();
  if (!raw) throw new Error(`Label file empty: ${csvPath}`);

  const [header, ...rows] = raw.split(/\r?\n/);
  const headers = header.split(',').map(h => h.trim().toLowerCase());
  const idxJob = headers.indexOf('job_id');
  const idxExp = headers.indexOf('expected');
  if (idxJob < 0 || idxExp < 0) {
    throw new Error(`Label CSV must have columns: job_id, expected`);
  }

  const tracks = config.tracks_enabled || ['A'];
  const confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  const misses = [];
  let evaluated = 0;
  let skipped = 0;

  for (const line of rows) {
    const cols = line.split(',').map(c => c.trim());
    const jobId = Number(cols[idxJob]);
    const expected = cols[idxExp]?.toLowerCase();
    if (!jobId || !VALID.has(expected)) { skipped++; continue; }

    const job = jobById(jobId);
    if (!job) { skipped++; continue; }
    const company = companyById(job.company_id);
    if (!company) { skipped++; continue; }

    const decisions = tracks.map(t => evaluateTrack(job, company, config, t));
    const predicted = decisions.find(d => d.status === 'qualified')?.status
      || decisions.find(d => d.status === 'needs_review')?.status
      || 'disqualified';

    // Treat "qualified" as positive, everything else as negative for the
    // precision/recall calc. needs_review is counted as negative here since
    // the goal of the labeled set is to measure whether we correctly identify
    // the strong positives.
    const isPositiveExp  = expected === 'qualified';
    const isPositivePred = predicted === 'qualified';

    if (isPositivePred && isPositiveExp) confusion.tp++;
    else if (isPositivePred && !isPositiveExp) confusion.fp++;
    else if (!isPositivePred && !isPositiveExp) confusion.tn++;
    else confusion.fn++;

    if (predicted !== expected) {
      misses.push({ jobId, expected, predicted, title: job.title });
    }
    evaluated++;
  }

  const precision = confusion.tp / (confusion.tp + confusion.fp) || 0;
  const recall    = confusion.tp / (confusion.tp + confusion.fn) || 0;
  const f1        = (2 * precision * recall) / (precision + recall) || 0;

  return { evaluated, skipped, precision, recall, f1, confusion, misses };
}
