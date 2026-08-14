// review/index.js
// Simple terminal-based reviewer. Lists pending_review drafts and applies
// approve | reject | edit | snooze via subcommands. No Airtable needed.
//
// Usage:
//   node src/pipeline/cli.js review list
//   node src/pipeline/cli.js review show <draftId>
//   node src/pipeline/cli.js review approve <draftId>
//   node src/pipeline/cli.js review reject  <draftId> --reason "generic body"
//   node src/pipeline/cli.js review edit    <draftId>   (opens $EDITOR on a temp file)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  draftsByStatus, draftById, contactById, companyById, jobById,
  updateDraftStatus, updateDraftContent,
} from '../db/repo.js';
import { getDb } from '../db/connection.js';
import { recordEvent } from '../db/event-log.js';

export function reviewList() {
  const rows = draftsByStatus('pending_review').map(d => {
    const contact = contactById(d.contact_id);
    const company = contact ? companyById(contact.company_id) : null;
    return {
      id: d.id,
      to: contact?.email || '?',
      role: contact?.role_type || '?',
      company: company?.name || '?',
      score: company?.score ?? '?',
      hookOK: d.hook_verified ? 'yes' : 'NO',
      subject: (d.subject || '').slice(0, 55),
    };
  });
  if (rows.length === 0) {
    console.log('No drafts pending review.');
    return { count: 0 };
  }
  console.table(rows);
  return { count: rows.length };
}

export function reviewShow(id) {
  const d = draftById(Number(id));
  if (!d) return console.log(`Draft ${id} not found.`);
  const contact = contactById(d.contact_id);
  const company = contact ? companyById(contact.company_id) : null;
  const job = d.job_id ? jobById(d.job_id) : null;

  console.log('');
  console.log(`Draft #${d.id}   status=${d.status}   hook_verified=${d.hook_verified ? 'yes' : 'NO'}`);
  console.log(`Company: ${company?.name || '?'}    Company score: ${company?.score ?? '?'}`);
  console.log(`Contact: ${contact?.full_name || '?'} <${contact?.email || '?'}> (${contact?.role_type})`);
  console.log(`Title:   ${contact?.title || '?'}`);
  if (job) console.log(`Job:     ${job.title}   (${job.url || 'no url'})`);
  console.log(`Model:   ${d.model || '?'}    Prompt: ${d.prompt_version}`);
  console.log('');
  console.log(`Subject: ${d.subject}`);
  console.log('---');
  console.log(d.body);
  console.log('---');
  if (d.hook_evidence) console.log(`Hook evidence: "${d.hook_evidence}"`);
}

export function reviewApprove(id) {
  const d = draftById(Number(id));
  if (!d) return console.log(`Draft ${id} not found.`);
  if (d.status !== 'pending_review') return console.log(`Draft ${id} is not pending_review (status=${d.status}).`);
  updateDraftStatus(d.id, 'approved');
  console.log(`Draft ${id} approved. It will be sent on the next cron pass.`);
}

export function reviewReject(id, reason = 'no reason given') {
  const d = draftById(Number(id));
  if (!d) return console.log(`Draft ${id} not found.`);
  updateDraftStatus(d.id, 'rejected', { reason });
  console.log(`Draft ${id} rejected: ${reason}`);
}

/**
 * Open $EDITOR on a temp file containing "SUBJECT: ...\n\nBODY".
 * Save the file, close the editor: subject/body are parsed and persisted.
 */
/**
 * Manual "the recipient replied but auto-detection missed it" override.
 * Cancels remaining follow-ups by marking the initial message as replied.
 */
export function reviewMarkReplied(id) {
  const draftId = Number(id);
  const d = draftById(draftId);
  if (!d) return console.log(`Draft ${id} not found.`);
  const db = getDb();
  const initial = db.prepare(`
    SELECT * FROM message WHERE draft_id = ? AND kind = 'initial' AND direction = 'outbound'
    ORDER BY id ASC LIMIT 1
  `).get(draftId);
  if (!initial) return console.log(`Draft ${id} has no sent initial message yet; nothing to mark.`);
  db.prepare(`UPDATE message SET replied_at = datetime('now'), reply_sentiment = 'manual' WHERE id = ?`)
    .run(initial.id);
  recordEvent({ entity: 'message', entityId: initial.id, event: 'replied', detail: { sentiment: 'manual' } });
  console.log(`Marked draft ${id} as replied. Any pending follow-ups will be skipped.`);
}

export function reviewEdit(id) {
  const d = draftById(Number(id));
  if (!d) return console.log(`Draft ${id} not found.`);
  const editor = process.env.EDITOR || 'vim';
  const p = path.join(os.tmpdir(), `draft-${d.id}-${Date.now()}.txt`);
  fs.writeFileSync(p, `SUBJECT: ${d.subject || ''}\n\n${d.body || ''}\n`);
  const r = spawnSync(editor, [p], { stdio: 'inherit' });
  if (r.status !== 0) return console.log(`Editor exited non-zero; no changes saved.`);
  const raw = fs.readFileSync(p, 'utf8');
  fs.unlinkSync(p);
  const m = raw.match(/^SUBJECT:\s*(.*)\r?\n\r?\n([\s\S]*)$/);
  if (!m) return console.log(`Could not parse edited file. Format: "SUBJECT: ...\\n\\n<body>". No changes saved.`);
  const subject = m[1].trim();
  const body = m[2].trimEnd();
  updateDraftContent(d.id, { subject, body });
  console.log(`Draft ${id} updated. Run "review approve ${id}" when ready.`);
}
