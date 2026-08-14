// send/reply-detect.js
// Poll Gmail for inbound messages, match to outbound threads, mark replies
// and bounces. Emits suppression entries on bounce, and pauses sending when
// the 7-day bounce rate crosses config.bounce_rate_alarm_pct.
import { getDb } from '../db/connection.js';
import { suppress, isSuppressed } from '../db/repo.js';
import { recordEvent } from '../db/event-log.js';
import { listInboundSince } from './gmail.js';
import { logger } from '../util/logger.js';

const POLL_WINDOW_HOURS = 24;   // fetch inbox from last 24h each pass

/**
 * Main poll loop. Returns per-pass counters.
 */
export async function pollReplies({ config }) {
  const stats = { fetched: 0, matched: 0, replies: 0, bounces: 0, autoReplies: 0 };
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

    // Bounce: mailer-daemon or explicit failed-recipients header.
    const isBounce = /mailer-daemon|postmaster/i.test(from) || Boolean(failedRecipients);
    if (isBounce) {
      const bounced = failedRecipients || extractAddressFromSubject(subject);
      if (bounced) {
        markBounce(m, bounced);
        stats.bounces++;
      }
      continue;
    }

    // Match reply by In-Reply-To / References to any message we sent.
    const linked = findLinkedMessage(inReplyTo, references, m.threadId);
    if (!linked) continue;
    stats.matched++;

    // Auto-reply handling (out-of-office etc).
    const isAuto = /^auto/i.test(autoSubmitted);
    const sentiment = isAuto ? 'auto_reply' : 'neutral';
    persistReply({ msg: m, linkedMessageId: linked.id, sentiment, headers });
    if (isAuto) stats.autoReplies++;
    else stats.replies++;
  }

  // Bounce alarm auto-pause: if last 7d bounce rate > threshold, set a flag.
  maybePauseOnBounceAlarm(config, stats);

  logger.info(stats, 'reply poll complete');
  return stats;
}

/* ── helpers ────────────────────────────────────────────────── */

function findLinkedMessage(inReplyTo, references, threadId) {
  const db = getDb();
  if (inReplyTo) {
    const row = db.prepare(`SELECT * FROM message WHERE message_id = ?`).get(inReplyTo.trim().replace(/[<>]/g, ''));
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
    const row = db.prepare(`SELECT * FROM message WHERE thread_id = ? AND direction = 'outbound' ORDER BY id ASC LIMIT 1`).get(threadId);
    if (row) return row;
  }
  return null;
}

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

function extractAddressFromSubject(subject) {
  const m = String(subject || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : null;
}

function maybePauseOnBounceAlarm(config, stats) {
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
  if (total < 10) return; // too small a sample to alarm on
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

/**
 * True if the bounce alarm has paused sending.
 */
export function isPaused() {
  const row = getDb().prepare(`
    SELECT 1 FROM send_counter WHERE date = 'PAUSED' AND kind = 'alarm'
  `).get();
  return Boolean(row);
}
