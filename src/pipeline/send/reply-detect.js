// send/reply-detect.js
// Poll Gmail for inbound messages, match to outbound threads, mark replies
// and bounces. Emits suppression entries on bounce, and pauses sending when
// the 7-day bounce rate crosses config.bounce_rate_alarm_pct.
import { getDb } from '../db/connection.js';
import { suppress, isSuppressed } from '../db/repo.js';
import { recordEvent } from '../db/event-log.js';
import { listInboundSince, getMessageBodyText } from './gmail.js';
import { logger } from '../util/logger.js';

const POLL_WINDOW_HOURS = 24;
const REPLY_MATCH_LOOKBACK_DAYS = 30;

/**
 * Main poll loop. Returns per-pass counters.
 */
export async function pollReplies({ config }) {
  const stats = { fetched: 0, matched: 0, replies: 0, bounces: 0, autoReplies: 0, unmatched: 0 };
  const afterEpochSec = Math.floor((Date.now() - POLL_WINDOW_HOURS * 3600 * 1000) / 1000);

  let msgs = [];
  try {
    msgs = await listInboundSince({ afterEpochSec });
  } catch (err) {
    logger.error({ err: err.message }, 'gmail poll failed');
    return stats;
  }
  stats.fetched = msgs.length;

  for (const m of msgs) {
    const headers = Object.fromEntries(
      (m.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value])
    );
    const inReplyTo = headers['in-reply-to'] || '';
    const references = headers['references'] || '';
    const from = headers['from'] || '';
    const subject = headers['subject'] || '';
    const failedRecipients = headers['x-failed-recipients'] || '';
    const autoSubmitted = headers['auto-submitted'] || '';
    const contentType = (headers['content-type'] || '').toLowerCase();

    // ── Bounce detection ────────────────────────────────────
    // Signals in priority order:
    //   1. X-Failed-Recipients header (Gmail sets this on some bounces)
    //   2. From: mailer-daemon@ or postmaster@
    //   3. Content-Type: multipart/report; report-type=delivery-status
    const isBounce =
      Boolean(failedRecipients) ||
      /mailer-daemon|postmaster/i.test(from) ||
      contentType.includes('multipart/report') && contentType.includes('delivery-status');

    if (isBounce) {
      const bounced = await extractBouncedAddresses({
        msgId: m.id,
        failedRecipientsHeader: failedRecipients,
        snippet: m.snippet || '',
        subject,
      });
      if (bounced.length === 0) {
        logger.warn({ msgId: m.id, from, subject }, 'bounce detected but no failed address found');
        continue;
      }
      for (const email of bounced) {
        markBounce(m, email);
        stats.bounces++;
      }
      continue;
    }

    // ── Reply matching ─────────────────────────────────────
    let linked = findByHeaders(inReplyTo, references, m.threadId);
    if (!linked) linked = findByFromAndSubject(from, subject);
    if (!linked) {
      stats.unmatched++;
      continue;
    }
    stats.matched++;

    const isAuto = /^auto/i.test(autoSubmitted) || autoReplySubject(subject);
    const sentiment = isAuto ? 'auto_reply' : 'neutral';
    persistReply({ msg: m, linkedMessageId: linked.id, sentiment, headers });
    if (isAuto) stats.autoReplies++;
    else stats.replies++;
  }

  maybePauseOnBounceAlarm(config, stats);

  logger.info(stats, 'reply poll complete');
  return stats;
}

/* ── helpers: reply matching ────────────────────────────────── */

function findByHeaders(inReplyTo, references, threadId) {
  const db = getDb();
  if (inReplyTo) {
    const row = db.prepare(`SELECT * FROM message WHERE message_id = ?`)
      .get(inReplyTo.trim().replace(/[<>]/g, ''));
    if (row) return row;
  }
  if (references) {
    const ids = references.split(/\s+/).map(s => s.replace(/[<>]/g, '')).filter(Boolean);
    for (const id of ids) {
      const row = db.prepare(`SELECT * FROM message WHERE message_id = ?`).get(id);
      if (row) return row;
    }
  }
  if (threadId) {
    const row = db.prepare(`
      SELECT * FROM message WHERE thread_id = ? AND direction = 'outbound'
      ORDER BY id ASC LIMIT 1
    `).get(threadId);
    if (row) return row;
  }
  return null;
}

