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
 * Build an RFC 5322 multipart/alternative message. We send BOTH a
 * text/plain part and a minimal text/html part.
 *
 * Why not plain-text only: Gmail iOS renders text/plain in a fixed-width
 * container that wraps at ~55 chars regardless of viewport, producing
 * jagged one-word orphan lines even when our body is a single long
 * paragraph. Gmail iOS is documented as non-compliant with RFC 3676
 * format=flowed reflow (vxlabs, Bynens 2019-2024), so declaring
 * format=flowed doesn't help — and if the body isn't space-terminated
 * per the spec it actively hurts by turning every \n into a hard break.
 *
 * Why not HTML-only: cold outreach from a new sender to a founder inbox
 * scores lower with HTML-only content. The plain-text part maintains
 * the "hand-typed" trust signal for filters and text-only clients.
 *
 * The HTML part is deliberately minimal: <p> per paragraph, one <a>
 * for the signature URL. No CSS, no tables, no images, no tracking
 * pixels. Gmail (all clients) picks the HTML part and reflows to
 * viewport. Text-only clients and spam filters see the clean plain
 * text alternative.
 */
export function buildMime({ from, fromName, to, subject, body, replyTo = null, inReplyTo = null, references = null }) {
  const encodedSubject = encodeHeader(subject);
  const fromHeader = fromName
    ? (/[^\x00-\x7F]/.test(fromName)
        ? `${encodeHeader(fromName)} <${from}>`
        : `"${fromName}" <${from}>`)
    : from;

  const boundary = mimeBoundary();
  const plainBody = body;
  const htmlBody = bodyToMinimalHtml(body);

  const headers = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (replyTo && replyTo !== from) headers.push(`Reply-To: ${replyTo}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    plainBody,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    htmlBody,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return `${headers.join('\r\n')}\r\n\r\n${parts}`;
}

/**
 * Render our plain-text body as minimal semantic HTML. One <p> per
 * paragraph (paragraphs are separated by blank lines in the source).
 * Bare URLs and email addresses become clickable <a>. No CSS, no
 * width attribute, no tables, no wrapper div. Gmail will reflow the
 * <p> tags to viewport width naturally.
 *
 * Exported for tests.
 */
export function bodyToMinimalHtml(body) {
  if (!body) return '<p></p>';
  const paragraphs = String(body).split(/\n{2,}/);
  const rendered = paragraphs
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      // Inside a paragraph, preserve line breaks (e.g., signature block
      // with URL on its own line). Convert single \n to <br>.
      const withBreaks = escapeHtmlText(p).replace(/\n/g, '<br>');
      // Linkify bare URLs (http/https). Deliberately narrow to avoid
      // wrapping ambiguous strings.
      const linked = withBreaks.replace(
        /(https?:\/\/[^\s<>"]+)/g,
        '<a href="$1">$1</a>',
      );
      return `<p>${linked}</p>`;
    })
    .join('\n');
  return rendered;
}

function escapeHtmlText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Boundary must be unique enough to never appear in the body. Timestamp +
// random slice is standard.
function mimeBoundary() {
  return `bnd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
