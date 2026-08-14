// db/repo.js
// Typed accessors for the pipeline tables. Thin, no ORM.
// Every write path emits an event to event_log.
import { getDb } from './connection.js';
import { recordEvent } from './event-log.js';

/* ── company ────────────────────────────────────────────────── */

export function upsertCompany({ name, ats, slug, source, hqCountry = null, sizeBand = null, website = null }) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id, status FROM company WHERE ats = ? AND slug = ?'
  ).get(ats, slug);

  if (existing) {
    db.prepare(`
      UPDATE company SET updated_at = datetime('now')
      WHERE id = ?
    `).run(existing.id);
    return { id: existing.id, created: false };
  }

  const result = db.prepare(`
    INSERT INTO company (name, ats, slug, source, hq_country, size_band, website)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, ats, slug, source, hqCountry, sizeBand, website);

  recordEvent({
    entity: 'company',
    entityId: result.lastInsertRowid,
    event: 'discovered',
    detail: { name, ats, slug, source },
  });

  return { id: result.lastInsertRowid, created: true };
}

export function setCompanyStatus(id, status, detail = null) {
  const db = getDb();
  db.prepare(`
    UPDATE company SET status = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, id);
  recordEvent({ entity: 'company', entityId: id, event: status, detail });
}

export function companiesByStatus(status) {
  return getDb().prepare('SELECT * FROM company WHERE status = ? ORDER BY score DESC, id ASC').all(status);
}

export function companyById(id) {
  return getDb().prepare('SELECT * FROM company WHERE id = ?').get(id);
}

export function allCompanySlugs(ats) {
  return getDb().prepare('SELECT slug FROM company WHERE ats = ?').all(ats).map(r => r.slug);
}

/* ── job ────────────────────────────────────────────────────── */

export function upsertJob({
  companyId, externalJobId, title, department = null,
  locationRaw = null, remoteScope = 'unknown', workplaceType = 'unknown',
  currencySignal = null, compRaw = null, descriptionText = null,
  url = null, postedAt = null, updatedAtSource = null, track = 'A',
}) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id FROM job WHERE company_id = ? AND external_job_id = ?'
  ).get(companyId, externalJobId);

  if (existing) {
    db.prepare(`
      UPDATE job SET
        title = ?, department = ?, location_raw = ?, remote_scope = ?,
        workplace_type = ?, currency_signal = ?, comp_raw = ?,
        description_text = ?, url = ?, posted_at = ?, updated_at_source = ?,
        fetched_at = datetime('now')
      WHERE id = ?
    `).run(
      title, department, locationRaw, remoteScope, workplaceType,
      currencySignal, compRaw, descriptionText, url, postedAt, updatedAtSource,
      existing.id
    );
    return { id: existing.id, created: false };
  }

  const result = db.prepare(`
    INSERT INTO job (
      company_id, external_job_id, title, department, location_raw,
      remote_scope, workplace_type, currency_signal, comp_raw,
      description_text, url, posted_at, updated_at_source, track
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    companyId, externalJobId, title, department, locationRaw,
    remoteScope, workplaceType, currencySignal, compRaw,
    descriptionText, url, postedAt, updatedAtSource, track
  );

  recordEvent({
    entity: 'job',
    entityId: result.lastInsertRowid,
    event: 'ingested',
    detail: { companyId, title, externalJobId },
  });

  return { id: result.lastInsertRowid, created: true };
}

export function jobsByCompany(companyId) {
  return getDb().prepare('SELECT * FROM job WHERE company_id = ?').all(companyId);
}

export function countJobs() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM job').get().n;
}

export function countCompanies() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM company').get().n;
}

/* ── suppression ────────────────────────────────────────────── */

export function isSuppressed(email) {
  const row = getDb().prepare('SELECT email FROM suppression WHERE email = ?').get(email.toLowerCase());
  return Boolean(row);
}

export function suppress(email, reason, detail = null) {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO suppression (email, reason, detail)
    VALUES (?, ?, ?)
  `).run(email.toLowerCase(), reason, detail);
  recordEvent({ entity: 'system', event: 'suppressed', detail: { email, reason } });
}

/* ── dead slugs ─────────────────────────────────────────────── */

export function markSlugDead(ats, slug, ttlDays = 30) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO dead_slug (ats, slug, died_at, expires_at)
    VALUES (?, ?, datetime('now'), datetime('now', ?))
  `).run(ats, slug, `+${ttlDays} days`);
}

export function isSlugDead(ats, slug) {
  const row = getDb().prepare(`
    SELECT slug FROM dead_slug
    WHERE ats = ? AND slug = ? AND expires_at > datetime('now')
  `).get(ats, slug);
  return Boolean(row);
}

/* ── send counters ──────────────────────────────────────────── */

function watDate() {
  // WAT is UTC+1, no DST. Build YYYY-MM-DD in that zone.
  const now = new Date();
  const wat = new Date(now.getTime() + 60 * 60 * 1000);
  return wat.toISOString().slice(0, 10);
}

export function getSendCount(kind, date = watDate()) {
  const row = getDb().prepare(
    'SELECT count FROM send_counter WHERE date = ? AND kind = ?'
  ).get(date, kind);
  return row ? row.count : 0;
}

export function incrementSendCount(kind, date = watDate()) {
  const db = getDb();
  db.prepare(`
    INSERT INTO send_counter (date, kind, count) VALUES (?, ?, 1)
    ON CONFLICT (date, kind) DO UPDATE SET count = count + 1
  `).run(date, kind);
  return getSendCount(kind, date);
}
