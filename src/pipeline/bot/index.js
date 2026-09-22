// bot/index.js
// Telegraf long-polling bot. Runs as part of the always-on Railway service.
// Only responds to chat IDs listed in TELEGRAM_ALLOWED_CHAT_IDS.
import { Telegraf } from 'telegraf';
import { env } from '../config/loader.js';
import { logger } from '../util/logger.js';
import {
  handleList, handleShow, handlePreview,
  handleApprove, handleReject, handleRejectAll, handleMarkReplied,
  handleSend, handleStatus, handleHelp,
  handleRun, handleReplace, handleDraftForSlug, handleAddCompany,
  handleDiag, handleSetSize,
  handleSuppress, handleUnblock, handleSuppressed, handleUnpause, handleBouncelog, handleCleanup,
  handleRules, handleForget, handleIssues,
} from './handlers.js';

let running = null;

/**
 * Start the bot. Returns the Telegraf instance so callers can stop() it.
 */
export function startBot() {
  if (running) return running;
  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN missing; bot not started');
    return null;
  }
  const allowed = String(env.TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const allowedSet = new Set(allowed);

  const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

  // Auth middleware: reject any chat not on the allow-list.
  bot.use(async (ctx, next) => {
    const chatId = String(ctx.chat?.id || '');
    // Always answer /whoami and /start so a new user can learn their id.
    const text = ctx.message?.text || '';
    if (text.startsWith('/whoami') || text.startsWith('/start')) return next();

    if (allowedSet.size === 0 || allowedSet.has(chatId)) return next();
    logger.warn({ chatId, text: text.slice(0, 80) }, 'telegram: rejected non-allowlisted chat');
    return ctx.reply('This bot is not open to you.');
  });

  bot.command('start', (ctx) => ctx.replyWithHTML(
    `Hello. Your Telegram chat id is <code>${ctx.chat?.id}</code>. ` +
    `Add it to <code>TELEGRAM_ALLOWED_CHAT_IDS</code> on Railway to enable commands.` +
    `\n\n${handleHelp()}`
  ));

  bot.command('whoami', (ctx) => ctx.replyWithHTML(
    `Your Telegram chat id: <code>${ctx.chat?.id}</code>`
  ));

  bot.command('help', guard('help', () => handleHelp()));

  bot.command('list',    guard('list',    () => handleList()));
  bot.command('show',    guard('show',    (ctx) => handleShow(argOf(ctx))));
  bot.command('approve', guard('approve', (ctx) => handleApprove(argOf(ctx))));
  bot.command('reject',  guard('reject',  (ctx) => {
    const [id, ...rest] = argsOf(ctx);
    return handleReject(id, rest.join(' '));
  }));
  bot.command('rejectall', guard('rejectall', (ctx) => handleRejectAll(argsOf(ctx).join(' '))));
  bot.command('replied', guard('replied', (ctx) => handleMarkReplied(argOf(ctx))));
  bot.command('status',  guard('status',  () => handleStatus()));
  bot.command('diag',    guard('diag',    () => handleDiag()));

  // Long-running commands run in the background - see detached().
  bot.command('preview', detached('preview', 'Sending preview…',
    (ctx) => handlePreview(argOf(ctx))));
  bot.command('send', detached('send', 'Firing send loop… I will post the result here.',
    () => handleSend()));
  bot.command('run', detached('run',
    'Firing full pipeline… this takes a few minutes. The bot stays responsive; I will post the result here when it finishes.',
    () => handleRun()));
  bot.command('replace', detached('replace', (ctx) => `Regenerating draft #${argsOf(ctx)[0]}…`,
    (ctx) => {
      const [id, ...rest] = argsOf(ctx);
      return handleReplace(id, rest.join(' '));
    }));
  bot.command('draft', detached('draft', (ctx) => `Drafting for ${argOf(ctx) || '(no slug)'} …`,
    (ctx) => handleDraftForSlug(argOf(ctx))));

  bot.command('setsize', guard('setsize', (ctx) => {
    const [slug, band] = argsOf(ctx);
    return handleSetSize(slug, band);
  }));
  bot.command('suppress', guard('suppress', (ctx) => {
    const [slug, ...rest] = argsOf(ctx);
    return handleSuppress(slug, rest.join(' '));
  }));
  bot.command('unblock',    guard('unblock',    (ctx) => handleUnblock(argOf(ctx))));
  bot.command('suppressed', guard('suppressed', () => handleSuppressed()));
  bot.command('unpause',    guard('unpause',    () => handleUnpause()));
  bot.command('bouncelog',  guard('bouncelog',  (ctx) => handleBouncelog(argOf(ctx))));
  bot.command('cleanup',    guard('cleanup',    () => handleCleanup()));
  bot.command('rules',      guard('rules',      () => handleRules()));
  bot.command('forget',     guard('forget',     (ctx) => handleForget(argOf(ctx))));
  bot.command('issues',     guard('issues',     (ctx) => handleIssues(argOf(ctx))));

  bot.command('addcompany', detached('addcompany', 'Looking up…', (ctx) => {
    const text = ctx.message?.text || '';
    const input = text.replace(/^\/addcompany(@\S+)?\s*/i, '').trim();
    return handleAddCompany(input);
  }));

  // Last-resort net. Individual commands are wrapped in guard(), so anything
  // reaching here is a middleware-level failure - still report it rather than
  // leaving the user staring at silence.
  bot.catch((err, ctx) => {
    logger.error({ err: err.message, stack: err.stack, updateType: ctx.updateType }, 'telegraf handler error');
    ctx.reply(`Something broke handling that: ${err.message}`).catch(e => logger.warn({ err: e.message }, 'telegram reply failed'));
  });

  bot.launch({ dropPendingUpdates: true }).catch(err => {
    logger.error({ err: err.message }, 'telegram launch failed');
  });

  logger.info({ allowedChats: allowed.length }, 'telegram bot launched');
  running = bot;
  return bot;
}

