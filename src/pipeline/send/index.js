// send/index.js
// Module 6 per PRD. Ties together:
//   - Safety invariants (approved-only, suppression, daily cap)
//   - Gmail transport
//   - Follow-up scheduling (day 4, day 10)
//   - Reply detection + bounce → auto-suppress + bounce-rate alarm auto-pause
//
// runSend is what the daily cron calls. sendApprovedDraft is the single
// send path every outbound message goes through; guards live here.
import {
  getSendCount, incrementSendCount, isSuppressed,
  draftsByStatus, draftById, contactById, updateDraftStatus,
} from '../db/repo.js';
import { recordEvent } from '../db/event-log.js';
import { getDb } from '../db/connection.js';
import { logger } from '../util/logger.js';
import { loadProfile } from '../draft/profile.js';
import { sendMessage } from './gmail.js';
import { draftsDueForFollowup, followupBody, threadedSubject } from './follow-up.js';
import { pollReplies, isPaused } from './reply-detect.js';

export class SendBlockedError extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = 'SendBlockedError';
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * The one and only send path. Every outgoing message must go through this.
 * Transport is pluggable so tests can pass a fake.
 */
export async function sendApprovedDraft({
  draft, recipientEmail, kind, caps, transport,
  fromName = null, fromEmail = null, replyTo = null,
  threadId = null, inReplyTo = null, references = null,
}) {
  if (draft.status !== 'approved' && kind === 'initial') {
    throw new SendBlockedError('draft_not_approved', { draftId: draft.id, status: draft.status });
  }
  if (isSuppressed(recipientEmail)) {
    throw new SendBlockedError('recipient_suppressed', { recipientEmail });
  }
  const cap = kind === 'initial' ? caps.initial : caps.followup;
  const already = getSendCount(kind);
  if (already >= cap) {
    throw new SendBlockedError('daily_cap_reached', { kind, cap, already });
  }

  const subject = kind === 'initial' ? draft.subject : threadedSubject(draft.subject);
  const body = kind === 'initial' ? draft.body : draft.body;    // body override done by caller for follow-ups
  const result = await transport.send({
    from: fromEmail, fromName, to: recipientEmail, subject, body,
    replyTo, threadId, inReplyTo, references,
  });

  incrementSendCount(kind);
  const messageId = result?.messageId || null;
  const rawMessageId = result?.rfc5322MessageId || messageId;

  const db = getDb();
  db.prepare(`
    INSERT INTO message (draft_id, direction, kind, sent_at, thread_id, message_id)
    VALUES (?, 'outbound', ?, datetime('now'), ?, ?)
  `).run(draft.id, kind, result?.threadId || null, rawMessageId);

  if (kind === 'initial') updateDraftStatus(draft.id, 'sent');
  recordEvent({
    entity: 'draft', entityId: draft.id, event: 'sent',
    detail: { kind, messageId: rawMessageId, threadId: result?.threadId || null },
  });

  return result;
}

/**
 * The daily send loop. Order:
 *   1. Poll for replies + bounces (updates suppression + alarm).
 *   2. If paused, stop.
 *   3. Send approved initials up to daily cap.
 *   4. Send scheduled follow-ups up to follow-up cap.
 */
export async function runSend({ config } = {}) {
  const stats = {
    replies: null, paused: false,
    initialSent: 0, followup1Sent: 0, followup2Sent: 0,
    blockedApproval: 0, blockedSuppressed: 0, blockedCap: 0, errors: 0,
  };

  // 1. Reply + bounce poll.
  try { stats.replies = await pollReplies({ config }); }
  catch (err) { logger.error({ err: err.message }, 'reply poll errored (non-fatal)'); }

  if (isPaused()) {
    stats.paused = true;
    logger.warn('sending is paused (bounce alarm)');
    return stats;
  }

  const caps = {
    initial: config.send.daily_cap_initial,
    followup: config.send.daily_cap_followup,
  };

  // Load profile once for follow-up bodies.
  let profile = null;
  try { profile = loadProfile(); } catch { /* fine, follow-ups will use minimal sig */ }

  const transport = { send: sendMessage };
  const from = config.send.sender_email;
  const fromName = config.send.sender_name;
  const replyTo = config.send.reply_to || null;

  // 2. Initial sends.
  for (const draft of draftsByStatus('approved')) {
    const contact = contactById(draft.contact_id);
    if (!contact) continue;
    try {
      await sendApprovedDraft({
        draft, recipientEmail: contact.email, kind: 'initial', caps, transport,
        fromEmail: from, fromName, replyTo,
      });
      stats.initialSent++;
    } catch (err) {
      catchBlocked(err, stats);
    }
    if (getSendCount('initial') >= caps.initial) break;
  }

  // 3. Follow-up 1 (day 4).
  for (const draft of draftsDueForFollowup('followup_1')) {
    const contact = contactById(draft.contact_id);
    if (!contact) continue;
    const init = initialMessageFor(draft.id);
    try {
      await sendApprovedDraft({
        draft: { ...draft, body: followupBody({ profile, kind: 'followup_1' }) },
        recipientEmail: contact.email, kind: 'followup_1', caps, transport,
        fromEmail: from, fromName, replyTo,
        threadId: init?.thread_id || null,
        inReplyTo: init?.message_id ? `<${init.message_id}>` : null,
        references: init?.message_id ? `<${init.message_id}>` : null,
      });
      stats.followup1Sent++;
    } catch (err) {
      catchBlocked(err, stats);
    }
    if (getSendCount('followup') >= caps.followup) break;
  }

  // 4. Follow-up 2 (day 10, breakup).
  for (const draft of draftsDueForFollowup('followup_2')) {
    const contact = contactById(draft.contact_id);
    if (!contact) continue;
    const init = initialMessageFor(draft.id);
    try {
      await sendApprovedDraft({
        draft: { ...draft, body: followupBody({ profile, kind: 'followup_2' }) },
        recipientEmail: contact.email, kind: 'followup_2', caps, transport,
        fromEmail: from, fromName, replyTo,
        threadId: init?.thread_id || null,
        inReplyTo: init?.message_id ? `<${init.message_id}>` : null,
        references: init?.message_id ? `<${init.message_id}>` : null,
      });
      stats.followup2Sent++;
    } catch (err) {
      catchBlocked(err, stats);
    }
    if (getSendCount('followup') >= caps.followup) break;
  }

  logger.info(stats, 'send pass complete');
  return stats;
}

function catchBlocked(err, stats) {
  if (err.name === 'SendBlockedError') {
    if (err.reason === 'draft_not_approved') stats.blockedApproval++;
    else if (err.reason === 'recipient_suppressed') stats.blockedSuppressed++;
    else if (err.reason === 'daily_cap_reached') stats.blockedCap++;
    else stats.errors++;
    logger.warn({ reason: err.reason, detail: err.detail }, 'send blocked');
    return;
  }
  stats.errors++;
  logger.error({ err: err.message }, 'send errored');
}

function initialMessageFor(draftId) {
  return getDb().prepare(`
    SELECT * FROM message WHERE draft_id = ? AND kind = 'initial' AND direction = 'outbound'
    ORDER BY id ASC LIMIT 1
  `).get(draftId);
}
