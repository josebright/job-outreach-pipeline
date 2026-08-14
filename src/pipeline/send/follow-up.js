// send/follow-up.js
// Follow-up templates and scheduling logic.
// Rules per PRD Module 6:
//   - No reply after 4 days -> follow-up 1 (short, adds one new proof point)
//   - No reply after 10 days from initial -> follow-up 2 (breakup email)
//   - Any inbound reply -> cancel remaining follow-ups.
import { getDb } from '../db/connection.js';

/**
 * Return drafts whose initial message was sent N days ago and have not
 * received a reply or a follow-up of the given kind yet.
 */
export function draftsDueForFollowup(kind /* 'followup_1'|'followup_2' */) {
  const days = kind === 'followup_1' ? 4 : 10;
  const db = getDb();
  return db.prepare(`
    SELECT d.*
    FROM draft d
    JOIN message init ON init.draft_id = d.id AND init.kind = 'initial'
    WHERE d.status = 'sent'
      AND init.sent_at IS NOT NULL
      AND init.replied_at IS NULL
      AND init.sent_at <= datetime('now', ?)
      AND NOT EXISTS (
        SELECT 1 FROM message m2 WHERE m2.draft_id = d.id AND m2.kind = ?
      )
  `).all(`-${days} days`, kind);
}

/**
 * Compact follow-up bodies. Kept plain-text and short. The initial subject
 * is reused (with "Re:") so it threads in Gmail.
 */
export function followupBody({ profile, kind }) {
  const linkedin = profile?.links?.linkedin || '';
  const website  = profile?.links?.website  || '';
  const sig = [profile?.name, linkedin, website].filter(Boolean).join('\n');
  const optOut = 'If this is not relevant, tell me and I will not write again.';

  if (kind === 'followup_1') {
    return [
      'Just bumping this up in case it slipped past.',
      '',
      'One more data point that might be relevant: I ship senior-level backend and platform work end-to-end, and I already have my contractor setup ready via Deel or Remote.com, so onboarding does not require your payroll team.',
      '',
      'Happy to send a short write-up if useful.',
      '',
      sig,
      '',
      optOut,
    ].join('\n');
  }
  return [
    'Closing the loop on my earlier note.',
    '',
    'If this is not the right time or fit, no problem. I will not write again unless you want me to.',
    '',
    sig,
  ].join('\n');
}

/**
 * "Re: {subject}" if not already prefixed.
 */
export function threadedSubject(originalSubject) {
  const s = String(originalSubject || '').trim();
  if (/^re:\s*/i.test(s)) return s;
  return `Re: ${s}`;
}
