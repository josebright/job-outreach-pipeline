// bot/handlers.js
// Business logic for each Telegram command. Kept separate from the Telegraf
// wiring so it is unit-testable.
import {
  draftsByStatus, draftById, contactById, companyById, jobById,
  updateDraftStatus,
} from '../db/repo.js';
import { getDb } from '../db/connection.js';
import { recordEvent } from '../db/event-log.js';
import { sendMessage } from '../send/gmail.js';
import { runSend } from '../send/index.js';
import { runReport } from '../report/index.js';
import { loadConfig } from '../config/loader.js';
import { escapeHtml } from './telegram.js';

/* ── read commands ────────────────────────────────────────── */

export function handleList() {
  const rows = draftsByStatus('pending_review').concat(draftsByStatus('approved'));
  if (rows.length === 0) return 'No drafts pending review or waiting to send.';

  const lines = ['<b>Drafts queue</b>', ''];
  for (const d of rows) {
    const contact = contactById(d.contact_id);
    const company = contact ? companyById(contact.company_id) : null;
    const flag = d.hook_verified ? '' : ' hook-unverified';
    const stateMark = d.status === 'approved' ? '[APPROVED]' : '[pending]';
    lines.push(
      `#${d.id} ${stateMark}${flag}`,
      `  ${escapeHtml((company?.name || '?').slice(0, 30))} score=${company?.score ?? '?'}`,
      `  to: ${escapeHtml(contact?.email || '?')} (${contact?.role_type || '?'})`,
      `  ${escapeHtml((d.subject || '').slice(0, 60))}`,
      '',
    );
  }
  lines.push('Use /show &lt;id&gt;, /preview &lt;id&gt;, /approve &lt;id&gt;, /reject &lt;id&gt; &lt;reason&gt;.');
  return lines.join('\n');
}

export function handleShow(id) {
  const d = draftById(Number(id));
  if (!d) return `Draft ${id} not found.`;
  const contact = contactById(d.contact_id);
  const company = contact ? companyById(contact.company_id) : null;
  const job = d.job_id ? jobById(d.job_id) : null;

  return [
    `<b>Draft #${d.id}</b>  status=${d.status}  hook_verified=${d.hook_verified ? 'yes' : 'NO'}`,
    `<b>Company:</b> ${escapeHtml(company?.name || '?')}  (score ${company?.score ?? '?'})`,
    `<b>Contact:</b> ${escapeHtml(contact?.full_name || 'unknown')} &lt;${escapeHtml(contact?.email || '?')}&gt;`,
    `<b>Role:</b> ${escapeHtml(contact?.role_type || '?')}  <b>Title:</b> ${escapeHtml(contact?.title || '?')}`,
    job ? `<b>Job:</b> ${escapeHtml(job.title || '?')}\n<b>URL:</b> ${escapeHtml(job.url || '?')}` : '',
    '',
    `<b>Subject:</b> ${escapeHtml(d.subject)}`,
    '',
    escapeHtml(d.body),
    '',
    d.hook_evidence ? `<i>Hook: "${escapeHtml(d.hook_evidence)}"</i>` : '',
  ].filter(Boolean).join('\n');
}

/* ── preview: send test copy to owner ─────────────────────── */

export async function handlePreview(id) {
  const d = draftById(Number(id));
  if (!d) return `Draft ${id} not found.`;
  const config = loadConfig();
  const from = config.send.sender_email;
  const fromName = config.send.sender_name;
  const previewTo = config.send.reply_to || from;

  try {
    const r = await sendMessage({
      from, fromName, to: previewTo,
      subject: `[PREVIEW #${d.id}] ${d.subject}`,
      body: [
        '─── This is a preview only. Not sent to the real recipient. ───',
        '',
        d.body,
        '',
        '─── End of draft. Original recipient info below. ───',
        `Recipient: ${(contactById(d.contact_id) || {}).email || '?'}`,
        `Draft id: ${d.id}`,
      ].join('\n'),
    });
    return `Preview sent to <code>${escapeHtml(previewTo)}</code>. Message-Id ${escapeHtml(r.messageId || '?')}.`;
  } catch (err) {
    return `Preview failed: ${escapeHtml(err.message)}`;
  }
}

