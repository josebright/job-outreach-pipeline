// bot/handlers.js
// Business logic for each Telegram command. Kept separate from the Telegraf
// wiring so it is unit-testable.
import {
  draftsByStatus, draftById, contactById, companyById, jobById,
  contactsByCompany, jobsByCompany, existingDraftFor,
  updateDraftStatus, createDraft,
  companyBySlug, setCompanySizeManual, setContactEmailStatus,
  suppressCompany, unsuppressCompany, isCompanySuppressed, listSuppressedCompanies,
  setDraftDeliverabilityOverride, setJobQualifyResult,
  setDraftRedraftBlocked, addRejectionRule, listRejectionRules, rejectionRuleById,
  deleteRejectionRule, addressBlockRules, usableContacts, openDraftsForContact,
} from '../db/repo.js';
import { getDb } from '../db/connection.js';
import { recordEvent } from '../db/event-log.js';
import { sendMessage } from '../send/gmail.js';
import { pauseState, clearPause, bounceRate } from '../send/reply-detect.js';
import { isAtsEmail } from '../util/ats-domains.js';
import { isValidEmail, isCareersSubdomainEmail } from '../util/email-domain.js';
import { classifyRejectReason, isAddressBlocked, describeFamily } from '../draft/rejection-rules.js';
import { runReport } from '../report/index.js';
import { runPipeline, runSendPass } from '../run.js';
import { summarizeIssues, recentIssues } from '../util/issues.js';
import { usage } from '../enrich/cost-guard.js';
import { loadProfile } from '../draft/profile.js';
import { generateDraft } from '../draft/llm.js';
import { verifyHookEvidence } from '../draft/hook-verify.js';
import { loadConfig } from '../config/loader.js';
import { escapeHtml } from './telegram.js';
import { addCompanyFromInput } from './addcompany.js';
import { logger } from '../util/logger.js';

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
    const emailBadge = contact?.email_status ? ` [${escapeHtml(contact.email_status)}]` : '';
    lines.push(
      `#${d.id} ${stateMark}${flag}`,
      `  ${escapeHtml((company?.name || '?').slice(0, 30))} score=${company?.score ?? '?'}`,
      `  to: ${escapeHtml(contact?.email || '?')}${emailBadge} (${contact?.role_type || '?'})`,
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
    `<b>Draft #${d.id}</b>  status=${d.status}  hook_verified=${d.hook_verified ? 'yes' : 'NO'}${d.deliverability_override ? '  <b>deliverability_override=yes</b>' : ''}`,
    // Word count is surfaced because the model does not reliably self-enforce
    // the prompt's 90-120 bound; seeing it is how drift gets caught early.
    `<b>Length:</b> ${String(d.body || '').split(/\s+/).filter(Boolean).length} words${d.variant ? `  <b>Variant:</b> ${escapeHtml(d.variant)}` : ''}`,
    `<b>Company:</b> ${escapeHtml(company?.name || '?')}  (score ${company?.score ?? '?'})`,
    `<b>Contact:</b> ${escapeHtml(contact?.full_name || 'unknown')} &lt;${escapeHtml(contact?.email || '?')}&gt;`,
    `<b>Email status:</b> ${escapeHtml(contact?.email_status || 'unknown')}`,
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
        '--- This is a preview only. Not sent to the real recipient. ---',
        '',
        d.body,
        '',
        '--- End of draft. Original recipient info below. ---',
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
  // Manual /approve = informed consent. The applicant already saw the
  // [risky]/[verified] badge in /list before typing this command, so we
  // treat approval as an override of the min_email_status_for_auto_send
  // gate for this specific draft. Auto-cron approvals (none exist today)
  // would leave this bit at 0 and still respect the gate.
  setDraftDeliverabilityOverride(d.id, true);
  const contact = contactById(d.contact_id);
  const badge = contact?.email_status === 'verified' ? '' :
    `\n<i>Recipient is <b>${escapeHtml(contact?.email_status || 'unknown')}</b> — your approval overrides the deliverability gate. Bounces will auto-suppress the contact.</i>`;
  return `Draft ${d.id} approved. Use /send to fire it now, or leave it for the next auto-send cron.${badge}`;
}

/**
 * Reject a draft and make the decision stick.
 *
 * Rejecting used to have no durable effect unless the reason matched a narrow
 * company-suppression regex. "has founders in the email" matched nothing, so
 * the next /run regenerated the same draft to the same address for the same
 * role (#124 came back as #126, #125 as #127).
 *
 * Now, always: this exact contact + role is never auto-drafted again. Then the
 * reason is classified (draft/rejection-rules.js) and turned into a lasting
 * rule - suppress the company, block the role, or block the address pattern -
 * and every effect is spelled out in the reply so a misread is visible at once
 * and /forget can undo it.
 */
