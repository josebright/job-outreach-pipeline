// send/index.js
// Module 6 per PRD. Gmail API send + cap enforcement + suppression check.
// Full send loop lands in Week 5. The invariant guards below are already
// enforced today (and covered by tests), so they cannot be bypassed later.
import { isSuppressed, getSendCount, incrementSendCount } from '../db/repo.js';
import { recordEvent } from '../db/event-log.js';
import { logger } from '../util/logger.js';

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
 *
 * Guards (all covered by tests):
 *   1. draft.status must be 'approved'.
 *   2. recipient must not be in the suppression list.
 *   3. daily cap for this kind (initial | followup) must not be exceeded.
 *
 * Transport is a pluggable arg so tests can pass a fake without touching Gmail.
 */
export async function sendApprovedDraft({ draft, recipientEmail, kind, caps, transport }) {
  if (draft.status !== 'approved') {
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

  const result = await transport.send({
    to: recipientEmail,
    subject: draft.subject,
    body: draft.body,
  });

  incrementSendCount(kind);
  recordEvent({
    entity: 'draft',
    entityId: draft.id,
    event: 'sent',
    detail: { kind, messageId: result?.messageId },
  });

  return result;
}

export async function runSend({ config: _config } = {}) {
  logger.info('send: full send loop not yet implemented (Week 5 milestone). Guards are live.');
  return { attempted: 0, sent: 0, blocked: 0 };
}
