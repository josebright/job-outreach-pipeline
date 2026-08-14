// report/index.js
// Module 7 per PRD. Weekly funnel report.
// Full breakdowns (by score band, size, source, template) land in Week 6.
import { getDb } from '../db/connection.js';
import { logger } from '../util/logger.js';

export async function runReport({ config: _config } = {}) {
  const db = getDb();

  const totals = {
    companies:      db.prepare('SELECT COUNT(*) AS n FROM company').get().n,
    discovered:     db.prepare("SELECT COUNT(*) AS n FROM company WHERE status='discovered'").get().n,
    ingested:       db.prepare("SELECT COUNT(*) AS n FROM company WHERE status='ingested'").get().n,
    qualified:      db.prepare("SELECT COUNT(*) AS n FROM company WHERE status='qualified'").get().n,
    disqualified:   db.prepare("SELECT COUNT(*) AS n FROM company WHERE status='disqualified'").get().n,
    dead:           db.prepare("SELECT COUNT(*) AS n FROM company WHERE status='dead'").get().n,
    jobs:           db.prepare('SELECT COUNT(*) AS n FROM job').get().n,
    contacts:       db.prepare('SELECT COUNT(*) AS n FROM contact').get().n,
    drafts_pending: db.prepare("SELECT COUNT(*) AS n FROM draft WHERE status='pending_review'").get().n,
    drafts_sent:    db.prepare("SELECT COUNT(*) AS n FROM draft WHERE status='sent'").get().n,
    replies:        db.prepare("SELECT COUNT(*) AS n FROM message WHERE direction='inbound'").get().n,
  };

  logger.info(totals, 'pipeline funnel');
  return totals;
}