// Telegram rejects any message over 4096 characters. /list grows ~140 chars
// per queued draft, so it silently died somewhere past ~28 pending drafts -
// the API call failed, bot.catch logged it, and the user saw nothing at all.
const TELEGRAM_LIMIT = 4096;
const CHUNK_TARGET = 3500;          // headroom for HTML entities

/**
 * Split on line boundaries so a chunk never lands mid-tag (which would make
 * the HTML unparseable and fail the send for a second reason).
 * Exported for tests.
 */
export function chunkMessage(text, limit = CHUNK_TARGET) {
  const s = String(text || '');
  if (s.length <= limit) return [s];
  const out = [];
  let buf = '';
  for (const line of s.split('\n')) {
    // A single line longer than the limit has to be hard-split.
    if (line.length > limit) {
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
      continue;
    }
    if (buf.length + line.length + 1 > limit) { out.push(buf); buf = line; }
    else { buf = buf ? `${buf}\n${line}` : line; }
  }
  if (buf) out.push(buf);
  return out;
}

const stripTags = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Deliver a reply no matter what. Chunks to stay under the size limit, and if
 * Telegram refuses to parse the HTML, resends that chunk as plain text rather
 * than dropping it. Silence is the one outcome that is never acceptable - the
 * user cannot debug what they cannot see.
 */
async function safeReply(ctx, text) {
  const body = (text === undefined || text === null || text === '')
    ? '(command returned nothing)'
    : String(text);
  for (const part of chunkMessage(body)) {
    try {
      await ctx.replyWithHTML(part, { disable_web_page_preview: true });
    } catch (err) {
      logger.warn({ err: err.message, len: part.length }, 'HTML reply rejected, retrying as plain text');
      await ctx.reply(stripTags(part), { disable_web_page_preview: true });
    }
  }
}

/**
 * Wrap a command so a thrown error reaches the USER, not just the log. The
 * previous bot.catch logged and returned, so every failure looked identical
 * from Telegram: no response at all.
 */
function guard(name, fn) {
  return async (ctx) => {
    try {
      const out = await fn(ctx);
      if (out !== undefined) await safeReply(ctx, out);
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack, command: name }, 'command failed');
      await ctx.reply(`/${name} failed: ${err.message}`).catch(e => logger.warn({ err: e.message }, 'telegram reply failed'));
    }
  };
}

// Telegraf abandons any update handler after 90 seconds (handlerTimeout) with
// "Promise timed out after 90000 milliseconds". /run takes several minutes, so
// its handler always timed out even though the pipeline kept going and
// finished - which is why "Pipeline run complete" arrived AFTER the error.
// Polling also waits on the handler, so the bot stopped answering every other
// command for those 90 seconds.
//
// Long commands now acknowledge at once and run in the background; the result,
// or the real error, is posted to the chat when the work finishes.
function detached(name, ack, fn) {
  return async (ctx) => {
    const ackText = typeof ack === 'function' ? ack(ctx) : ack;
    await ctx.reply(ackText).catch(e => logger.warn({ err: e.message }, 'telegram reply failed'));
    Promise.resolve()
      .then(() => fn(ctx))
      .then(out => (out === undefined ? undefined : safeReply(ctx, out)))
      .catch(async (err) => {
        logger.error({ err: err.message, stack: err.stack, command: name }, 'background command failed');
        await ctx.reply(`/${name} failed: ${err.message}`).catch(e => logger.warn({ err: e.message }, 'telegram reply failed'));
      });
  };
}

function argOf(ctx) {
  const text = ctx.message?.text || '';
  return text.split(/\s+/).slice(1)[0];
}
function argsOf(ctx) {
  const text = ctx.message?.text || '';
  return text.split(/\s+/).slice(1);
}

export function stopBot(reason = 'shutdown') {
  if (!running) return;
  try { running.stop(reason); } catch { /* ignore */ }
  running = null;
}
