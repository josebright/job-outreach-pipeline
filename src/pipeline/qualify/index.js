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
// Re-runs against 'ingested', 'needs_review', AND 'qualified' jobs so
// that filter changes take retroactive effect. 'disqualified' and
// 'closed' jobs are not re-evaluated.
import {
  jobsByStatus, companyById, wasCompanyContactedRecently,
  setJobQualifyResult, refreshCompanyScore, setCompanyStatus,
} from '../db/repo.js';
import {
  gate1_remoteFromNigeria, gate2_payMinimum, gate3_skillsetMatch,
  gate4_companySize, gate5_notPreviouslyContacted, gate6_recentPosting,
} from './filters.js';
import { scoreJob } from './score.js';
import { logger } from '../util/logger.js';

export async function runQualify({ config } = {}) {
  const targets = [
    ...jobsByStatus('ingested'),
    ...jobsByStatus('needs_review'),
    ...jobsByStatus('qualified'),
  ];
  const stats = { evaluated: 0, qualified: 0, disqualified: 0, needsReview: 0 };
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

    const decision = evaluateGates(job, company, config);

    setJobQualifyResult(job.id, {
      status: decision.status,
      score: decision.score,
      disqualifyReason: decision.reason,
    });

    if (decision.status === 'qualified')      stats.qualified++;
    else if (decision.status === 'needs_review') stats.needsReview++;
    else                                          stats.disqualified++;

    touchedCompanies.add(company.id);
  }

  // Refresh company-level scores + promote / demote.
  // Promote → 'qualified' if any job scored above threshold.
  // Demote → 'ingested' if the company was previously qualified but has
  // no qualifying jobs left (prevents zombie companies stuck in the
  // draft loop after filter tightening).
  for (const cid of touchedCompanies) {
    const s = refreshCompanyScore(cid);
    const c = companyById(cid);
    if (s > 0) {
      if (c?.status !== 'qualified') setCompanyStatus(cid, 'qualified', { topScore: s });
    } else if (c?.status === 'qualified') {
      setCompanyStatus(cid, 'ingested', { reason: 'no_qualified_jobs_remaining' });
    }
  }

  logger.info(stats, 'qualify pass complete');
  return stats;
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
