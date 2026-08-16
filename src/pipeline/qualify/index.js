// qualify/index.js
// Module 3 per PRD. Applies Q1-Q5 hard filters, then soft scoring, and
// writes back status + score + disqualify_reason per job. Idempotent: safe
// to re-run against 'ingested' jobs.
import {
  jobsByStatus, companyById, wasCompanyContactedRecently,
  setJobQualifyResult, refreshCompanyScore, setCompanyStatus,
} from '../db/repo.js';
import {
  q1_roleMatches, q2_remoteEligible, q3_currencyOK,
  q4_visaRelocation, q5_notPreviouslyContacted, q6_companySizeOK,
} from './filters.js';
import { scoreJob } from './score.js';
import { logger } from '../util/logger.js';

/**
 * Score & classify every job. Returns aggregate counts.
 *
 * Processes 'ingested', 'needs_review', AND already-'qualified' jobs so
 * that filter changes (e.g., tightening Q1 to require an engineering role
 * marker) take retroactive effect. Already-'disqualified' and 'closed'
 * jobs are not touched.
 */
export async function runQualify({ config } = {}) {
  const tracks = config.tracks_enabled || ['A'];
  const threshold = config.scoring.threshold;

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

    // Pick the "best" track outcome. Track A is primary; Track B is a fallback
    // if the config enables it and Track A did not pass.
    const decisions = tracks.map(t => evaluateTrack(job, company, config, t));
    const passing = decisions.find(d => d.status === 'qualified');
    const decision = passing || preferReviewOver(decisions);

    setJobQualifyResult(job.id, {
      status: decision.status,
      score: decision.score,
      disqualifyReason: decision.reason,
    });

    if (decision.status === 'qualified') stats.qualified++;
    else if (decision.status === 'needs_review') stats.needsReview++;
    else stats.disqualified++;

    touchedCompanies.add(company.id);
  }

  // Refresh company-level scores and promote any newly-qualified companies.
  for (const cid of touchedCompanies) {
    const s = refreshCompanyScore(cid);
    if (s > 0) setCompanyStatus(cid, 'qualified', { topScore: s });
  }

  logger.info(stats, 'qualify pass complete');
  return stats;
}

/**
 * Evaluate one track. Returns { status, score, reason }.
 * status is one of: qualified | disqualified | needs_review.
 */
export function evaluateTrack(job, company, config, track) {
  const q1 = q1_roleMatches(job, config);
  if (!q1.pass) return fail(q1.reason);

  const q2 = q2_remoteEligible(job, config, track);
  if (!q2.pass) return q2.needsReview ? review(q2.reason) : fail(q2.reason);

  const q3 = q3_currencyOK(job, company, config, track);
  if (!q3.pass) return q3.needsReview ? review(q3.reason) : fail(q3.reason);

  const q4 = q4_visaRelocation(job, track);
  if (!q4.pass) return fail(q4.reason);

  const contacted = wasCompanyContactedRecently(company.id, 90);
  const q5 = q5_notPreviouslyContacted(contacted);
  if (!q5.pass) return fail(q5.reason);

  const q6 = q6_companySizeOK(company, config);
  if (!q6.pass) return fail(q6.reason);

  const { score } = scoreJob(job, company, config);
  if (score < config.scoring.threshold) {
    return { status: 'disqualified', score, reason: `low_score:${score}` };
  }
  return { status: 'qualified', score, reason: null };
}

function fail(reason)   { return { status: 'disqualified', score: 0, reason }; }
function review(reason) { return { status: 'needs_review', score: 0, reason }; }

// Prefer needs_review over disqualified when tracks disagree, so borderline
// jobs surface for human triage instead of being silently dropped.
function preferReviewOver(decisions) {
  return decisions.find(d => d.status === 'needs_review') || decisions[0];
}
