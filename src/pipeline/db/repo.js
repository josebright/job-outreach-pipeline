// db/repo.js
// Typed accessors for the pipeline tables. Thin, no ORM.
// Every write path emits an event to event_log.
import { getDb } from './connection.js';
import { recordEvent } from './event-log.js';

/* ── company ────────────────────────────────────────────────── */

export function upsertCompany({
  name, ats, slug, source,
  hqCountry = null, sizeBand = null, website = null, nigeriaPresence = false,
  sizeBandSource = null,   // when caller sets a size, they must also
                           // declare its source ('seed'|'hunter'|'manual')
}) {
  // Derive a default source when the seed loader sets a size without
  // being explicit. Anything upserted with source='seed' whose sizeBand
  // is populated is trusted seed data.
  const resolvedSizeSource = sizeBandSource || (sizeBand && source === 'seed' ? 'seed' : null);

  const db = getDb();
  const existing = db.prepare(
    'SELECT id, status FROM company WHERE ats = ? AND slug = ?'
  ).get(ats, slug);

  if (existing) {
    // Backfill non-null fields when re-upserting from a richer source (e.g., seed).
    // Seed re-imports OVERWRITE a Hunter-guessed size — seed always wins.
    if (sizeBand && resolvedSizeSource === 'seed') {
      db.prepare(`
        UPDATE company SET
          hq_country       = COALESCE(?, hq_country),
          size_band        = ?,
          size_band_source = 'seed',
          website          = COALESCE(?, website),
          nigeria_presence = CASE WHEN ? = 1 THEN 1 ELSE nigeria_presence END,
          updated_at       = datetime('now')
        WHERE id = ?
      `).run(hqCountry, sizeBand, website, nigeriaPresence ? 1 : 0, existing.id);
    } else {
      db.prepare(`
        UPDATE company SET
          hq_country       = COALESCE(?, hq_country),
          size_band        = COALESCE(?, size_band),
          size_band_source = COALESCE(size_band_source, ?),
          website          = COALESCE(?, website),
          nigeria_presence = CASE WHEN ? = 1 THEN 1 ELSE nigeria_presence END,
          updated_at       = datetime('now')
        WHERE id = ?
      `).run(hqCountry, sizeBand, resolvedSizeSource, website, nigeriaPresence ? 1 : 0, existing.id);
    }
    return { id: existing.id, created: false };
  }

  const result = db.prepare(`
    INSERT INTO company (name, ats, slug, source, hq_country, size_band, size_band_source, website, nigeria_presence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, ats, slug, source, hqCountry, sizeBand, resolvedSizeSource, website, nigeriaPresence ? 1 : 0);

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

/**
 * Backfill Hunter enrichment fields on a company. Only overwrites fields
 * that are currently null so seed CSV / manual data always wins over
 * Hunter's guess.
 */
export function updateCompanyEnrichment(id, {
  sizeBand = null, hqCountry = null, website = null,
  industry = null, linkedinUrl = null, emailPattern = null,
  sizeBandSource = null,   // 'seed' | 'hunter' | 'manual' — see migration 003
  overwriteSize = false,   // if true, overwrite even a non-null size_band
                           // (used for draft-time re-verification when
                           //  the previous source was 'hunter')
} = {}) {
  const db = getDb();
  if (overwriteSize && sizeBand) {
    db.prepare(`
      UPDATE company SET
        size_band        = ?,
        size_band_source = COALESCE(?, size_band_source),
        hq_country       = COALESCE(hq_country, ?),
        website          = COALESCE(website, ?),
        industry         = COALESCE(industry, ?),
        linkedin_url     = COALESCE(linkedin_url, ?),
        email_pattern    = COALESCE(email_pattern, ?),
        updated_at       = datetime('now')
      WHERE id = ?
    `).run(sizeBand, sizeBandSource, hqCountry, website, industry, linkedinUrl, emailPattern, id);
    return;
  }
  db.prepare(`
    UPDATE company SET
      size_band        = COALESCE(size_band, ?),
      size_band_source = COALESCE(size_band_source, ?),
      hq_country       = COALESCE(hq_country, ?),
      website          = COALESCE(website, ?),
      industry         = COALESCE(industry, ?),
      linkedin_url     = COALESCE(linkedin_url, ?),
      email_pattern    = COALESCE(email_pattern, ?),
      updated_at       = datetime('now')
    WHERE id = ?
  `).run(sizeBand, sizeBandSource, hqCountry, website, industry, linkedinUrl, emailPattern, id);
}

/** Manual override — always wins. Used by the /setsize Telegram command. */
export function setCompanySizeManual(id, band) {
  const db = getDb();
  db.prepare(`
    UPDATE company SET
      size_band = ?, size_band_source = 'manual', updated_at = datetime('now')
    WHERE id = ?
  `).run(band, id);
}

/** Lookup by slug. Used by /setsize + /draft <slug>. */
export function companyBySlug(slug) {
  return getDb().prepare('SELECT * FROM company WHERE slug = ? LIMIT 1').get(String(slug || '').toLowerCase());
}

/* ── company suppression (migration 004) ───────────────────── */

export function suppressCompany(id, reason = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO company_suppression (company_id, reason)
    VALUES (?, ?)
    ON CONFLICT (company_id) DO UPDATE SET reason = excluded.reason
  `).run(id, reason);
  recordEvent({ entity: 'company', entityId: id, event: 'suppressed', detail: { reason } });
}

