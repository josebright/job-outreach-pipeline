// draft/llm.js
// Claude client for draft generation.
// Uses Anthropic SDK's Messages API with a JSON schema tool for structured output.
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/loader.js';
import { pickDraftVariant } from './variant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');

let client = null;

function getClient() {
  if (client) return client;
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');
  client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

// The system prompt lives on disk so we can version it and A/B tune later.
export function loadSystemPrompt(promptName = 'outreach_v1') {
  const p = path.join(ROOT_DIR, 'prompts', `${promptName}.txt`);
  if (!fs.existsSync(p)) throw new Error(`Prompt not found: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

/**
 * Wrap an async call with a hard timeout and a small retry policy. Prevents
 * a hung Anthropic call from blocking the whole draft loop (Q from QA audit).
 */
async function withTimeoutAndRetry(fn, { timeoutMs, retries }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`LLM call exceeded ${timeoutMs}ms timeout`)), timeoutMs)),
      ]);
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const backoff = 1000 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

const DRAFT_TOOL = {
  name: 'return_draft',
  description: 'Return the drafted outreach email as structured JSON.',
  input_schema: {
    type: 'object',
    properties: {
      subject:       { type: 'string', maxLength: 55 },
      body:          { type: 'string' },
      hook_evidence: { type: 'string', description: 'Exact substring quoted from job_posting.' },
    },
    required: ['subject', 'body', 'hook_evidence'],
  },
};

/**
 * Generate one draft. Returns { subject, body, hook_evidence, model, prompt_version }.
 * Throws on network / auth errors so the orchestrator can decide policy.
 */
export async function generateDraft({
  model, promptVersion = 'outreach_v1', profile, company, contact, job, track = 'A',
}) {
  const anthropic = getClient();
  const system = loadSystemPrompt(promptVersion);

  // Pick which structural variant this company gets. Deterministic per
  // company.slug so the same company always gets the same shape (no
  // A/B contamination across contacts) — but different companies rotate
  // between V1/V2/V3, avoiding the "every email looks the same" tell.
  const variant = pickDraftVariant(company.slug, company.size_band);

  const userPayload = {
    variant,
    // The EXACT job title as it appears in the ATS. The subject line MUST
    // use this string verbatim — do not infer a title from the posting
    // text, which often lists sibling roles at the same company.
    job_title: job.title || '',
    job_posting: job.description_text || '',
    company: {
      name: company.name,
      hq_country: company.hq_country || null,
      size_band: company.size_band || null,
    },
    contact: {
      full_name: contact.full_name || null,
      title: contact.title || null,
      role_type: contact.role_type,
    },
    owner_profile: profile,
    track,
  };

  const res = await withTimeoutAndRetry(() => anthropic.messages.create({
    model,
    max_tokens: 800,
    system,
    tools: [DRAFT_TOOL],
    tool_choice: { type: 'tool', name: 'return_draft' },
    messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
  }), { timeoutMs: 25_000, retries: 1 });

  const toolUse = res.content?.find(b => b.type === 'tool_use' && b.name === 'return_draft');
  if (!toolUse) throw new Error('LLM did not return the expected tool_use block');

  const { subject, body, hook_evidence } = toolUse.input || {};
  return {
    subject: sanitizeAsciiTypography(String(subject || '').trim()),
    body: collapseHardWraps(sanitizeAsciiTypography(String(body || '').trim())),
    hookEvidence: sanitizeAsciiTypography(String(hook_evidence || '').trim()),
    model,
    promptVersion,
    variant,
    rawUsage: res.usage || null,
  };
}

/**
 * Collapse intra-paragraph hard line breaks into spaces while keeping
 * blank-line paragraph separators. Fixes the "awkward mid-sentence
 * newlines on mobile" rendering that the LLM sometimes emits when its
 * output includes soft-wrapping at ~72 characters.
 *
 * Signature paragraphs (containing http:// or https://) are left alone
 * so each link stays on its own line as the reader expects.
 *
 * Input:   "line one\nline two\n\nUchenna\nhttps://x.dev\nhttps://y.io"
 * Output:  "line one line two\n\nUchenna\nhttps://x.dev\nhttps://y.io"
 */
export function collapseHardWraps(text) {
  if (!text) return text;
  return String(text)
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(para => {
      if (/https?:\/\//.test(para)) return para.trim();
      return para.replace(/\s*\n\s*/g, ' ').replace(/ {2,}/g, ' ').trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Strip typographic Unicode the prompt bans but the LLM occasionally emits
 * anyway. Prevents mojibake on mail clients that mis-decode UTF-8 subject
 * headers. Applied to subject, body, and hook_evidence.
 *
 * Codepoints handled:
 *   U+2014 em dash, U+2013 en dash              -> " - "
 *   U+2018 U+2019 curly single quotes           -> '
 *   U+201C U+201D curly double quotes           -> "
 *   U+2026 horizontal ellipsis                  -> ...
 *   U+00A0 U+2007 U+2009 U+202F unicode spaces  -> plain space
 *   U+2022 U+25E6 U+2027 U+25AA bullets         -> hyphen
 */
export function sanitizeAsciiTypography(s) {
  if (!s) return s;
  return String(s)
    .replace(/[—–]/g, ' - ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[      ]/g, ' ')
    .replace(/[•◦‧▪]/g, '-')
    .replace(/ {2,}/g, ' ')
    .trim();
}
