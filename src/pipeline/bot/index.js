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

  bot.command('help', (ctx) => ctx.replyWithHTML(handleHelp()));

  bot.command('list',   (ctx) => ctx.replyWithHTML(handleList()));
  bot.command('show',   (ctx) => ctx.replyWithHTML(handleShow(argOf(ctx))));
  bot.command('approve', (ctx) => ctx.replyWithHTML(handleApprove(argOf(ctx))));
  bot.command('reject',  (ctx) => {
    const [id, ...rest] = argsOf(ctx);
    ctx.replyWithHTML(handleReject(id, rest.join(' ')));
  });
  bot.command('rejectall', (ctx) => {
    const reason = argsOf(ctx).join(' ');
    ctx.replyWithHTML(handleRejectAll(reason));
  });
  bot.command('replied', (ctx) => ctx.replyWithHTML(handleMarkReplied(argOf(ctx))));
  bot.command('status', async (ctx) => ctx.replyWithHTML(await handleStatus()));

  // Async commands (preview + send) can take a few seconds.
  bot.command('preview', async (ctx) => {
    await ctx.reply('Sending preview…');
    ctx.replyWithHTML(await handlePreview(argOf(ctx)));
  });
  bot.command('send', async (ctx) => {
    await ctx.reply('Firing send loop…');
    ctx.replyWithHTML(await handleSend());
  });

  bot.command('run', async (ctx) => {
    await ctx.reply('Firing full pipeline… this may take a few minutes.');
    ctx.replyWithHTML(await handleRun());
  });

  bot.command('replace', async (ctx) => {
    const [id, ...rest] = argsOf(ctx);
    await ctx.reply(`Regenerating draft #${id}…`);
    ctx.replyWithHTML(await handleReplace(id, rest.join(' ')));
  });

  bot.command('draft', async (ctx) => {
    const slug = argOf(ctx);
    await ctx.reply(`Drafting for ${slug || '(no slug)'} …`);
    ctx.replyWithHTML(await handleDraftForSlug(slug));
  });

  bot.command('addcompany', async (ctx) => {
    const text = ctx.message?.text || '';
    const input = text.replace(/^\/addcompany(@\S+)?\s*/i, '').trim();
    await ctx.reply('Looking up…');
    ctx.replyWithHTML(await handleAddCompany(input));
  });

  bot.catch((err, ctx) => {
    logger.error({ err: err.message, updateType: ctx.updateType }, 'telegraf handler error');
  });

  bot.launch({ dropPendingUpdates: true }).catch(err => {
    logger.error({ err: err.message }, 'telegram launch failed');
  });

  logger.info({ allowedChats: allowed.length }, 'telegram bot launched');
  running = bot;
  return bot;
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
