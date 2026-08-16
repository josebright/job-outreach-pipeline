// bot/handlers.js
// Business logic for each Telegram command. Kept separate from the Telegraf
// wiring so it is unit-testable.
import {
  draftsByStatus, draftById, contactById, companyById, jobById,
  contactsByCompany, jobsByCompany, existingDraftFor,
  updateDraftStatus, createDraft,
  companyBySlug, setCompanySizeManual,
  suppressCompany, unsuppressCompany, isCompanySuppressed, listSuppressedCompanies,
} from '../db/repo.js';
import { getDb } from '../db/connection.js';
import { recordEvent } from '../db/event-log.js';
import { sendMessage } from '../send/gmail.js';
import { runSend } from '../send/index.js';
import { runReport } from '../report/index.js';
import { usage } from '../enrich/cost-guard.js';
import { runDiscover } from '../discover/index.js';
import { runIngest } from '../ingest/index.js';
import { runQualify } from '../qualify/index.js';
import { runEnrich } from '../enrich/index.js';
import { runDraft } from '../draft/index.js';
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
  return `Draft ${d.id} approved. Use /send to fire it now, or leave it for the next auto-send cron.`;
}

export function handleReject(id, reason) {
  const d = draftById(Number(id));
  if (!d) return `Draft ${id} not found.`;
  updateDraftStatus(d.id, 'rejected', { reason: reason || 'via telegram' });

  // Auto-suppress if the reason indicates the company itself is wrong
  // (too big, too small, wrong industry). Prevents the same company
  // from re-appearing in the next /run cycle via any aggregator.
  const shouldSuppress = /\b(too\s*big|too\s*large|too\s*small|wrong\s*(size|industry|role))\b/i
    .test(reason || '');
  let extra = '';
  if (shouldSuppress) {
    const contact = contactById(d.contact_id);
    const companyId = contact?.company_id;
    if (companyId) {
      suppressCompany(companyId, `auto-suppressed on /reject: ${reason}`);
      const co = companyById(companyId);
      extra = `\n<b>Auto-suppressed ${escapeHtml(co?.name || '?')}</b> — future /run cycles will skip it.`;
    }
  }
  return `Draft ${d.id} rejected: ${escapeHtml(reason || 'no reason given')}${extra}`;
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
    '/rejectall &lt;reason&gt; — bulk-reject every pending + approved draft',
    '/replace &lt;id&gt; [reason] — reject + regenerate a fresh draft',
    '/replied &lt;id&gt; — manually cancel remaining follow-ups',
    '/send — send all approved drafts now',
    '/run — fire the full pipeline (discover → ingest → qualify → enrich → draft)',
    '/draft &lt;company-slug&gt; — force-draft against a company by slug',
    '/addcompany &lt;linkedin-url | ats-url | name slug ats&gt; — add a company manually',
    '/setsize &lt;slug&gt; &lt;band&gt; — manual size override (e.g. /setsize affirm 1000+)',
    '/suppress &lt;slug&gt; [reason] — permanently blocklist a company',
    '/unblock &lt;slug&gt; — remove a company from the blocklist',
    '/suppressed — list all suppressed companies',
    '/status — pipeline funnel snapshot',
    '/diag — deep pipeline diagnostic (pool composition, budgets)',
    '/whoami — show your Telegram chat id (for env config)',
  ].join('\n');
}

/* ── /run: fire full pipeline ─────────────────────────────── */

export async function handleRun() {
  const config = loadConfig();
  const stats = { discover: null, ingest: null, qualify: null, enrich: null, draft: null };
  try {
    stats.discover = await runDiscover({ config });
    stats.ingest   = await runIngest({ config });
    stats.qualify  = await runQualify({ config });
    stats.enrich   = await runEnrich({ config });
    stats.draft    = await runDraft({ config });

    // If nothing came out of draft, take another swing: re-enrich all
    // qualified companies (including ones that already had contacts skipped
    // for lack of a qualified job earlier), then re-draft. Cheap because
    // enrich's per-company guard prevents duplicate Hunter calls when a
    // contact already exists.
    if ((stats.draft?.draftsCreated || 0) === 0) {
      logger.warn('run: 0 drafts produced, retrying enrich + draft once more');
      const enrich2 = await runEnrich({ config });
      const draft2  = await runDraft({ config });
      stats.enrich = mergeStats(stats.enrich, enrich2);
      stats.draft  = mergeStats(stats.draft, draft2);
    }
  } catch (err) {
    logger.error({ err: err.message }, 'run pipeline failed');
    return `Pipeline run failed: ${escapeHtml(err.message)}`;
  }
  const drafts = stats.draft?.draftsCreated || 0;
  const lines = [
    '<b>Pipeline run complete</b>',
    `discover: ${JSON.stringify(stats.discover || {})}`,
    `ingest:   ${JSON.stringify(stats.ingest || {})}`,
    `qualify:  ${JSON.stringify(stats.qualify || {})}`,
    `enrich:   ${JSON.stringify(stats.enrich || {})}`,
    `draft:    ${JSON.stringify(stats.draft || {})}`,
  ];
  if (drafts === 0) {
    lines.push('',
      '<b>No drafts produced.</b> Hunter returned no usable contacts for any qualified company on this pass. ' +
      'Try /addcompany with a specific LinkedIn URL, or wait for the next discovery cycle.');
  } else {
    lines.push('', `Use /list to review the ${drafts} new draft(s).`);
  }
  return lines.join('\n');
}

function mergeStats(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a };
  for (const k of Object.keys(b)) {
    if (typeof b[k] === 'number') out[k] = (out[k] || 0) + b[k];
    else if (typeof b[k] === 'boolean') out[k] = out[k] || b[k];
    else out[k] = b[k];
  }
  return out;
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

  // Reject the current draft first so /list stays clean.
  updateDraftStatus(draftId, 'rejected', { reason: reason || 'replace via telegram' });

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
    });
    return `Draft ${draftId} rejected. New draft #${created.id} created (hook_verified=${hookOK ? 'yes' : 'NO'}). Use /show ${created.id}.`;
  } catch (err) {
    return `Regeneration failed: ${escapeHtml(err.message)}`;
  }
}

/* ── /draft <slug>: force-draft against a company by slug ── */

export async function handleDraftForSlug(slug) {
  if (!slug) return 'Usage: /draft &lt;company-slug&gt;';
  const company = companyBySlug(slug);
  if (!company) return `No company with slug "${escapeHtml(slug)}".`;

  const contacts = contactsByCompany(company.id).filter(c => c.email_status !== 'invalid');
  if (contacts.length === 0) return `Company ${escapeHtml(company.name)} has no usable contact. Run /run or enrich first.`;
  const jobs = jobsByCompany(company.id).filter(j => j.status === 'qualified')
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  if (jobs.length === 0) return `Company ${escapeHtml(company.name)} has no qualified jobs. Run /run first.`;

  const contact = contacts[0];
  const job = jobs[0];
  if (existingDraftFor(contact.id, job.id)) {
    return `A draft already exists for ${escapeHtml(company.name)}. Use /replace on it instead.`;
  }

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
    });
    return `Draft #${created.id} created for ${escapeHtml(company.name)} (hook_verified=${hookOK ? 'yes' : 'NO'}). Use /show ${created.id}.`;
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