export function unsuppressCompany(id) {
  const db = getDb();
  db.prepare('DELETE FROM company_suppression WHERE company_id = ?').run(id);
  recordEvent({ entity: 'company', entityId: id, event: 'unsuppressed' });
}

export function isCompanySuppressed(id) {
  const row = getDb().prepare('SELECT 1 FROM company_suppression WHERE company_id = ?').get(id);
  return Boolean(row);
}

export function listSuppressedCompanies() {
  return getDb().prepare(`
    SELECT co.id, co.name, co.slug, cs.reason, cs.suppressed_at
    FROM company_suppression cs
    JOIN company co ON co.id = cs.company_id
    ORDER BY cs.suppressed_at DESC
  `).all();
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

export function jobsByStatus(status, { limit = null } = {}) {
  const sql = limit
    ? 'SELECT * FROM job WHERE status = ? ORDER BY id ASC LIMIT ?'
    : 'SELECT * FROM job WHERE status = ? ORDER BY id ASC';
  const params = limit ? [status, limit] : [status];
  return getDb().prepare(sql).all(...params);
}

export function jobById(id) {
  return getDb().prepare('SELECT * FROM job WHERE id = ?').get(id);
}

export function countJobs() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM job').get().n;
}

export function countCompanies() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM company').get().n;
}

/**
 * Apply the qualify decision to a job.
 * status: 'qualified' | 'disqualified' | 'needs_review'
 * disqualifyReason is stored regardless of status (useful for needs_review too).
 */
export function setJobQualifyResult(jobId, { status, score, disqualifyReason = null }) {
  const db = getDb();
  db.prepare(`
    UPDATE job SET status = ?, score = ?, disqualify_reason = ? WHERE id = ?
  `).run(status, score, disqualifyReason, jobId);
  recordEvent({
    entity: 'job',
    entityId: jobId,
    event: status,
    detail: { score, disqualifyReason },
  });
}

/**
 * Cheap check for Q5 (not previously contacted).
 * Returns true if any draft for a contact at this company was 'sent' within N days.
 */
export function wasCompanyContactedRecently(companyId, days = 90) {
  const row = getDb().prepare(`
    SELECT 1
    FROM draft d
    JOIN contact c ON c.id = d.contact_id
    WHERE c.company_id = ?
      AND d.status = 'sent'
      AND d.sent_at IS NOT NULL
      AND d.sent_at > datetime('now', ?)
    LIMIT 1
  `).get(companyId, `-${days} days`);
  return Boolean(row);
}

/**
 * Update the company's cached score to reflect the highest-scoring
 * qualified job. Used by enrichment to prioritize companies.
 */