export function handleReject(id, reason) {
  const d = draftById(Number(id));
  if (!d) return `Draft ${id} not found.`;
  if (d.status === 'sent') return `Draft ${id} was already sent - there is nothing to reject.`;

  const why = String(reason || '').trim();
  updateDraftStatus(d.id, 'rejected', { reason: why || 'via telegram' });
  setDraftRedraftBlocked(d.id, true);

  const contact = contactById(d.contact_id);
  const company = contact ? companyById(contact.company_id) : null;
  const job = d.job_id ? jobById(d.job_id) : null;
  const verdict = classifyRejectReason(why, { email: contact?.email });

  const out = [`Draft ${d.id} rejected: ${escapeHtml(why || 'no reason given')}`];

  if (verdict.company && company) {
    if (!isCompanySuppressed(company.id)) suppressCompany(company.id, `auto-suppressed on /reject: ${why}`);
    addRejectionRule({ kind: 'company', value: company.id, reason: why, sourceDraftId: d.id });
    const others = rejectOtherOpenDrafts(
      od => contactById(od.contact_id)?.company_id === company.id,
      `company suppressed on /reject #${d.id}`, d.id);
    out.push(`<b>Auto-suppressed ${escapeHtml(company.name)}</b> — future /run cycles will skip it.`);
    if (others.length) out.push(`  Also rejected its other open draft(s): ${others.map(i => `#${i}`).join(', ')}`);
  }

  if (verdict.job && job) {
    setJobQualifyResult(job.id, {
      status: 'disqualified', score: 0, disqualifyReason: `rejected: ${why}`.slice(0, 200),
    });
    addRejectionRule({ kind: 'job', value: job.id, reason: why, sourceDraftId: d.id });
    const others = rejectOtherOpenDrafts(od => od.job_id === job.id, `role blocked on /reject #${d.id}`, d.id);
    out.push(`<b>Role blocked:</b> ${escapeHtml(job.title || '?')} at ${escapeHtml(company?.name || '?')} will not be drafted again.`);
    if (others.length) out.push(`  Also rejected other open draft(s) for it: ${others.map(i => `#${i}`).join(', ')}`);
  }

  if (verdict.aliasFamilies.length || verdict.allRoleAliases) {
    for (const fam of verdict.aliasFamilies) {
      addRejectionRule({ kind: 'local_part', value: fam, reason: why, sourceDraftId: d.id });
    }
    if (verdict.allRoleAliases) {
      addRejectionRule({ kind: 'all_role_aliases', value: '*', reason: why, sourceDraftId: d.id });
    }
    const applied = applyAddressRules(d.id);
    const what = verdict.allRoleAliases
      ? 'any shared inbox (founders@, hello@, team@, careers@ ...) - named people only'
      : `${verdict.aliasFamilies.map(describeFamily).join(', ')} addresses`;
    out.push(`<b>Learned:</b> never use ${escapeHtml(what)}.`);
    out.push(`  ${applied.contacts} matching contact(s) invalidated across all companies`);
    if (applied.drafts.length) {
      out.push(`  ${applied.drafts.length} other open draft(s) rejected: ${applied.drafts.map(i => `#${i}`).join(', ')}`);
    }
    out.push('  enrichment stops probing for them and drafting skips them');
  } else if (verdict.contact && contact) {
    setContactEmailStatus(contact.id, 'invalid');
    out.push(`<b>Contact dropped:</b> ${escapeHtml(contact.email)} will not be used again.`);
  }

  if (verdict.wording) {
    out.push(`Read as a wording issue, so nothing beyond this draft changed. /replace ${d.id} gets a rewrite for the same person and role.`);
  }
  if (!verdict.recognized) {
    out.push('I could not tell what was wrong, so only this exact contact + role is blocked. ' +
      'If the problem is the company, the role or the address, say so next time - e.g. "too big", "wrong role", "generic email".');
  }

  out.push('', 'This exact contact + role will not be drafted again.');
  if (company && verdict.contact && !verdict.company && !verdict.job) {
    out.push(`${escapeHtml(company.name)} can still be drafted to a different, allowed contact if one is found.`);
  }
  if (verdict.aliasFamilies.length && !verdict.allRoleAliases) {
    out.push('Other shared inboxes (hello@, team@, careers@) are still allowed - reject with "generic email" to block all of them.');
  }
  out.push('/rules lists what has been learned; /forget &lt;n&gt; undoes one.');
  return out.join('\n');
}

function rejectOtherOpenDrafts(predicate, reason, exceptId) {
  const ids = [];
  for (const od of draftsByStatus('pending_review').concat(draftsByStatus('approved'))) {
    if (od.id === exceptId || !predicate(od)) continue;
    updateDraftStatus(od.id, 'rejected', { reason: `auto: ${reason}` });
    ids.push(od.id);
  }
  return ids;
}

// A new rule must reach contacts created before it, or /list keeps showing the
// very addresses the applicant just rejected.
function applyAddressRules(sourceDraftId = null) {
  const rules = addressBlockRules();
  let contacts = 0;
  const drafts = [];
  for (const c of usableContacts()) {
    if (!isAddressBlocked(c.email, rules)) continue;
    setContactEmailStatus(c.id, 'invalid');
    contacts++;
    for (const od of openDraftsForContact(c.id)) {
      if (od.id === sourceDraftId) continue;
      updateDraftStatus(od.id, 'rejected', { reason: `auto: ${c.email} blocked by a learned rule` });
      drafts.push(od.id);
    }
  }
  return { contacts, drafts };
}

// Contacts a draft may actually be addressed to: not invalid, not blocked by a
// learned rule, not on a careers subdomain.
function sendableContactsFor(companyId) {
  const rules = addressBlockRules();
  return contactsByCompany(companyId).filter(c =>
    c.email_status !== 'invalid'
    && !isAddressBlocked(c.email, rules)
    && !isCareersSubdomainEmail(c.email));
}

function describeRule(r) {
  switch (r.kind) {
    case 'local_part':
      return `never use ${describeFamily(r.value)} addresses`;
    case 'all_role_aliases':
      return 'never use a shared inbox (founders@, hello@, careers@ ...) - named people only';
    case 'company':
      return `company suppressed: ${companyById(Number(r.value))?.name || `#${r.value}`}`;
    case 'job': {
      const j = jobById(Number(r.value));
      return `role blocked: ${j?.title || `job #${r.value}`}${j ? ` at ${companyById(j.company_id)?.name || '?'}` : ''}`;
    }
    default:
      return `${r.kind}: ${r.value}`;
  }
}

/* ── /rules + /forget: what rejections have taught the pipeline ── */

export function handleRules() {
  const rules = listRejectionRules();
  if (rules.length === 0) return 'Nothing learned from rejections yet.';
  const lines = ['<b>Learned from your rejections</b>', ''];
  for (const r of rules) {
    lines.push(`${r.id}. ${escapeHtml(describeRule(r))}`);
    if (r.reason) lines.push(`   <i>"${escapeHtml(r.reason.slice(0, 80))}"</i>`);
  }
  lines.push('', 'Use /forget &lt;n&gt; to undo one.');
  return lines.join('\n');
}

export function handleForget(id) {
  const rule = rejectionRuleById(Number(id));
  if (!rule) return `No rule #${escapeHtml(String(id || ''))}. Use /rules to see them.`;
  const desc = describeRule(rule);
  deleteRejectionRule(rule.id);
  let note;
  if (rule.kind === 'company') {
    unsuppressCompany(Number(rule.value));
    note = 'The company is unsuppressed and can qualify again on the next /run.';
  } else if (rule.kind === 'job') {
    setJobQualifyResult(Number(rule.value), { status: 'ingested', score: 0, disqualifyReason: null });
    note = 'The role will be re-evaluated on the next /run.';
  } else {
    note = 'Future enrichment and drafts may use those addresses again. Contacts already invalidated stay invalid.';
  }
  return `Forgot rule #${rule.id} (${escapeHtml(desc)}). ${note}`;
}

/* ── /suppress + /unblock + /suppressed: company blocklist ── */

export function handleSuppress(slug, reason) {
  if (!slug) return 'Usage: /suppress &lt;slug&gt; [reason]';
  const c = companyBySlug(slug);
  if (!c) return `No company with slug "${escapeHtml(slug)}".`;
  if (isCompanySuppressed(c.id)) return `${escapeHtml(c.name)} is already suppressed.`;
  suppressCompany(c.id, reason || 'via /suppress');
  return `Suppressed <b>${escapeHtml(c.name)}</b> (${escapeHtml(c.slug)}). No future drafts will be generated for this company.`;
}

export function handleUnblock(slug) {
  if (!slug) return 'Usage: /unblock &lt;slug&gt;';
  const c = companyBySlug(slug);
  if (!c) return `No company with slug "${escapeHtml(slug)}".`;
  if (!isCompanySuppressed(c.id)) return `${escapeHtml(c.name)} is not suppressed.`;
  unsuppressCompany(c.id);
  return `Unblocked <b>${escapeHtml(c.name)}</b>. It can produce drafts again.`;
}

export function handleSuppressed() {
  const rows = listSuppressedCompanies();
  if (rows.length === 0) return 'No suppressed companies.';
  const lines = ['<b>Suppressed companies</b>', ''];
  for (const r of rows) {
    lines.push(`  ${escapeHtml(r.name)} (${escapeHtml(r.slug)}) — ${escapeHtml(r.reason || 'no reason')}`);
  }
  return lines.join('\n');
}

/**
 * Bulk-reject every pending_review + approved draft. Destructive; the
 * reason argument is required so this can't fire from a typo. Sent
 * drafts are never touched (already outbound).
 */
export function handleRejectAll(reason) {
  const trimmed = (reason || '').trim();
  if (!trimmed) {
    return 'Usage: /rejectall &lt;reason&gt;\n' +
           'Reason is required to prevent accidental bulk-rejects.';
  }
  const pending  = draftsByStatus('pending_review');
  const approved = draftsByStatus('approved');
  const all = [...pending, ...approved];
  if (all.length === 0) return 'No pending or approved drafts to reject.';

  for (const d of all) {
    updateDraftStatus(d.id, 'rejected', { reason: `bulk: ${trimmed}` });
  }
  return `Rejected ${all.length} draft(s) (${pending.length} pending, ${approved.length} approved). Reason: ${escapeHtml(trimmed)}`;
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

function busyMessage(what, info) {
  return `A ${what} is already in progress (started by ${escapeHtml(info?.holder || '?')}, ` +
    `${info?.sinceSec ?? '?'}s ago). Not starting a second one - overlapping runs draft the same ` +
    'company twice and overlapping send passes can deliver the same email twice.';
}

export async function handleSend() {
  const out = await runSendPass({ origin: 'telegram:/send' });
  if (out.busy) return busyMessage('send pass', out.info);
  const issues = summarizeIssues(out.run?.issues);
  if (out.error || out.stats?.failed) {
    return [`<b>Send failed:</b> ${escapeHtml(out.error?.message || out.stats?.error || 'unknown error')}`,
      '', ...issues].join('\n');
  }
  const stats = out.stats;
  const config = loadConfig();
  const lines = ['<b>Send pass</b>', `initial: ${stats.initialSent}`];
  // Follow-ups are disabled (send.followups_enabled). Printing "followup1: 0"
  // every time made it look like they were still part of the pipeline.
  if (config.send?.followups_enabled) {
    lines.push(`followup1: ${stats.followup1Sent}`, `followup2: ${stats.followup2Sent}`);
  }
  lines.push(
    `blocked (approval/suppressed/cap/unverified/ats-domain/invalid-email): ${stats.blockedApproval}/${stats.blockedSuppressed}/${stats.blockedCap}/${stats.blockedUnverified}/${stats.blockedAtsDomain}/${stats.blockedInvalidEmail || 0}`,
  );
  if (stats.paused) lines.push(pausedExplanation());
  if (stats.atsDraftsQuarantined > 0) {
    lines.push(`<i>${stats.atsDraftsQuarantined} draft(s) had an address that can never receive mail; they were rejected and the contact marked invalid so the next /run looks for a real one.</i>`);
  }
  if (issues.length) lines.push('', ...issues);
  return lines.join('\n');
}

/* ── /cleanup: purge unsendable and superseded drafts ─────── */

/**
 * Sweep the open queue for drafts that should never be sent. Everything here
 * was generated BEFORE the corresponding fix landed, so the fixes alone do not
 * clear it - these rows just sit in /list waiting to be approved by mistake.
 *
 * Four categories, in order of severity:
 *   1. Unsendable recipient - an invalid address (founders@&, produced when a
 *      junk company website parsed as a hostname) or an ATS/job-board domain
 *      (founders@api.smartrecruiters.com). Guaranteed bounces. The contact is
 *      marked invalid too, so enrich looks for a real address next run.
 *   2. Superseded prompt - drafts written by an earlier prompt version. The
 *      retired outreach_v2 variants opened with "Is the {role} hire for ...?",
 *      which reads as a consultant qualifying an opportunity rather than a
 *      candidate applying.
 *   3. Duplicates - more than one open draft for the same company. Keeps the
 *      newest (it used the current prompt) and rejects the rest.
 * Nothing already sent is touched.
 */
export function handleCleanup() {
  const config = loadConfig();
  const current = config.llm?.prompt_version;
  const open = draftsByStatus('pending_review').concat(draftsByStatus('approved'));
  if (open.length === 0) return 'Nothing to clean - no open drafts.';
  const addressRules = addressBlockRules();

  const killed = { unsendable: [], superseded: [], duplicate: [] };
  const survivors = [];

  for (const d of open) {
    const contact = contactById(d.contact_id);
    const email = contact?.email || '';
    const label = `#${d.id} ${(companyById(contact?.company_id)?.name || '?').slice(0, 22)}`;

    if (!contact || !isValidEmail(email) || isAtsEmail(email)
        || isCareersSubdomainEmail(email) || isAddressBlocked(email, addressRules)) {
      updateDraftStatus(d.id, 'rejected', { reason: `cleanup: unsendable recipient ${email || '(none)'}` });
      if (contact) setContactEmailStatus(contact.id, 'invalid');
      killed.unsendable.push(`${label} -> ${email || '(no contact)'}`);
      continue;
    }
    if (current && d.prompt_version && d.prompt_version !== current) {
      updateDraftStatus(d.id, 'rejected', { reason: `cleanup: superseded prompt ${d.prompt_version}` });
      killed.superseded.push(`${label} (${d.prompt_version})`);
      continue;
    }
    survivors.push({ draft: d, companyId: contact.company_id, label });
  }

  // Collapse duplicates: newest open draft per company wins.
  const byCompany = new Map();
  for (const s of survivors) {
    const prev = byCompany.get(s.companyId);
    if (!prev) { byCompany.set(s.companyId, s); continue; }
    const loser = prev.draft.id < s.draft.id ? prev : s;
    const winner = prev.draft.id < s.draft.id ? s : prev;
    updateDraftStatus(loser.draft.id, 'rejected', { reason: 'cleanup: duplicate draft for this company' });
    killed.duplicate.push(loser.label);
    byCompany.set(s.companyId, winner);
  }

  const total = killed.unsendable.length + killed.superseded.length + killed.duplicate.length;
  if (total === 0) return `Queue is clean - all ${open.length} open draft(s) look sendable and current.`;

  const section = (title, rows) => rows.length === 0 ? [] : [
    '', `<b>${title}</b> (${rows.length})`,
    ...rows.slice(0, 15).map(r => `  ${escapeHtml(r)}`),
    rows.length > 15 ? `  ...and ${rows.length - 15} more` : '',
  ].filter(Boolean);

  return [
    `<b>Cleanup: rejected ${total} of ${open.length} open draft(s)</b>`,
    ...section('Unsendable recipient', killed.unsendable),
    ...section('Superseded prompt', killed.superseded),
    ...section('Duplicate per company', killed.duplicate),
    '', `${byCompany.size} draft(s) left in the queue. Use /list.`,
  ].join('\n');
}

/* ── bounce-alarm pause ───────────────────────────────────── */

function fmtEpoch(e) {
  if (!e) return 'unknown';
  return new Date(e * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function pausedExplanation() {
  const st = pauseState();
  const br = bounceRate();
  return [
    '<b>PAUSED</b> by bounce alarm — nothing was sent.',
    `  bounce rate (7d): ${br.bounces}/${br.total} = ${br.pct.toFixed(1)}%`,
    `  paused since: ${fmtEpoch(st.sinceEpoch)}`,
    `  auto-lifts:   ${fmtEpoch(st.expiresEpoch)}`,
    '  Use /unpause to lift it now.',
  ].join('\n');
}

/**
 * Manually lift the bounce-alarm pause. The alarm re-arms on the next poll
 * if the 7-day window is still unhealthy, so this is a nudge, not an
 * override — it cannot force a send through a genuinely bad bounce rate.
 */
export function handleUnpause() {
  const st = pauseState();
  if (!st.paused && !st.expired) return 'Sending is not paused.';
  const br = bounceRate();
  clearPause('manual_unpause', { bounceRatePct: br.pct });
  const warn = br.total >= 10 && br.pct > 3
    ? `\n<i>Heads up: the 7-day bounce rate is still ${br.pct.toFixed(1)}% (${br.bounces}/${br.total}). The alarm will re-arm on the next poll unless those bounces age out.</i>`
    : '';
  return `Bounce alarm cleared. Sending resumed — use /send to fire the queue.${warn}`;
}

/**
 * Deep-diagnostic snapshot. Reports the current pool composition so we
 * can see WHY /run isn't producing drafts — bad supply, empty pool,
 * budget exhausted, whatever. Read-only; no side effects.
 */
export async function handleDiag() {
  const db = getDb();
  const config = loadConfig();

  // Company totals by status.
  const byStatus = db.prepare(`
    SELECT status, COUNT(*) AS n FROM company GROUP BY status ORDER BY status
  `).all();

  // Qualified companies broken down by size tier.
  const qualified = db.prepare(`
    SELECT COALESCE(size_band, 'unknown') AS band,
           COUNT(*) AS companies,
           SUM(CASE WHEN id IN (SELECT company_id FROM contact) THEN 1 ELSE 0 END) AS with_contacts,
           SUM(CASE WHEN id IN (SELECT company_id FROM job WHERE status = 'qualified') THEN 1 ELSE 0 END) AS with_qual_jobs
    FROM company
    WHERE status = 'qualified'
    GROUP BY band
    ORDER BY companies DESC
  `).all();

  // Contact counts by email_status.
  const contacts = db.prepare(`
    SELECT email_status, COUNT(*) AS n FROM contact GROUP BY email_status
  `).all();

  // Draft-eligible pool: qualified companies WITH a qualified job AND >=1 contact.
  const draftable = db.prepare(`
    SELECT COUNT(DISTINCT co.id) AS n
    FROM company co
    JOIN job j     ON j.company_id  = co.id AND j.status = 'qualified'
    JOIN contact c ON c.company_id  = co.id AND c.email_status != 'invalid'
    WHERE co.status = 'qualified'
  `).get()?.n || 0;

  // Draft status breakdown.
  const drafts = db.prepare(`
    SELECT status, COUNT(*) AS n FROM draft GROUP BY status
  `).all();

  // Gate kill breakdown: top disqualify reasons across all jobs, ranked by
  // frequency. This is the single most useful thing for understanding why the
  // qualification rate is low — it shows which gate is doing most of the killing.
  const gateKills = db.prepare(`
    SELECT
      COALESCE(disqualify_reason, 'qualified') AS reason,
      COUNT(*) AS n
    FROM job
    WHERE status IN ('disqualified', 'needs_review', 'qualified')
    GROUP BY reason
    ORDER BY n DESC
    LIMIT 12
  `).all();

  // Draft stall: qualified companies that have contacts but no pending/approved
  // draft. These are "stuck" — they have everything needed for a draft but
  // nothing is being generated. Common causes: existing sent/rejected draft
  // (pipeline skips re-draft), hook-verify fail, or LLM budget.
  const stalled = db.prepare(`
    SELECT co.name, co.slug,
      (SELECT status FROM draft d JOIN contact c ON c.id = d.contact_id
       WHERE c.company_id = co.id ORDER BY d.id DESC LIMIT 1) AS last_draft_status,
      (SELECT COUNT(*) FROM contact c WHERE c.company_id = co.id AND c.email_status != 'invalid') AS usable_contacts
    FROM company co
    WHERE co.status = 'qualified'
      AND EXISTS (
        SELECT 1 FROM contact c WHERE c.company_id = co.id AND c.email_status != 'invalid'
      )
      AND NOT EXISTS (
        SELECT 1 FROM draft d JOIN contact c ON c.id = d.contact_id
        WHERE c.company_id = co.id AND d.status IN ('pending_review', 'approved')
      )
  `).all();

  // 14-day funnel: uses event_log timestamps to show per-stage kill rates.
  // Each row answers: how many units moved through this stage in the last 14 days?
  // "discovered" is companies first inserted; "qualified" is companies that passed
  // all ICP gates; "contacted" is unique companies that got ≥1 non-invalid email;
  // "drafted" is new draft_created events; "sent" is new sent events.
  const f14 = {
    discovered: db.prepare(`
      SELECT COUNT(*) AS n FROM event_log
      WHERE entity = 'company' AND event = 'discovered'
        AND at >= datetime('now', '-14 days')
    `).get().n,
    qualified: db.prepare(`
      SELECT COUNT(*) AS n FROM event_log
      WHERE entity = 'company' AND event = 'qualified'
        AND at >= datetime('now', '-14 days')
    `).get().n,
    contacted: db.prepare(`
      SELECT COUNT(DISTINCT ct.company_id) AS n
      FROM event_log e
      JOIN contact ct ON ct.id = e.entity_id
      WHERE e.entity = 'contact' AND e.event = 'created'
        AND e.at >= datetime('now', '-14 days')
        AND ct.email_status != 'invalid'
    `).get().n,
    drafted: db.prepare(`
      SELECT COUNT(*) AS n FROM event_log
      WHERE entity = 'draft' AND event = 'draft_created'
        AND at >= datetime('now', '-14 days')
    `).get().n,
    sent: db.prepare(`
      SELECT COUNT(*) AS n FROM event_log
      WHERE entity = 'draft' AND event = 'sent'
        AND at >= datetime('now', '-14 days')
    `).get().n,
  };

  function pct(num, den) {
    if (!den) return '—';
    return ((num / den) * 100).toFixed(0) + '%';
  }

  // Per-variant telemetry. Segments sends/replies by the prompt variant
  // (V1_ROLE_FIT / V2_EVIDENCE / V3_DIRECT) that produced each draft.
  // Only meaningful once N >= ~50 per variant — reply-rate below that
  // is dominated by noise. Reply-rate column shown even at small N for
  // observability, but do NOT tune subjects based on it until sample
  // size crosses the noise floor.
  const variantStats = db.prepare(`
    SELECT
      COALESCE(d.variant, 'unknown') AS variant,
      COUNT(DISTINCT d.id) AS drafts_created,
      COUNT(DISTINCT m.id) AS sent,
      COUNT(DISTINCT CASE WHEN m.replied_at IS NOT NULL THEN m.id END) AS replied
    FROM draft d
    LEFT JOIN message m ON m.draft_id = d.id AND m.direction = 'outbound' AND m.kind = 'initial'
    GROUP BY variant
    ORDER BY drafts_created DESC
  `).all();

  // Budgets this month.
  const hunterBudget = usage('hunter',   config.enrichment?.monthly_budget ?? 2000);
  const anthroBudget = usage('anthropic', config.llm?.monthly_budget ?? 500);

  const lines = [
    '<b>Pipeline diagnostic</b>',
    '',
    '<b>Companies by status</b>',
    ...byStatus.map(r => `  ${r.status.padEnd(14)} ${r.n}`),
    '',
    '<b>Qualified companies by size band</b> (contacts / qual-jobs / total)',
    ...qualified.map(r => `  ${String(r.band).padEnd(12)} ${r.with_contacts} / ${r.with_qual_jobs} / ${r.companies}`),
    '',
    `<b>Draft-eligible pool</b> (qualified + qual-job + contact): <b>${draftable}</b>`,
    '',
    '<b>Contacts by email status</b>',
    ...contacts.map(r => `  ${String(r.email_status || 'null').padEnd(10)} ${r.n}`),
    '',
    '<b>Drafts by status</b>',
    ...drafts.map(r => `  ${r.status.padEnd(14)} ${r.n}`),
    '',
    '<b>Gate kill breakdown</b> (top disqualify reasons)',
    ...gateKills.map(r => `  ${String(r.n).padStart(4)}  ${escapeHtml(r.reason)}`),
    '',
    '<b>Draft-stalled companies</b> (qualified + contacts, no pending draft)',
    stalled.length === 0
      ? '  none — all eligible companies have a pending or approved draft'
      : stalled.map(r =>
          `  ${escapeHtml(r.slug)}  contacts=${r.usable_contacts}  last=${escapeHtml(r.last_draft_status || 'never')}`
        ).join('\n'),
    '',
    '<b>14-day pipeline funnel</b>',
    `  discovered  ${f14.discovered}`,
    `  qualified   ${f14.qualified}  (${pct(f14.qualified, f14.discovered)} of discovered)`,
    `  contacted   ${f14.contacted}  (${pct(f14.contacted, f14.qualified)} of qualified)`,
    `  drafted     ${f14.drafted}  (${pct(f14.drafted, f14.contacted)} of contacted)`,
    `  sent        ${f14.sent}  (${pct(f14.sent, f14.drafted)} of drafted)`,
    f14.discovered === 0 ? '  ⚠ No new companies in 14 days — run /run to discover' : '',
    f14.qualified === 0 && f14.discovered > 0 ? '  ⚠ All new companies failed ICP gates — check gate3/gate4' : '',
    f14.contacted === 0 && f14.qualified > 0 ? '  ⚠ Qualified companies got no usable contacts — enrich budget or accept_all' : '',
    f14.drafted === 0 && f14.contacted > 0 ? '  ⚠ Contacts found but no drafts — check LLM budget or hook-verify' : '',
    '',
    '<b>Prompt variants</b> (drafts / sent / replied / reply-rate)',
    ...variantStats.map(r => {
      const rate = r.sent > 0 ? ((r.replied / r.sent) * 100).toFixed(1) + '%' : '—';
      const flag = r.sent < 50 ? ' [small-N]' : '';
      return `  ${String(r.variant).padEnd(16)} ${r.drafts_created} / ${r.sent} / ${r.replied} / ${rate}${flag}`;
    }),
    '',
    '<b>Send status</b>',
    ...(function () {
      const st = pauseState();
      const br = bounceRate();
      const rate = br.total > 0 ? `${br.bounces}/${br.total} = ${br.pct.toFixed(1)}%` : 'no sends in window';
      const out = [`  bounce rate (7d): ${rate}`];
      if (st.paused) {
        out.push(`  <b>PAUSED</b> since ${fmtEpoch(st.sinceEpoch)} — auto-lifts ${fmtEpoch(st.expiresEpoch)}`);
        out.push('  Use /unpause to lift it now.');
      } else {
        out.push('  sending active (not paused)');
      }
      return out;
    })(),
    '',
    '<b>Budgets this month</b>',
    `  hunter:    ${hunterBudget.units}/${hunterBudget.budget} used (${hunterBudget.remaining} left)`,
    `  anthropic: ${anthroBudget.units}/${anthroBudget.budget} used (${anthroBudget.remaining} left)`,
  ];
  return lines.join('\n');
}

export async function handleStatus() {
  const config = loadConfig();
  const s = await runReport({ config });
  const t = s.totals;
  const lines = [
    '<b>Pipeline funnel</b>',
    `companies: ${t.companies_total} (${t.companies_qualified} qualified)`,
    `jobs: ${t.jobs_total} (${t.jobs_qualified} qualified)`,
    `contacts: ${t.contacts_total} (${t.contacts_verified} verified)`,
    `drafts: pending=${t.drafts_pending} approved=${t.drafts_approved} sent=${t.drafts_sent}`,
    `messages: out=${t.messages_out_initial} replies=${t.messages_replied} bounced=${t.messages_bounced}`,
  ];
  if (!config.send?.followups_enabled && t.messages_out_followup > 0) {
    lines.push(`follow-ups: disabled (${t.messages_out_followup} were sent before they were turned off)`);
  }
  lines.push(
    `discover -> qualified: ${s.funnel.discovered_to_qualified_pct}%`,
    `sent -> reply: ${s.funnel.sent_to_reply_pct}%`,
    `bounce rate: ${s.funnel.bounce_rate_pct}%`,
  );
  return lines.join('\n');
}

/**
 * Every warning and error the pipeline recorded, including from cron runs
 * nobody was watching. /issues 72 widens the window to 72 hours.
 */
export function handleIssues(arg) {
  const hours = Math.min(Math.max(Number(arg) || 24, 1), 24 * 14);
  const rows = recentIssues({ hours });
  if (rows.length === 0) return `No warnings or errors recorded in the last ${hours}h.`;
  return summarizeIssues(rows, { limit: 30, title: `Pipeline issues, last ${hours}h` }).join('\n');
}

export function handleHelp() {
  return [
    '<b>Job outreach bot</b>',
    '',
    '/list — pending and approved drafts',
    '/show &lt;id&gt; — full draft (subject + body + hook)',
    '/preview &lt;id&gt; — send preview to your own Gmail',
    '/approve &lt;id&gt; — approve a pending draft',
    '/reject &lt;id&gt; &lt;reason&gt; — reject; the reason becomes a lasting rule',
    '/rejectall &lt;reason&gt; — bulk-reject every pending + approved draft',
    '/replace &lt;id&gt; [reason] — reject + regenerate a fresh draft',
    '/replied &lt;id&gt; — mark a sent email as replied',
    '/send — send all approved drafts now',
    '/run — fire the full pipeline (discover → ingest → qualify → enrich → draft)',
    '/draft &lt;company-slug&gt; — force-draft against a company by slug',
    '/addcompany &lt;linkedin-url | ats-url | name slug ats&gt; — add a company manually',
    '/setsize &lt;slug&gt; &lt;band&gt; — manual size override (e.g. /setsize affirm 1000+)',
    '/suppress &lt;slug&gt; [reason] — permanently blocklist a company',
    '/unblock &lt;slug&gt; — remove a company from the blocklist',
    '/suppressed — list all suppressed companies',
    '/unpause — lift the bounce-alarm send pause',
    '/cleanup — reject unsendable, superseded and duplicate drafts',
    '/rules — what your rejections have taught the pipeline',
    '/forget &lt;n&gt; — undo a learned rule',
    '/status — pipeline funnel snapshot',
    '/diag — deep pipeline diagnostic (pool composition, budgets)',
    '/issues [hours] — every warning and error the pipeline hit (default 24h)',
    '/whoami — show your Telegram chat id (for env config)',
  ].join('\n');
}

/* ── /run: fire full pipeline ─────────────────────────────── */

export async function handleRun() {
  const out = await runPipeline({ origin: 'telegram:/run' });
  if (out.busy) return busyMessage('pipeline run', out.info);

  const stats = out.stats || {};
  const lines = [out.error
    ? `<b>Pipeline run aborted:</b> ${escapeHtml(out.error.message)}`
    : '<b>Pipeline run complete</b>'];
  for (const stage of ['discover', 'ingest', 'qualify', 'enrich', 'draft']) {
    const st = stats[stage];
    const pad = ' '.repeat(Math.max(1, 9 - stage.length));
    lines.push(st?.failed
      ? `${stage}:${pad}<b>FAILED</b> - ${escapeHtml(st.error)}`
      : `${stage}:${pad}${escapeHtml(JSON.stringify(st || {}))}`);
  }

  const d = stats.draft || {};
  const drafts = d.draftsCreated || 0;
  if (!d.failed && drafts === 0) {
    const reasons = [];
    if (d.errors > 0)                reasons.push(`${d.errors} draft error(s): ${escapeHtml(d.firstError || 'see /issues')}`);
    if (d.skippedLlmSkip > 0)        reasons.push(`${d.skippedLlmSkip} skipped by LLM (no hook/bridge found)`);
    if (d.skippedNoContact > 0)      reasons.push(`${d.skippedNoContact} companies had no usable contact`);
    if (d.skippedRejectedBefore > 0) reasons.push(`${d.skippedRejectedBefore} contact + role pair(s) you already rejected`);
    if (d.skippedCompanyHasDraft > 0) reasons.push(`${d.skippedCompanyHasDraft} companies already have an open draft`);
    if (d.skippedNoJob > 0)          reasons.push(`${d.skippedNoJob} companies had no qualified job`);
    if (d.skippedBadTitle > 0)       reasons.push(`${d.skippedBadTitle} companies all failed defensive Q1`);
    if (d.skippedTooBig > 0)         reasons.push(`${d.skippedTooBig} companies too large (>500)`);
    if (d.budgetExceeded)            reasons.push('Anthropic monthly budget exhausted');
    if (d.companiesConsidered === 0) reasons.push('no qualified companies in DB yet');
    const why = reasons.length > 0 ? reasons.join('; ') : 'all companies already have live drafts or were skipped';
    lines.push('', `<b>No drafts produced.</b> ${why}. Use /diag for pool details.`);
  } else if (drafts > 0) {
    lines.push('', `Use /list to review the ${drafts} new draft(s).`);
  }

  const issues = summarizeIssues(out.run?.issues);
  lines.push('', ...(issues.length ? issues : ['No warnings or errors this run.']));
  return lines.join('\n');
}

/* ── /replace: reject + regenerate for the same contact+job ─ */

export async function handleReplace(id, reason) {
  const draftId = Number(id);
  const d = draftById(draftId);
  if (!d) return `Draft ${id} not found.`;
  if (d.status === 'sent') return `Draft ${id} was already sent; cannot replace.`;

  const contact = contactById(d.contact_id);
  const job = d.job_id ? jobById(d.job_id) : null;
  if (!contact || !job) return `Draft ${id} missing contact or job — cannot regenerate.`;
  const company = companyById(contact.company_id);
  if (contact.email_status === 'invalid' || isAddressBlocked(contact.email, addressBlockRules())) {
    return `Draft ${id} is addressed to ${escapeHtml(contact.email)}, which is invalid or blocked by a rule. ` +
      'Rewriting it will not help - it needs a different contact. /rules shows what is blocked.';
  }

  // Reject the current draft first so /list stays clean. The "replace:" prefix
  // marks this as a rewrite, not a decision against the contact or role, so it
  // does not block future drafts (migration 009).
  updateDraftStatus(draftId, 'rejected', { reason: `replace: ${reason || 'via telegram'}` });

  const config = loadConfig();
  let profile;
  try { profile = loadProfile(); }
  catch (err) { return `Profile not ready: ${escapeHtml(err.message)}`; }

  try {
    const gen = await generateDraft({
      model: config.llm.drafts_model,
      promptVersion: config.llm.prompt_version,
      profile, company, contact, job,
      track: (job.track || 'A'),
    });
    if (/^SKIP:/i.test(gen.body)) {
      return `Regeneration skipped by LLM (${escapeHtml(gen.body.slice(0, 80))}).`;
    }
    const hookOK = verifyHookEvidence({
      hookEvidence: gen.hookEvidence,
      sourceText: job.description_text || '',
    });
    const created = createDraft({
      contactId: contact.id, jobId: job.id,
      subject: gen.subject, body: gen.body,
      promptVersion: gen.promptVersion,
      hookEvidence: gen.hookEvidence,
      hookVerified: hookOK,
      model: gen.model,
      variant: gen.variant,
    });
    return `Draft ${draftId} rejected. New draft #${created.id} created (hook_verified=${hookOK ? 'yes' : 'NO'}). Use /show ${created.id}.`;
  } catch (err) {
    return `Regeneration failed: ${escapeHtml(err.message)}`;
  }
}

/* ── /draft <slug>: force-draft against a company by slug ── */

/**
 * User-initiated draft against a specific company. Deliberately self-
 * healing — the whole point of the command is to bypass the daily-cron
 * path when the applicant knows a company they want a draft for. So:
 *   • If no usable contact exists → promote to 'qualified' and run
 *     enrich for JUST this company (companies/find + domain-search +
 *     pattern probe). If that still fails, tell them why.
 *   • If no *qualified* job exists → fall back to any 'needs_review' or
 *     'ingested' job for the company. The user is explicitly asking to
 *     draft this company, so we don't second-guess gate 1 here.
 *   • Always report which fallback we took so the applicant knows the
 *     draft is a manual override, not a normal qualified pick.
 */
export async function handleDraftForSlug(slug) {
  if (!slug) return 'Usage: /draft &lt;company-slug&gt;';
  const company = companyBySlug(slug);
  if (!company) return `No company with slug "${escapeHtml(slug)}".`;
  // Suppression is Gate 0 for the auto-cron path (qualify/index.js). The
  // manual /draft slug path must honor it too, or a suppressed company can
  // be resurrected by name — burning Hunter credits, LLM credits, and (if
  // ultimately approved) sender reputation on a domain already known bad.
  if (isCompanySuppressed(company.id)) {
    return `Company <b>${escapeHtml(company.name)}</b> is suppressed. Use /unblock ${escapeHtml(company.slug)} first if you want to draft against it.`;
  }

  const config = loadConfig();

  // Self-heal contacts: if none, promote status to qualified so enrich
  // will process it, then run a scoped enrich for this one company.
  let contacts = sendableContactsFor(company.id);
  let contactNote = '';
  if (contacts.length === 0) {
    if (company.status !== 'qualified') {
      try {
        const { setCompanyStatus } = await import('../db/repo.js');
        setCompanyStatus(company.id, 'qualified', { reason: 'forced by /draft <slug>' });
      } catch (err) {
        logger.warn({ err: err.message, companyId: company.id }, '/draft: could not promote company to qualified');
      }
    }
    try {
      const { runEnrich } = await import('../enrich/index.js');
      const stats = await runEnrich({ config, maxCompanies: 999, onlyForCompanyId: company.id });
      contacts = sendableContactsFor(company.id);
      contactNote = `(auto-enriched: ${stats.contactsCreated} contact(s) created)`;
    } catch (err) {
      return `Auto-enrich failed for ${escapeHtml(company.name)}: ${escapeHtml(err.message)}`;
    }
    if (contacts.length === 0) {
      return `Company ${escapeHtml(company.name)} has no usable contact even after auto-enrich. ` +
             `Hunter has no data on this domain and pattern probing (founders@/hello@/team@) all failed. ` +
             `Nothing to draft against.`;
    }
  }

  // Self-heal jobs: prefer qualified, fall back to needs_review, then ingested.
  const allJobs = jobsByCompany(company.id);
  let jobs = allJobs.filter(j => j.status === 'qualified').sort((a, b) => (b.score || 0) - (a.score || 0));
  let jobNote = '';
  if (jobs.length === 0) {
    jobs = allJobs.filter(j => j.status === 'needs_review');
    if (jobs.length > 0) jobNote = ' (using needs_review job — gate 1 was ambiguous)';
  }
  if (jobs.length === 0) {
    jobs = allJobs.filter(j => j.status === 'ingested');
    if (jobs.length > 0) jobNote = ' (using ingested job — gate not yet run)';
  }
  if (jobs.length === 0) {
    return `Company ${escapeHtml(company.name)} has no jobs at all. Run /run first to ingest their ATS.`;
  }

  const contact = contacts[0];
  const job = jobs[0];
  if (existingDraftFor(contact.id, job.id)) {
    return `A draft already exists for ${escapeHtml(company.name)}. Use /replace on it instead.`;
  }

  let profile;
  try { profile = loadProfile(); }
  catch (err) { return `Profile not ready: ${escapeHtml(err.message)}`; }

  try {
    const gen = await generateDraft({
      model: config.llm.drafts_model,
      promptVersion: config.llm.prompt_version,
      profile, company, contact, job,
      track: (job.track || 'A'),
    });
    if (/^SKIP:/i.test(gen.body)) {
      return `LLM skipped drafting (${escapeHtml(gen.body.slice(0, 80))}).`;
    }
    const hookOK = verifyHookEvidence({
      hookEvidence: gen.hookEvidence,
      sourceText: job.description_text || '',
    });
    const created = createDraft({
      contactId: contact.id, jobId: job.id,
      subject: gen.subject, body: gen.body,
      promptVersion: gen.promptVersion,
      hookEvidence: gen.hookEvidence,
      hookVerified: hookOK,
      model: gen.model,
      variant: gen.variant,
    });
    return `Draft #${created.id} created for ${escapeHtml(company.name)} ${escapeHtml(contactNote)}${escapeHtml(jobNote)}. ` +
           `hook_verified=${hookOK ? 'yes' : 'NO'}. Use /show ${created.id} or /preview ${created.id}.`;
  } catch (err) {
    return `Draft generation failed: ${escapeHtml(err.message)}`;
  }
}

/* ── /setsize <slug> <band>: manual size override ────────── */

const VALID_BANDS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];

export function handleSetSize(slug, band) {
  if (!slug || !band) {
    return `Usage: /setsize &lt;slug&gt; &lt;band&gt;\nValid bands: ${VALID_BANDS.join(', ')}`;
  }
  if (!VALID_BANDS.includes(band)) {
    return `Unknown band "${escapeHtml(band)}". Valid: ${VALID_BANDS.join(', ')}`;
  }
  const c = companyBySlug(slug);
  if (!c) return `No company with slug "${escapeHtml(slug)}".`;
  setCompanySizeManual(c.id, band);
  return `Set ${escapeHtml(c.name)} size to <b>${band}</b> (manual override — trusted, will not be overwritten by Hunter).`;
}

/* ── /addcompany <input>: manual company registration ─────── */

export async function handleAddCompany(input) {
  if (!input) return 'Usage: /addcompany &lt;linkedin-url | ats-url | name slug ats&gt;';
  try {
    const r = await addCompanyFromInput(input);
    return escapeHtml(r.message);
  } catch (err) {
    return `Add failed: ${escapeHtml(err.message)}`;
  }
}
