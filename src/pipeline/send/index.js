// send/index.js
// Module 6 per PRD. Ties together:
//   - Safety invariants (approved-only, suppression, daily cap)
//   - Gmail transport
//   - Follow-up scheduling (day 4, day 10)
//   - Reply detection + bounce → auto-suppress + bounce-rate alarm auto-pause
//
// runSend is what the send-window cron (07:30 UTC in scripts/service.js)
// and the /send Telegram command both call. sendApprovedDraft is the
// single send path every outbound message goes through; guards live here.
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
import { effectiveCap } from './warmup.js';
import { isResearchRole } from '../qualify/roles.js';
import { isAtsEmail } from '../util/ats-domains.js';

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
  counterKind = null,
  recipientEmailStatus = null, minEmailStatus = null,
}) {
  if (draft.status !== 'approved' && kind === 'initial') {
    throw new SendBlockedError('draft_not_approved', { draftId: draft.id, status: draft.status });
  }
  if (isSuppressed(recipientEmail)) {
    throw new SendBlockedError('recipient_suppressed', { recipientEmail });
  }
  // An address at an ATS / job-board host (founders@api.smartrecruiters.com)
  // is a pattern-probe artifact, never a real inbox. deriveDomain no longer
  // produces these, but rows created before that fix still sit in the DB and
  // are already attached to approved drafts. Sending one is a guaranteed
  // bounce, and bounces trip the alarm that pauses the entire pipeline — so
  // this stays as a hard guard on the single send path rather than relying
  // on upstream cleanup alone. Not overridable by /approve.
  if (isAtsEmail(recipientEmail)) {
    throw new SendBlockedError('recipient_ats_domain', { recipientEmail });
  }
  // Deliverability gate. When a min is configured, the recipient must meet
  // it. Fail-closed: missing status is treated as not meeting the bar.
  // Protects sender reputation — one risky send during warm-up can trip the
  // bounce alarm and pause the whole pipeline.
  //
  // Per-draft override: if the applicant explicitly /approved this draft
  // via Telegram, they've seen the [risky] badge in /list and are giving
  // informed consent. Bypass the gate for THIS draft only and log an
  // event so the risky send is attributable if it bounces.
  if (minEmailStatus && !meetsMinStatus(recipientEmailStatus, minEmailStatus)) {
    if (draft.deliverability_override) {
      recordEvent({
        entity: 'draft', entityId: draft.id, event: 'deliverability_override_used',
        detail: { recipientEmail, emailStatus: recipientEmailStatus, required: minEmailStatus },
      });
    } else {
      throw new SendBlockedError('recipient_unverified', {
        recipientEmail, emailStatus: recipientEmailStatus, required: minEmailStatus,
      });
    }
  }
  // `counterKind` routes cap accounting into a separate bucket (e.g., the
  // research-role bucket) without changing the message.kind stored on the
  // outbound record. Defaults to `kind` for backward compatibility.
  const bucket = counterKind || kind;
  const cap = pickCap(bucket, caps);
  const already = getSendCount(bucket);
  if (already >= cap) {
    throw new SendBlockedError('daily_cap_reached', { kind: bucket, cap, already });
  }

  const subject = kind === 'initial' ? draft.subject : threadedSubject(draft.subject);
  const body = kind === 'initial' ? draft.body : draft.body;    // body override done by caller for follow-ups
  const result = await transport.send({
    from: fromEmail, fromName, to: recipientEmail, subject, body,
    replyTo, threadId, inReplyTo, references,
  });

  const messageId = result?.messageId || null;
  const rawMessageId = result?.rfc5322MessageId || messageId;

  // Wrap all DB writes in one transaction so a mid-way container kill cannot
  // leave the send counter incremented without the corresponding message row
  // (QA 3.3). Either all four writes commit or none do.
  const db = getDb();
  const tx = db.transaction(() => {
    incrementSendCount(bucket);
    db.prepare(`
      INSERT INTO message (draft_id, direction, kind, sent_at, thread_id, message_id)
      VALUES (?, 'outbound', ?, datetime('now'), ?, ?)
    `).run(draft.id, kind, result?.threadId || null, rawMessageId);
    if (kind === 'initial') updateDraftStatus(draft.id, 'sent');
    recordEvent({
      entity: 'draft', entityId: draft.id, event: 'sent',
      detail: { kind, messageId: rawMessageId, threadId: result?.threadId || null },
    });
  });
  tx();

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
    initialSent: 0, researchSent: 0, followup1Sent: 0, followup2Sent: 0,
    blockedApproval: 0, blockedSuppressed: 0, blockedCap: 0, blockedUnverified: 0,
    blockedAtsDomain: 0, errors: 0,
  };
  const minEmailStatus = config?.enrichment?.min_email_status_for_auto_send || null;

  // 1. Reply + bounce poll.
  try { stats.replies = await pollReplies({ config }); }
  catch (err) { logger.error({ err: err.message }, 'reply poll errored (non-fatal)'); }

  if (isPaused()) {
    stats.paused = true;
    logger.warn('sending is paused (bounce alarm)');
    return stats;
  }

  // Apply warm-up ramp if configured.
  const initialCap  = effectiveCap({ kind: 'initial',  config });
  const followupCap = effectiveCap({ kind: 'followup', config });
  if (initialCap.isRamping) {
    logger.info({ warmupDay: initialCap.warmupDay, initialCap: initialCap.cap, followupCap: followupCap.cap },
      'sending under warm-up ramp');
  }
  // Research-role bucket is a fixed side channel — not ramped and does not
  // eat the primary engineering cap.
  const researchCap = Number(config.send.research_daily_cap ?? 0);
  const caps = {
    initial: initialCap.cap,
    followup: followupCap.cap,
    initial_research: researchCap,
  };

  // Load profile once for follow-up bodies.
  let profile = null;
  try { profile = loadProfile(); } catch { /* fine, follow-ups will use minimal sig */ }

  const transport = { send: sendMessage };
  const from = config.send.sender_email;
  const fromName = config.send.sender_name;
  const replyTo = config.send.reply_to || null;

  // 2. Initial sends. Research-role drafts route into a separate bucket so
  // they do not consume the primary engineering cap. Order approved drafts
  // so research jobs get processed even after the main bucket fills.
  const approved = draftsByStatus('approved');
  const [primaryQueue, researchQueue] = partitionApprovedByRole(approved);

  for (const draft of primaryQueue) {
    const contact = contactById(draft.contact_id);
    if (!contact) continue;
    try {
      await sendApprovedDraft({
        draft, recipientEmail: contact.email, kind: 'initial', caps, transport,
        fromEmail: from, fromName, replyTo,
        recipientEmailStatus: contact.email_status, minEmailStatus,
      });
      stats.initialSent++;
    } catch (err) {
      catchBlocked(err, stats);
    }
    if (getSendCount('initial') >= caps.initial) break;
  }

  for (const draft of researchQueue) {
    if (caps.initial_research <= 0) break;
    const contact = contactById(draft.contact_id);
    if (!contact) continue;
    try {
      await sendApprovedDraft({
        draft, recipientEmail: contact.email, kind: 'initial', caps, transport,
        fromEmail: from, fromName, replyTo,
        counterKind: 'initial_research',
        recipientEmailStatus: contact.email_status, minEmailStatus,
      });
      stats.researchSent++;
    } catch (err) {
      catchBlocked(err, stats);
    }
    if (getSendCount('initial_research') >= caps.initial_research) break;
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
        recipientEmailStatus: contact.email_status, minEmailStatus,
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
        recipientEmailStatus: contact.email_status, minEmailStatus,
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
    else if (err.reason === 'recipient_unverified') stats.blockedUnverified++;
    else if (err.reason === 'recipient_ats_domain') stats.blockedAtsDomain++;
    else stats.errors++;
    logger.warn({ reason: err.reason, detail: err.detail }, 'send blocked');
    return;
  }
  stats.errors++;
  logger.error({ err: err.message }, 'send errored');
}

// 'verified' is the strict tier; 'risky' includes verified + risky. Anything
// else (invalid, null, unknown, accept_all) fails the check.
function meetsMinStatus(actual, min) {
  if (min === 'verified') return actual === 'verified';
  if (min === 'risky')    return actual === 'verified' || actual === 'risky';
  return true;
}

function initialMessageFor(draftId) {
  return getDb().prepare(`
    SELECT * FROM message WHERE draft_id = ? AND kind = 'initial' AND direction = 'outbound'
    ORDER BY id ASC LIMIT 1
  `).get(draftId);
}

function pickCap(bucket, caps) {
  if (bucket === 'initial') return caps.initial;
  if (bucket === 'initial_research') return caps.initial_research ?? 0;
  return caps.followup;
}

// Split approved drafts into (primary, research) by looking up the job title
// on each draft. Draft rows without a linked job stay in the primary queue.
function partitionApprovedByRole(drafts) {
  const primary = [];
  const research = [];
  for (const d of drafts) {
    const job = d.job_id ? getDb().prepare('SELECT title FROM job WHERE id = ?').get(d.job_id) : null;
    if (job && isResearchRole(job.title)) research.push(d);
    else primary.push(d);
  }
  return [primary, research];
}