/**
 * Fallback: some clients strip In-Reply-To/References (forwards, some mobile
 * apps, compose-fresh replies). Match by (from email == our recipient) plus
 * subject (with Re:/Fwd: stripped) against outbound messages sent in the last
 * REPLY_MATCH_LOOKBACK_DAYS to that recipient.
 */
export function findByFromAndSubject(fromHeader, subject) {
  const fromEmail = parseEmailAddress(fromHeader);
  if (!fromEmail) return null;
  const cleanSubject = normalizeSubject(subject);
  if (!cleanSubject) return null;

  const db = getDb();
  const rows = db.prepare(`
    SELECT m.* FROM message m
    JOIN draft d   ON d.id = m.draft_id
    JOIN contact c ON c.id = d.contact_id
    WHERE m.direction = 'outbound'
      AND m.sent_at > datetime('now', ?)
      AND lower(c.email) = ?
    ORDER BY m.id DESC
  `).all(`-${REPLY_MATCH_LOOKBACK_DAYS} days`, fromEmail);

  for (const row of rows) {
    const draft = db.prepare(`SELECT subject FROM draft WHERE id = ?`).get(row.draft_id);
    if (!draft) continue;
    if (normalizeSubject(draft.subject) === cleanSubject) return row;
  }
  return null;
}

/* ── helpers: bounce extraction ─────────────────────────────── */

/**
 * Extract every failed recipient address from a bounce. Tries multiple
 * signals; skips our own sender addresses.
 */
export async function extractBouncedAddresses({
  msgId, failedRecipientsHeader = '', snippet = '', subject = '',
}) {
  const found = new Set();

  // 1. Header (Gmail's own bounces).
  splitEmailList(failedRecipientsHeader).forEach(e => found.add(e));
  if (found.size) return [...found];

  // 2. Snippet (Gmail's preview of the DSN, always available).
  parseDsnBody(snippet).forEach(e => found.add(e));
  parseDsnBody(subject).forEach(e => found.add(e));
  if (found.size) return [...found];

  // 3. Full body (last resort, one extra Gmail API call).
  try {
    const body = await getMessageBodyText(msgId);
    parseDsnBody(body).forEach(e => found.add(e));
  } catch { /* ignore, we tried */ }

  return [...found];
}

const EMAIL_TOKEN_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Parse a DSN body for failed recipient addresses. Priority:
//   Final-Recipient: rfc822; user@domain
//   Diagnostic-Code / SMTP 550/551/552/553/554 with <user@domain>
//   Common phrasing: "The following address(es) failed"
// Returns lowercased addresses, minus our own sender addresses.
export function parseDsnBody(text) {
  if (!text) return [];
  const out = new Set();

  for (const m of text.matchAll(/Final-Recipient:\s*(?:rfc822;\s*)?([^\s<>]+@[^\s<>]+)/gi)) {
    out.add(m[1].toLowerCase());
  }
  if (out.size) return [...out].filter(notOurAddress);

  for (const m of text.matchAll(/\b5\d{2}[\s\-]+\d\.\d\.\d[^\n]*?<([^>]+@[^>]+)>/g)) {
    out.add(m[1].toLowerCase());
  }
  if (out.size) return [...out].filter(notOurAddress);

  // Loose fallback: any email in the text minus ours + mailer-daemon.
  for (const m of text.matchAll(EMAIL_TOKEN_RE)) {
    const e = m[0].toLowerCase();
    if (notOurAddress(e)) out.add(e);
  }
  return [...out];
}