export function refreshCompanyScore(companyId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(score) AS s FROM job WHERE company_id = ? AND status = 'qualified'
  `).get(companyId);
  const s = row?.s ?? 0;
  db.prepare('UPDATE company SET score = ? WHERE id = ?').run(s, companyId);
  return s;
}

/* ── contact ────────────────────────────────────────────────── */

/**
 * Insert a contact (or return the existing one). Enforces unique (company_id, email).
 * emailStatus in { verified | risky | invalid }.
 * roleType in { founder | eng_leader | engineer | recruiter }.
 */
export function upsertContact({
  companyId, fullName, title, roleType, email, emailStatus, source, raw = null,
}) {
  const db = getDb();
  const emailLc = String(email).toLowerCase().trim();
  const existing = db.prepare(
    'SELECT id FROM contact WHERE company_id = ? AND email = ?'
  ).get(companyId, emailLc);
  if (existing) return { id: existing.id, created: false };

  const result = db.prepare(`
    INSERT INTO contact (company_id, full_name, title, role_type, email, email_status, source, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    companyId, fullName, title, roleType, emailLc, emailStatus, source,
    raw ? JSON.stringify(raw) : null
  );
  recordEvent({
    entity: 'contact',
    entityId: result.lastInsertRowid,
    event: 'created',
    detail: { companyId, roleType, emailStatus, source },
  });
  return { id: result.lastInsertRowid, created: true };
}

export function contactsByCompany(companyId) {
  return getDb().prepare(
    'SELECT * FROM contact WHERE company_id = ? ORDER BY id ASC'
  ).all(companyId);
}

export function contactCountForCompany(companyId) {
  return getDb().prepare(
    'SELECT COUNT(*) AS n FROM contact WHERE company_id = ?'
  ).get(companyId).n;
}

/* ── pipeline_state: small k/v for cross-run bookkeeping ──── */

