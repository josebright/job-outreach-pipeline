// send/gmail.js
// Gmail API transport. OAuth2 (installed app) with refresh token.
// Uses googleapis SDK.
import { google } from 'googleapis';
import { env } from '../config/loader.js';

let cached = null;

function getGmail() {
  if (cached) return cached;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN missing');
  }
  const oauth2Client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground',
  );
  oauth2Client.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
  cached = google.gmail({ version: 'v1', auth: oauth2Client });
  return cached;
}

function base64url(str) {
  return Buffer.from(str, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * RFC 2047 encoded-word for a header value that contains non-ASCII bytes.
 * Returns the value unchanged when it is already 7-bit clean.
 */
export function encodeHeader(value) {
  const s = String(value || '');
  if (!/[^\x00-\x7F]/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/**
 * Build an RFC 5322 message. Plain-text only. Handles UTF-8 in subject,
 * display name, and body correctly (was previously declaring 7bit while
 * shipping 8-bit bytes, which caused mojibake at receiving mail clients).
 */
export function buildMime({ from, fromName, to, subject, body, replyTo = null, inReplyTo = null, references = null }) {
  const encodedSubject = encodeHeader(subject);
  const fromHeader = fromName
    ? (/[^\x00-\x7F]/.test(fromName)
        ? `${encodeHeader(fromName)} <${from}>`
        : `"${fromName}" <${from}>`)
    : from;

  const headers = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8; format=flowed',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (replyTo && replyTo !== from) headers.push(`Reply-To: ${replyTo}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

/**
 * Send one message. Optionally continue a thread by passing threadId.
 * Returns { messageId, threadId }.
 */
export async function sendMessage({ from, fromName, to, subject, body, replyTo, threadId = null, inReplyTo = null, references = null }) {
  const gmail = getGmail();
  const raw = base64url(buildMime({ from, fromName, to, subject, body, replyTo, inReplyTo, references }));
  const requestBody = threadId ? { raw, threadId } : { raw };
  const res = await gmail.users.messages.send({ userId: 'me', requestBody });
  return {
    messageId: res.data?.id || null,
    threadId: res.data?.threadId || null,
    labelIds: res.data?.labelIds || [],
  };
}

/**
 * List messages received after a given epoch second (Gmail query: after:).
 * Returns metadata payloads with a snippet. Body fetch is separate.
 */
export async function listInboundSince({ afterEpochSec }) {
  const gmail = getGmail();
  const q = `in:inbox after:${Math.floor(afterEpochSec)}`;
  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100 });
  const ids = list.data?.messages || [];
  const out = [];
  for (const { id } of ids) {
    const full = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Message-ID', 'In-Reply-To', 'References', 'Auto-Submitted', 'X-Failed-Recipients'] });
    out.push(full.data);
  }
  return out;
}

/**
 * Fetch the full body (text/plain) of a single message. Used for bounce DSN
 * parsing when the failed address is not in the metadata headers.
 */
export async function getMessageBodyText(id) {
  const gmail = getGmail();
  const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  return extractPlainText(res.data?.payload) || res.data?.snippet || '';
}

function extractPlainText(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    try { return Buffer.from(payload.body.data, 'base64').toString('utf8'); } catch { /* fall through */ }
  }
  for (const part of payload.parts || []) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      try { return Buffer.from(part.body.data, 'base64').toString('utf8'); } catch { /* try next */ }
    }
  }
  // Recurse into nested multipart (e.g., multipart/report for DSNs).
  for (const part of payload.parts || []) {
    const nested = extractPlainText(part);
    if (nested) return nested;
  }
  return '';
}