// Addresses that appear in every DSN and are not the bounced recipient.
const SELF_LOCAL_PARTS = new Set(['mailer-daemon', 'postmaster', 'noreply', 'no-reply']);
function notOurAddress(email) {
  const [local, domain] = email.split('@');
  if (SELF_LOCAL_PARTS.has((local || '').toLowerCase())) return false;
  if ((domain || '').toLowerCase() === 'capacitydey.org') return false;   // our sending domain
  return true;
}

function splitEmailList(header) {
  if (!header) return [];
  return String(header).split(/[,;\s]+/)
    .map(e => e.trim().toLowerCase())
    .filter(e => /@/.test(e));
}

/* ── helpers: normalization ─────────────────────────────────── */

export function parseEmailAddress(header) {
  if (!header) return null;
  const m = String(header).match(EMAIL_TOKEN_RE);
  return m ? m[0].toLowerCase() : null;
}

export function normalizeSubject(subject) {
  if (!subject) return '';
  return String(subject)
    .replace(/^(re|fwd?|antwort|aw):\s*/gi, '')
    .replace(/^(re|fwd?|antwort|aw):\s*/gi, '')  // second pass for "Re: Re:"
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function autoReplySubject(subject) {
  const s = String(subject || '').toLowerCase();
  return /out of office|automatic reply|autoreply|abwesenheit|hors du bureau/.test(s);
}

/* ── writes ────────────────────────────────────────────────── */

function persistReply({ msg, linkedMessageId, sentiment, headers }) {
  const db = getDb();
  db.prepare(`
    UPDATE message SET replied_at = datetime('now'), reply_sentiment = ?
    WHERE id = ?
  `).run(sentiment, linkedMessageId);
  db.prepare(`
    INSERT INTO message (draft_id, direction, kind, sent_at, thread_id, message_id, raw)
    SELECT draft_id, 'inbound', 'reply', datetime('now'), ?, ?, ?
    FROM message WHERE id = ?
  `).run(
    msg.threadId || null,
    headers['message-id'] || null,
    JSON.stringify({ headers, snippet: msg.snippet || null }),
    linkedMessageId,
  );
  recordEvent({ entity: 'message', entityId: linkedMessageId, event: 'replied', detail: { sentiment } });
}

function markBounce(msg, bouncedEmail) {
  if (!bouncedEmail || isSuppressed(bouncedEmail)) return;
  const db = getDb();
  db.prepare(`
    UPDATE message SET bounced = 1
    WHERE thread_id = ? AND direction = 'outbound'
  `).run(msg.threadId || null);
  suppress(bouncedEmail, 'bounce', 'Detected via inbound bounce notification');
}

/* ── bounce alarm ──────────────────────────────────────────── */

function maybePauseOnBounceAlarm(config, _stats) {
  const cap = config.send?.bounce_rate_alarm_pct ?? 3;
  const db = getDb();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN bounced = 1 THEN 1 ELSE 0 END) * 1.0 AS bounces,
      COUNT(*) * 1.0 AS total
    FROM message
    WHERE direction = 'outbound' AND kind IN ('initial','followup_1','followup_2')
      AND sent_at > datetime('now', '-7 days')
  `).get();
  const total = Number(row?.total || 0);
  if (total < 10) return;
  const pct = (Number(row?.bounces || 0) / total) * 100;
  if (pct > cap) {
    db.prepare(`
      INSERT OR REPLACE INTO send_counter (date, kind, count)
      VALUES ('PAUSED', 'alarm', 1)
    `).run();
    recordEvent({ entity: 'system', event: 'bounce_alarm_pause', detail: { bounceRatePct: pct, cap } });
    logger.warn({ bounceRatePct: pct, cap }, 'BOUNCE ALARM: sending paused');
  }
}

export function isPaused() {
  const row = getDb().prepare(`
    SELECT 1 FROM send_counter WHERE date = 'PAUSED' AND kind = 'alarm'
  `).get();
  return Boolean(row);
}