export function getState(key) {
  const row = getDb().prepare('SELECT value FROM pipeline_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setState(key, value) {
  getDb().prepare(`
    INSERT INTO pipeline_state (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value));
}

export function setContactEmailStatus(id, status) {
  // NB: the contact table has no updated_at column (see 001_initial_schema).
  getDb().prepare(
    `UPDATE contact SET email_status = ? WHERE id = ?`
  ).run(status, id);
}

export function contactById(id) {
  return getDb().prepare('SELECT * FROM contact WHERE id = ?').get(id);
}

/* ── draft ──────────────────────────────────────────────────── */

export function createDraft({
  contactId, jobId = null, subject, body,
  promptVersion, hookEvidence = null, hookVerified = false, model = null,
  variant = null,
}) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO draft (
      contact_id, job_id, subject, body, prompt_version,
      hook_evidence, hook_verified, model, variant, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')
  `).run(
    contactId, jobId, subject, body, promptVersion,
    hookEvidence, hookVerified ? 1 : 0, model, variant,
  );
  recordEvent({
    entity: 'draft',
    entityId: result.lastInsertRowid,
    event: 'draft_created',
    detail: { contactId, jobId, model, promptVersion, variant, hookVerified },
  });
  return { id: result.lastInsertRowid };
}

export function draftById(id) {
  return getDb().prepare('SELECT * FROM draft WHERE id = ?').get(id);
}

export function draftsByStatus(status) {
  return getDb().prepare(
    'SELECT * FROM draft WHERE status = ? ORDER BY id ASC'
  ).all(status);
}

export function updateDraftStatus(id, status, extra = {}) {
  const db = getDb();
  const now = "datetime('now')";
  if (status === 'approved') {
    db.prepare(`UPDATE draft SET status = ?, approved_at = ${now} WHERE id = ?`).run(status, id);
  } else if (status === 'sent') {
    db.prepare(`UPDATE draft SET status = ?, sent_at = ${now} WHERE id = ?`).run(status, id);
  } else {
    db.prepare('UPDATE draft SET status = ?, reject_reason = ? WHERE id = ?')
      .run(status, extra.reason || null, id);
  }
  recordEvent({ entity: 'draft', entityId: id, event: status, detail: extra });
}

export function updateDraftContent(id, { subject, body }) {
  getDb().prepare('UPDATE draft SET subject = ?, body = ? WHERE id = ?').run(subject, body, id);
  recordEvent({ entity: 'draft', entityId: id, event: 'edited', detail: {} });
}

/**
 * Set the per-draft deliverability override. When true, sendApprovedDraft
 * lets a risky recipient through the min_email_status_for_auto_send gate.
 * Called by handleApprove (Telegram) to encode informed consent — the
 * applicant already saw the [risky] badge in /list before approving.
 */
export function setDraftDeliverabilityOverride(id, override = true) {
  getDb().prepare('UPDATE draft SET deliverability_override = ? WHERE id = ?')
    .run(override ? 1 : 0, id);
}

/**
 * Any pending_review draft for this contact+job (used to skip re-draft).
 */
/**
 * True when a company already has a draft awaiting the applicant's decision.
 * 'sent' is deliberately excluded - re-contact after a send is governed by the
 * 90-day rule in gate5, not here.
 */
export function companyHasOpenDraft(companyId) {
  const row = getDb().prepare(`
    SELECT 1 FROM draft d
    JOIN contact c ON c.id = d.contact_id
    WHERE c.company_id = ? AND d.status IN ('pending_review','approved')
    LIMIT 1
  `).get(companyId);
  return Boolean(row);
}

/* ── rejection learning ──────────────────────────────────── */

export function setDraftRedraftBlocked(draftId, blocked = true) {
  getDb().prepare('UPDATE draft SET redraft_blocked = ? WHERE id = ?').run(blocked ? 1 : 0, draftId);
}

/** True when the applicant rejected a draft for exactly this contact and job. */
export function redraftBlockedFor(contactId, jobId) {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM draft
    WHERE contact_id = ? AND (job_id = ? OR (? IS NULL AND job_id IS NULL))
      AND status = 'rejected' AND redraft_blocked = 1
    LIMIT 1
  `).get(contactId, jobId, jobId));
}

export function addRejectionRule({ kind, value, reason = null, sourceDraftId = null }) {
  const info = getDb().prepare(`
    INSERT OR IGNORE INTO rejection_rule (kind, value, reason, source_draft_id)
    VALUES (?, ?, ?, ?)
  `).run(kind, String(value), reason, sourceDraftId);
  if (info.changes > 0) {
    recordEvent({
      entity: 'rejection_rule', entityId: info.lastInsertRowid, event: 'learned',
      detail: { kind, value, reason, sourceDraftId },
    });
  }
  return { created: info.changes > 0 };
}

export function listRejectionRules() {
  return getDb().prepare('SELECT * FROM rejection_rule ORDER BY id ASC').all();
}

export function rejectionRuleById(id) {
  return getDb().prepare('SELECT * FROM rejection_rule WHERE id = ?').get(id);
}

export function deleteRejectionRule(id) {
  const info = getDb().prepare('DELETE FROM rejection_rule WHERE id = ?').run(id);
  if (info.changes > 0) {
    recordEvent({ entity: 'rejection_rule', entityId: id, event: 'forgotten', detail: {} });
  }
  return info.changes > 0;
}

/** Address rules in the shape draft/rejection-rules.js isAddressBlocked() takes. */
export function addressBlockRules() {
  const rows = getDb().prepare(
    `SELECT kind, value FROM rejection_rule WHERE kind IN ('local_part','all_role_aliases')`
  ).all();
  return {
    families: new Set(rows.filter(r => r.kind === 'local_part').map(r => r.value)),
    allRoleAliases: rows.some(r => r.kind === 'all_role_aliases'),
  };
}

export function usableContacts() {
  return getDb().prepare(`SELECT * FROM contact WHERE email_status != 'invalid'`).all();
}

export function openDraftsForContact(contactId) {
  return getDb().prepare(
    `SELECT * FROM draft WHERE contact_id = ? AND status IN ('pending_review','approved')`
  ).all(contactId);
}

export function usableContactCountForCompany(companyId) {
  return getDb().prepare(
    `SELECT COUNT(*) AS n FROM contact WHERE company_id = ? AND email_status != 'invalid'`
  ).get(companyId).n;
}

export function markEnrichAttempt(companyId) {
  getDb().prepare(
    `UPDATE company SET last_enrich_attempt_at = datetime('now') WHERE id = ?`
  ).run(companyId);
}

export function enrichAttemptedWithinDays(companyId, days) {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM company
    WHERE id = ? AND last_enrich_attempt_at IS NOT NULL
      AND last_enrich_attempt_at > datetime('now', ?)
  `).get(companyId, `-${days} days`));
}

export function existingDraftFor(contactId, jobId) {
  return getDb().prepare(`
    SELECT * FROM draft
    WHERE contact_id = ? AND (job_id = ? OR (? IS NULL AND job_id IS NULL))
      AND status IN ('pending_review','approved','sent')
    LIMIT 1
  `).get(contactId, jobId, jobId);
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