/* ── write commands ───────────────────────────────────────── */

export function handleApprove(id) {
  const d = draftById(Number(id));
  if (!d) return `Draft ${id} not found.`;
  if (d.status !== 'pending_review') return `Draft ${id} is <b>${d.status}</b>, not pending_review.`;
  updateDraftStatus(d.id, 'approved');
  return `Draft ${d.id} approved. Use /send to fire it now, or leave it for the next auto-send cron.`;
}

export function handleReject(id, reason) {
  const d = draftById(Number(id));
  if (!d) return `Draft ${id} not found.`;
  updateDraftStatus(d.id, 'rejected', { reason: reason || 'via telegram' });
  return `Draft ${d.id} rejected: ${escapeHtml(reason || 'no reason given')}`;
}

export function handleMarkReplied(id) {
  const draftId = Number(id);
  const d = draftById(draftId);
  if (!d) return `Draft ${id} not found.`;
  const db = getDb();
  const initial = db.prepare(`
    SELECT * FROM message WHERE draft_id = ? AND kind = 'initial' AND direction = 'outbound'
    ORDER BY id ASC LIMIT 1
  `).get(draftId);
  if (!initial) return `Draft ${id} has no sent initial message yet.`;
  db.prepare(`UPDATE message SET replied_at = datetime('now'), reply_sentiment = 'manual' WHERE id = ?`).run(initial.id);
  recordEvent({ entity: 'message', entityId: initial.id, event: 'replied', detail: { sentiment: 'manual' } });
  return `Draft ${id} marked as replied. Follow-ups will be skipped.`;
}

/* ── send + status ────────────────────────────────────────── */

export async function handleSend() {
  const config = loadConfig();
  try {
    const stats = await runSend({ config });
    return [
      '<b>Send pass</b>',
      `initial: ${stats.initialSent}`,
      `followup1: ${stats.followup1Sent}`,
      `followup2: ${stats.followup2Sent}`,
      `blocked (approval/suppressed/cap): ${stats.blockedApproval}/${stats.blockedSuppressed}/${stats.blockedCap}`,
      stats.paused ? '<b>PAUSED</b> by bounce alarm.' : '',
    ].filter(Boolean).join('\n');
  } catch (err) {
    return `Send failed: ${escapeHtml(err.message)}`;
  }
}

export async function handleStatus() {
  const config = loadConfig();
  const s = await runReport({ config });
  const t = s.totals;
  return [
    '<b>Pipeline funnel</b>',
    `companies: ${t.companies_total} (${t.companies_qualified} qualified)`,
    `jobs: ${t.jobs_total} (${t.jobs_qualified} qualified)`,
    `contacts: ${t.contacts_total} (${t.contacts_verified} verified)`,
    `drafts: pending=${t.drafts_pending} approved=${t.drafts_approved} sent=${t.drafts_sent}`,
    `messages: out=${t.messages_out_initial} followups=${t.messages_out_followup} replies=${t.messages_replied} bounced=${t.messages_bounced}`,
    `discover -> qualified: ${s.funnel.discovered_to_qualified_pct}%`,
    `sent -> reply: ${s.funnel.sent_to_reply_pct}%`,
    `bounce rate: ${s.funnel.bounce_rate_pct}%`,
  ].join('\n');
}

export function handleHelp() {
  return [
    '<b>Job outreach bot</b>',
    '',
    '/list — pending and approved drafts',
    '/show &lt;id&gt; — full draft (subject + body + hook)',
    '/preview &lt;id&gt; — send preview to your own Gmail',
    '/approve &lt;id&gt; — approve a pending draft',
    '/reject &lt;id&gt; [reason] — reject a pending draft',
    '/replied &lt;id&gt; — manually cancel remaining follow-ups',
    '/send — send all approved drafts now',
    '/status — pipeline funnel snapshot',
    '/whoami — show your Telegram chat id (for env config)',
  ].join('\n');
}
