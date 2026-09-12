// qualify/index.js
// Module 3. Applies the priority-ordered gate chain, then soft scoring,
// and writes back status + score + disqualify_reason per job.
//
// Priority chain (short-circuit on first fail):
//   1. gate1_remoteFromNigeria    — can hire without visa/work permit
//   2. gate2_payMinimum           — pay ≥ $24k in USD/EUR/GBP (or unstated)
//   3. gate3_skillsetMatch        — SWE / backend / frontend / etc.
//   4. gate4_companySize          — 2-500 employees
//   5. gate5_notPreviouslyContacted (90 days)
//   6. gate6_recentPosting        — within max_posting_age_days
// (Gate 7 "have contact email" is enforced at draft time, not qualify.)
//
// Re-runs against 'ingested', 'needs_review', AND 'qualified' jobs so that
// filter changes take retroactive effect. 'disqualified' is ALSO re-evaluated,
// but only on the first pass after the qualification config changes — see
// qualifyFingerprint below. 'closed' jobs are never re-evaluated (the posting
// is gone from the ATS; that is a fact about the world, not about our config).
import crypto from 'crypto';
import {
  jobsByStatus, companiesByStatus, companyById, wasCompanyContactedRecently,
  setJobQualifyResult, refreshCompanyScore, setCompanyStatus,
  isCompanySuppressed, getState, setState,
} from '../db/repo.js';
import {
  gate1_remoteFromNigeria, gate2_payMinimum, gate3_skillsetMatch,
  gate4_companySize, gate5_notPreviouslyContacted, gate6_recentPosting,
  ROLE_MARKERS, REJECT_ROLE_MARKERS,
} from './filters.js';
import { scoreJob } from './score.js';
import { logger } from '../util/logger.js';

export async function runQualify({ config } = {}) {
  // A 'disqualified' job is normally terminal — re-scoring ~20k dead rows on
  // every run is pure waste, since most were killed for reasons no config
  // change can undo (the title is not an engineering title). But when the
  // qualification config DOES change, those rows are exactly the ones that
  // need another look: lowering scoring.threshold or widening stack.keywords
  // is meant to rescue jobs the old settings killed. Fingerprint the config
  // and sweep them back in once, on the first pass after any change.
  const fingerprint = qualifyFingerprint(config);
  const configChanged = getState(FINGERPRINT_KEY) !== fingerprint;

  const targets = [
    ...jobsByStatus('ingested'),
    ...jobsByStatus('needs_review'),
    ...jobsByStatus('qualified'),
    ...(configChanged ? jobsByStatus('disqualified') : []),
  ];
  const stats = {
    evaluated: 0, qualified: 0, disqualified: 0, needsReview: 0,
    configChanged, rescued: 0,
  };
  if (configChanged) {
    logger.info({ fingerprint }, 'qualify config changed — re-evaluating disqualified jobs');
  }
  const touchedCompanies = new Set();

  for (const job of targets) {
    stats.evaluated++;
    const company = companyById(job.company_id);
    if (!company) {
      setJobQualifyResult(job.id, {
        status: 'disqualified', score: 0, disqualifyReason: 'no_company_row',
      });
      stats.disqualified++;
      continue;
    }

    // Gate 0: applicant-declared suppression. Highest priority — anything
    // on the manual/auto blocklist is dropped before any other check.
    // Handles the "Hunter/YC keep re-appearing wrong data" class of leaks.
    if (isCompanySuppressed(company.id)) {
      setJobQualifyResult(job.id, {
        status: 'disqualified', score: 0, disqualifyReason: 'company_suppressed',
      });
      stats.disqualified++;
      touchedCompanies.add(company.id);
      continue;
    }

    const decision = evaluateGates(job, company, config);

    setJobQualifyResult(job.id, {
      status: decision.status,
      score: decision.score,
      disqualifyReason: decision.reason,
    });

    if (decision.status === 'qualified') {
      stats.qualified++;
      // A job that was already dead and is now alive again — the whole point
      // of the config-change sweep.
      if (job.status === 'disqualified') stats.rescued++;
    } else if (decision.status === 'needs_review') stats.needsReview++;
    else stats.disqualified++;

    touchedCompanies.add(company.id);
  }

  // Refresh company-level scores + promote / demote.
  // Promote → 'qualified' if any job scored above threshold.
  // Demote → 'ingested' if the company was previously qualified but has
  // no qualifying jobs left.
  for (const cid of touchedCompanies) {
    const s = refreshCompanyScore(cid);
    const c = companyById(cid);
    if (s > 0) {
      if (c?.status !== 'qualified') setCompanyStatus(cid, 'qualified', { topScore: s });
    } else if (c?.status === 'qualified') {
      setCompanyStatus(cid, 'ingested', { reason: 'no_qualified_jobs_remaining' });
    }
  }

  // Zombie sweep: any company still marked 'qualified' but not touched
  // this pass (because all their jobs are already in 'disqualified' or
  // 'closed' state) also gets demoted. Fixes the case where filter
  // tightening left orphan companies stuck at status='qualified' with
  // zero live jobs — they clutter /diag and waste enrich cycles.
  for (const c of companiesByStatus('qualified')) {
    if (touchedCompanies.has(c.id)) continue;   // handled above
    const s = refreshCompanyScore(c.id);
    if (s === 0) {
      setCompanyStatus(c.id, 'ingested', { reason: 'zombie_sweep_no_qualified_jobs' });
      stats.zombiesDemoted = (stats.zombiesDemoted || 0) + 1;
    }
  }

  // Only recorded after a full pass, so a crash mid-sweep leaves the old
  // fingerprint in place and the sweep is retried next run.
  if (configChanged) setState(FINGERPRINT_KEY, fingerprint);

  logger.info(stats, 'qualify pass complete');
  return stats;
}

