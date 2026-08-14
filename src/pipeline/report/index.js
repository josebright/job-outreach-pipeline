// report/index.js
// Module 7 per PRD. Weekly funnel + per-segment breakdowns.
//
// Segments per PRD: score band, company size, source, template (prompt) version.
// Output: JSON via logger. Sufficient for CLI + Railway log inspection.
import { getDb } from '../db/connection.js';
import { logger } from '../util/logger.js';

const oneRow  = (db, sql, params = []) => db.prepare(sql).get(...params);
const rows    = (db, sql, params = []) => db.prepare(sql).all(...params);

export async function runReport({ config: _config } = {}) {
  const db = getDb();

  const totals = {
    companies_total: oneRow(db, 'SELECT COUNT(*) AS n FROM company').n,
    companies_qualified: oneRow(db, "SELECT COUNT(*) AS n FROM company WHERE status='qualified'").n,
    jobs_total: oneRow(db, 'SELECT COUNT(*) AS n FROM job').n,
    jobs_qualified: oneRow(db, "SELECT COUNT(*) AS n FROM job WHERE status='qualified'").n,
    jobs_disqualified: oneRow(db, "SELECT COUNT(*) AS n FROM job WHERE status='disqualified'").n,
    jobs_needs_review: oneRow(db, "SELECT COUNT(*) AS n FROM job WHERE status='needs_review'").n,
    contacts_total: oneRow(db, 'SELECT COUNT(*) AS n FROM contact').n,
    contacts_verified: oneRow(db, "SELECT COUNT(*) AS n FROM contact WHERE email_status='verified'").n,
    drafts_pending: oneRow(db, "SELECT COUNT(*) AS n FROM draft WHERE status='pending_review'").n,
    drafts_approved: oneRow(db, "SELECT COUNT(*) AS n FROM draft WHERE status='approved'").n,
    drafts_sent: oneRow(db, "SELECT COUNT(*) AS n FROM draft WHERE status='sent'").n,
    drafts_rejected: oneRow(db, "SELECT COUNT(*) AS n FROM draft WHERE status='rejected'").n,
    messages_out_initial: oneRow(db, "SELECT COUNT(*) AS n FROM message WHERE direction='outbound' AND kind='initial'").n,
    messages_out_followup: oneRow(db, "SELECT COUNT(*) AS n FROM message WHERE direction='outbound' AND kind LIKE 'followup%'").n,
    messages_replied: oneRow(db, "SELECT COUNT(*) AS n FROM message WHERE direction='inbound' AND kind='reply'").n,
    messages_bounced: oneRow(db, "SELECT COUNT(*) AS n FROM message WHERE bounced=1").n,
    suppressed: oneRow(db, 'SELECT COUNT(*) AS n FROM suppression').n,
  };

  const funnel = {
    discovered_to_qualified_pct: pct(totals.jobs_qualified, totals.jobs_total),
    qualified_to_contacted_pct:  pct(totals.contacts_total, totals.jobs_qualified),
    sent_to_reply_pct:           pct(totals.messages_replied, totals.messages_out_initial),
    bounce_rate_pct:             pct(totals.messages_bounced, totals.messages_out_initial + totals.messages_out_followup),
  };

  // Per-segment breakdowns.
  const byScoreBand = rows(db, `
    SELECT
      CASE
        WHEN score >= 80 THEN '80-100'
        WHEN score >= 60 THEN '60-79'
        WHEN score >= 40 THEN '40-59'
        ELSE '0-39'
      END AS band,
      COUNT(*) AS n
    FROM job
    WHERE status = 'qualified'
    GROUP BY band
    ORDER BY band DESC
  `);

  const byCompanySize = rows(db, `
    SELECT COALESCE(size_band, 'unknown') AS size_band, COUNT(*) AS n
    FROM company
    WHERE status = 'qualified'
    GROUP BY size_band
    ORDER BY n DESC
  `);

  const bySource = rows(db, `
    SELECT source, COUNT(*) AS total,
      SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) AS qualified
    FROM company
    GROUP BY source
    ORDER BY qualified DESC
  `);

  const byTemplate = rows(db, `
    SELECT prompt_version, COUNT(*) AS drafts,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
    FROM draft
    GROUP BY prompt_version
    ORDER BY drafts DESC
  `);

  const byReplySentiment = rows(db, `
    SELECT COALESCE(reply_sentiment, 'unknown') AS sentiment, COUNT(*) AS n
    FROM message
    WHERE direction = 'outbound' AND replied_at IS NOT NULL
    GROUP BY sentiment
    ORDER BY n DESC
  `);

  const summary = { totals, funnel, byScoreBand, byCompanySize, bySource, byTemplate, byReplySentiment };
  logger.info(summary, 'pipeline funnel report');
  return summary;
}

function pct(num, denom) {
  if (!denom || denom === 0) return 0;
  return Math.round((num / denom) * 10000) / 100;   // e.g. 12.34
}
