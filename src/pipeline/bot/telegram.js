// bot/telegram.js
// Send-only Telegram helper. Used by the cron pipeline to notify the user
// when a run finishes. The interactive bot lives in bot/index.js.
import { http } from '../util/http.js';
import { env } from '../config/loader.js';
import { logger } from '../util/logger.js';

const API = 'https://api.telegram.org';

/**
 * Fire-and-forget message. Returns { ok: bool }. Logs and swallows errors so
 * a Telegram outage cannot crash the pipeline.
 */
export async function notify(text, { parseMode = 'HTML', disablePreview = true } = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, reason: 'no_token' };
  const chatIds = String(env.TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (chatIds.length === 0) return { ok: false, reason: 'no_chat_ids' };

  let sent = 0;
  for (const chatId of chatIds) {
    try {
      const res = await http.post(
        `${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: disablePreview,
        },
        { validateStatus: s => s < 500, timeout: 8_000 },
      );
      if (res.status === 200 && res.data?.ok) sent++;
      else logger.warn({ status: res.status, chatId, err: res.data?.description }, 'telegram send failed');
    } catch (err) {
      logger.warn({ err: err.message, chatId }, 'telegram send errored');
    }
  }
  return { ok: sent > 0, sent };
}

export function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