const FINGERPRINT_KEY = 'qualify_config_fingerprint';

/**
 * Stable hash of everything that can change a gate decision: the config
 * sections the gates read, plus the two role lists that live in code. Any
 * edit to a threshold, keyword, deny entry or role marker changes this, which
 * triggers one re-evaluation sweep over previously-disqualified jobs.
 *
 * Exported for tests.
 */
export function qualifyFingerprint(config) {
  const material = {
    gates: config?.gates ?? null,
    stack: config?.stack ?? null,
    location: config?.location ?? null,
    currency: config?.currency ?? null,
    scoring: config?.scoring ?? null,
    roleMarkers: ROLE_MARKERS,
    rejectRoleMarkers: REJECT_ROLE_MARKERS,
  };
  return crypto.createHash('sha256').update(stableStringify(material)).digest('hex').slice(0, 16);
}

// JSON.stringify with object keys sorted, so a YAML reordering that changes
// nothing semantically does not trigger a pointless full re-sweep.
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Evaluate a job against the gate chain. Returns { status, score, reason }.
 * Runs gates in priority order and returns immediately on first fail.
 * Only if all gates pass is scoring computed and threshold checked.
 */
export function evaluateGates(job, company, config) {
  const g1 = gate1_remoteFromNigeria(job, config);
  if (!g1.pass) return g1.needsReview ? review(g1.reason) : fail(g1.reason);

  const g2 = gate2_payMinimum(job, config);
  if (!g2.pass) return fail(g2.reason);

  const g3 = gate3_skillsetMatch(job, config);
  if (!g3.pass) return fail(g3.reason);

  const g4 = gate4_companySize(company, config);
  if (!g4.pass) return fail(g4.reason);

  const contacted = wasCompanyContactedRecently(company.id, 90);
  const g5 = gate5_notPreviouslyContacted(contacted);
  if (!g5.pass) return fail(g5.reason);

  const g6 = gate6_recentPosting(job, config);
  if (!g6.pass) return fail(g6.reason);

  const { score } = scoreJob(job, company, config);
  if (score < (config.scoring?.threshold ?? 40)) {
    return { status: 'disqualified', score, reason: `low_score:${score}` };
  }
  return { status: 'qualified', score, reason: null };
}

function fail(reason)   { return { status: 'disqualified', score: 0, reason }; }
function review(reason) { return { status: 'needs_review', score: 0, reason }; }
