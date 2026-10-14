/**
 * Telegram bot wiring.
 *
 * Bridges Telegram's `Telegraf` event surface to the agent loop built in
 * Step 5. The contract:
 *
 *   - Only one allowed chat id is honoured. Everyone else gets a polite
 *     refusal. The id can be supplied via env (`TELEGRAM_ALLOWED_CHAT_ID`)
 *     or persisted in SQLite from a `/setchat` command.
 *   - The `/chatid` command works in ANY chat — it just echoes the chat id
 *     back so the user can wire it into config.
 *   - `/movechat`, sent from the allowed chat, hands out a short-lived token
 *     that lets `/setchat <token>` move the bot to another chat (e.g. from a
 *     private chat to a household group).
 *   - `/stop`, `/start`, `/status` toggle the `bot_running` flag in SQLite.
 *   - `/sms` + a 6-digit code drive the Picnic re-auth state machine.
 *   - Every other message goes through the agent loop with the sender's
 *     `first_name` injected so the agent can address people individually.
 *
 * The whole bot is single-process; per-chat state lives in `state.ts`.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Telegraf, type Context } from 'telegraf';
import type { Message } from 'telegraf/types';

import { type PicnicClient } from '../picnic/index.js';
import { AuthRequiredError } from '../picnic/index.js';
import {
  AgentLoop,
  DailySpendCapExceededError,
  IterationCapExceededError,
  takeBudgetWarning,
} from '../agent/index.js';
import {
  getTodayApiSpend,
  getRecentAllergenDecisions,
  listAllergenOverrides,
  type DB,
} from '../memory/index.js';

import {
  getAllowedChatId,
  setAllowedChatId,
  isBotRunning,
  setBotRunning,
  isOnboardingDone,
  getOrCreateChatState,
  continueOrStartConversation,
  resetChatHistory,
} from './state.js';
import {
  AUTH_REQUIRED_PROMPT,
  SMS_CODE_REGEX,
  handleSmsCode,
  handleSmsCommand,
} from './auth-flow.js';
import { sendOnboardingWelcome } from './onboarding.js';
import { buildWeeklyNudge } from '../scheduler/index.js';

/** Telegram's hard limit on message length. We split conservatively below it. */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const SAFE_CHUNK_LENGTH = 3500;

/** How long a /movechat token stays redeemable. */
const MOVE_TOKEN_TTL_MS = 10 * 60_000;

/** Compare a supplied token without leaking a prefix match through timing. */
function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface TelegramBotOptions {
  token: string;
  db: DB;
  picnic: PicnicClient;
  agent: AgentLoop;
  /** Daily Anthropic spend limit, for the 75% heads-up. */
  dailySpendLimitEur: number;
  /** Env-supplied fallback when the meta table doesn't have an id. */
  envAllowedChatId: string | null;
}

export function createBot(opts: TelegramBotOptions): Telegraf {
  const bot = new Telegraf(opts.token);

  // Bootstrap token: a one-time random secret printed to stdout/journal at
  // startup IF no chat is configured yet. The user must include it in
  // `/setchat <token>` to claim the bot — defends against a first-stranger
  // hijack where any random Telegram user could otherwise grab the bot by
  // running /setchat before the operator does.
  //
  // After a successful claim (or if a chat was already configured via env or
  // a previous /setchat), the token is cleared and `/setchat` refuses
  // further claims unless they come from the existing allowed chat.
  let bootstrapToken: string | null = null;
  if (getAllowedChatId(opts.db, opts.envAllowedChatId) === null) {
    bootstrapToken = randomBytes(8).toString('hex');
    console.log(
      `\n[telegram] BOOTSTRAP TOKEN: ${bootstrapToken}\n` +
        `[telegram] No allowed chat configured. To claim the bot, message it from your ` +
        `target chat and run:  /setchat ${bootstrapToken}\n`,
    );
  }

  // /chatid — replies in ANY chat. Just echoes back the caller's own chat id;
  // not sensitive (every Telegram client already knows its own chat id).
  bot.command('chatid', async (ctx) => {
    await ctx.reply(
      `Chat id: ${ctx.chat.id}\n` +
        `Zet deze in je .env als TELEGRAM_ALLOWED_CHAT_ID, of stuur /setchat met ` +
        `de bootstrap-token uit de serverlogs in de chat die je wil gebruiken.`,
    );
  });

  // Move token: issued by /movechat from the allowed chat, redeemed by
  // `/setchat <token>` in the destination chat. Single-use, expires after
  // MOVE_TOKEN_TTL_MS, and lives only in memory (a restart cancels a move).
  let moveToken: { token: string; expiresAt: number } | null = null;

  // /movechat — start moving the bot to a different chat. Registered above
  // the guard middleware like /setchat, but explicitly restricted to the
  // allowed chat: anyone else is silently ignored.
  bot.command('movechat', async (ctx) => {
    const current = getAllowedChatId(opts.db, opts.envAllowedChatId);
    if (current === null || current !== ctx.chat.id) return;

    const token = randomBytes(8).toString('hex');
    moveToken = { token, expiresAt: Date.now() + MOVE_TOKEN_TTL_MS };
    await ctx.reply(
      [
        'Verhuizen naar een andere chat (bijvoorbeeld een groep met je huisgenoten):',
        '',
        '1. Zet in @BotFather met /setprivacy de privacy-modus van deze bot op Disable. ' +
          'Anders ziet de bot in een groep alleen commando’s, geen gewone berichten. ' +
          'Zat de bot al in de groep? Verwijder hem en voeg hem opnieuw toe.',
        '2. Voeg de bot toe aan de nieuwe chat.',
        `3. Stuur daar binnen ${MOVE_TOKEN_TTL_MS / 60_000} minuten:`,
        `/setchat ${token}`,
        '',
        'Daarna reageert de bot alleen nog in de nieuwe chat. Bestelgeschiedenis, ' +
          'profiel en glutenregels gaan mee; dit gesprek begint daar opnieuw.',
      ].join('\n'),
    );
  });

  // /setchat — persists the current chat as the allowed one.
  //   - First time, no allowed id set: requires the bootstrap token printed to
  //     stdout at process start. This is what stops a stranger from claiming
  //     the bot first.
  //   - From another chat while one is set: requires a live /movechat token.
  //   - From the allowed chat itself: a harmless no-op reconfirmation.
  bot.command('setchat', async (ctx) => {
    const current = getAllowedChatId(opts.db, opts.envAllowedChatId);
    const supplied = ctx.message.text.trim().split(/\s+/)[1] ?? '';
    if (current === null) {
      // First-time claim path.
      if (!bootstrapToken) {
        await ctx.reply(
          'Er is geen bootstrap-token actief. Herstart de bot om een nieuwe te krijgen.',
        );
        return;
      }
      if (!tokenMatches(supplied, bootstrapToken)) {
        await ctx.reply(
          'Ongeldige of ontbrekende bootstrap-token. Gebruik: /setchat <token-uit-serverlogs>.',
        );
        return;
      }
      setAllowedChatId(opts.db, ctx.chat.id);
      bootstrapToken = null;
      await ctx.reply(`Oké, deze chat (id ${ctx.chat.id}) is nu de actieve chat.`);
      return;
    }

    if (current === ctx.chat.id) {
      await ctx.reply('Deze chat is al de actieve chat. Geen wijziging.');
      return;
    }

    // Move path: a different chat redeeming a /movechat token. Anything else
    // is silently ignored — we don't want to confirm to a stranger that
    // there's a bot listening elsewhere.
    if (moveToken === null || Date.now() > moveToken.expiresAt) {
      moveToken = null;
      return;
    }
    if (!tokenMatches(supplied, moveToken.token)) return;

    moveToken = null;
    setAllowedChatId(opts.db, ctx.chat.id);
    console.log(`[telegram] allowed chat moved from ${current} to ${ctx.chat.id}`);
    await ctx.reply(`Oké, deze chat (id ${ctx.chat.id}) is nu de actieve chat.`);
    try {
      await ctx.telegram.sendMessage(
        current,
        'De bot is verhuisd naar een andere chat en reageert hier niet meer.',
      );
    } catch (err) {
      // Best-effort: the old chat may be gone or have blocked the bot.
      console.warn('[telegram] could not notify the previous chat about the move:', err);
    }
  });

  // Guard middleware: everything below this is restricted to the allowed chat.
  // When no chat is configured, we SILENTLY ignore every message except
  // /chatid and /setchat (which are registered above this middleware). That
  // way a random stranger who finds the bot's username can't even tell from
  // the bot's behaviour whether it's unclaimed — they'd need the bootstrap
  // token from the server logs to claim it.
  bot.use(async (ctx, next) => {
    const allowed = getAllowedChatId(opts.db, opts.envAllowedChatId);
    if (allowed === null) return;
    if (ctx.chat?.id !== allowed) return;
    await next();
  });

  // /start, /stop, /status
  bot.command('start', async (ctx) => {
    setBotRunning(opts.db, true);
    await ctx.reply('Bot is actief. Stuur een bericht of vraag om de boodschappen.');
  });

  bot.command('stop', async (ctx) => {
    setBotRunning(opts.db, false);
    await ctx.reply('Bot gepauzeerd. Stuur /start om weer te beginnen.');
  });

  bot.command('status', async (ctx) => {
    const running = isBotRunning(opts.db);
    const spentToday = getTodayApiSpend(opts.db);
    const chatState = getOrCreateChatState(ctx.chat.id);
    await ctx.reply(
      [
        `Status: ${running ? 'actief' : 'gepauzeerd'}`,
        `API-uitgaven vandaag: €${spentToday.toFixed(4)} (limiet €${opts.dailySpendLimitEur.toFixed(2)})`,
        `Dit gesprek: €${chatState.spentEur.toFixed(4)} in ${chatState.steps} stappen`,
        `Auth-flow: ${chatState.authFlow}`,
        `Gespreksgeschiedenis: ${chatState.history.length} berichten`,
      ].join('\n'),
    );
  });

  bot.command('reset', async (ctx) => {
    resetChatHistory(ctx.chat.id);
    await ctx.reply('Gespreksgeschiedenis gewist.');
  });

  bot.command('sms', async (ctx) => {
    const chatState = getOrCreateChatState(ctx.chat.id);
    const reply = await handleSmsCommand(opts.picnic, chatState);
    await ctx.reply(reply);
  });

  // /gluten-log — the human-facing window into how the guard decided. Telegram
  // command names cannot contain a hyphen, so the canonical name is
  // /glutenlog with /gluten_log accepted as an alias.
  const glutenLog = async (ctx: Context): Promise<void> => {
    const decisions = getRecentAllergenDecisions(opts.db, 15);
    const overrides = listAllergenOverrides(opts.db, 20);

    if (decisions.length === 0 && overrides.length === 0) {
      await ctx.reply(
        'Nog geen glutencontroles uitgevoerd. Zodra de assistent producten ' +
          'toevoegt, verschijnt hier per product wat er is besloten en waarom.',
      );
      return;
    }

    const lines: string[] = ['Laatste glutencontroles (nieuwste eerst):', ''];
    for (const d of decisions) {
      const mark = d.verdict === 'blocked' ? '✖' : d.verdict === 'unverified' ? '?' : '✓';
      const name = d.articleName ?? d.articleId;
      lines.push(`${mark} ${name} — ${d.verdict} (${d.decidedBy})`);
      lines.push(`   ${d.reason}`);
      if (d.matchedTerms.length > 0) {
        lines.push(`   regels die aansloegen: ${d.matchedTerms.join(', ')}`);
      }
      if (d.allergens && d.allergens.length > 0) {
        lines.push(`   allergenen volgens Picnic: ${d.allergens.join(', ')}`);
      }
      lines.push(`   ${d.createdAt}`);
      lines.push('');
    }

    if (overrides.length > 0) {
      lines.push('Handmatige uitzonderingen en correcties:');
      for (const o of overrides) {
        const scope = o.scope === 'once' ? 'eenmalig' : 'blijvend';
        lines.push(
          `- ${o.articleName ?? o.articleId}: altijd ${o.verdict} (${scope}) — ${o.reason}`,
        );
      }
      lines.push('');
    }

    lines.push('De regels zelf staan in gluten-rules.md; die kun je zelf aanpassen.');
    await sendChunked(ctx, lines.join('\n'));
  };

  bot.command('glutenlog', glutenLog);
  bot.command('gluten_log', glutenLog);

  // Manually fire the weekly nudge without waiting for Thursday 20:00. The
  // cron firing path is identical to this one, so testing here is a fair
  // proxy for "did the scheduler work" too.
  bot.command('nudge_now', async (ctx) => {
    const text = buildWeeklyNudge({ db: opts.db });
    await ctx.reply(text);
  });

  // Free-text messages. Anything that isn't a command lands here.
  bot.on('message', async (ctx) => {
    // Telegraf's "message" event fires for all message types — only text matters here.
    const message = ctx.message as Message.TextMessage;
    if (typeof message.text !== 'string') return;
    const text = message.text.trim();
    if (text.length === 0) return;
    if (text.startsWith('/')) return; // Commands already handled above.

    const chatState = getOrCreateChatState(ctx.chat.id);

    // SMS-code phase wins over normal processing. If we're waiting for the
    // 6-digit code, treat ANY non-code message as an explicit reminder rather
    // than falling through to the agent — otherwise the user would get a
    // confusing "AuthRequiredError" reply, not realising the bot was still
    // mid-flow.
    if (chatState.authFlow === 'awaiting-sms-code') {
      if (SMS_CODE_REGEX.test(text)) {
        const reply = await handleSmsCode(opts.picnic, chatState, text);
        await sendChunked(ctx, reply);
      } else {
        await ctx.reply(
          'Ik wacht nog op de 6-cijferige SMS-code voor Picnic. Stuur die, ' +
            'of /sms voor een nieuwe code.',
        );
      }
      return;
    }

    // Honour the /stop kill-switch — bot acknowledges but doesn't engage the agent.
    if (!isBotRunning(opts.db)) {
      await ctx.reply('Bot is gepauzeerd (/start om te hervatten).');
      return;
    }

    // First-message welcome if onboarding hasn't run yet.
    if (!isOnboardingDone(opts.db)) {
      await sendOnboardingWelcome(opts.db, (t) => ctx.reply(t).then(() => undefined));
      // Fall through — let the agent reply to whatever the user said.
    }

    const speakerName = ctx.from?.first_name ?? null;
    continueOrStartConversation(ctx.chat.id);

    try {
      const result = await opts.agent.runTurn({
        userMessage: text,
        speakerName,
        history: chatState.history,
      });
      chatState.history = result.updatedHistory;
      chatState.spentEur += result.spentEur;
      chatState.steps += result.apiCallCount;
      await sendChunked(ctx, result.reply);
      const warning = takeBudgetWarning(opts.db, opts.dailySpendLimitEur);
      if (warning) await ctx.reply(warning);
    } catch (err) {
      await handleAgentError(ctx, err);
    }
  });

  // Process-wide unhandled errors from Telegraf itself.
  bot.catch(async (err, ctx) => {
    console.error('[telegram] unhandled error in handler:', err);
    try {
      await ctx.reply('Er ging iets onverwachts mis. Probeer het opnieuw, of /status voor info.');
    } catch {
      // Best-effort — if reply fails too, just log.
    }
  });

  return bot;
}

/**
 * Send a message that may exceed Telegram's 4096-char limit by splitting on
 * paragraph boundaries first, then hard-wrapping if a single paragraph is
 * too long.
 */
async function sendChunked(ctx: Context, text: string): Promise<void> {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    await ctx.reply(text);
    return;
  }
  for (const chunk of splitForTelegram(text)) {
    await ctx.reply(chunk);
  }
}

function splitForTelegram(text: string): string[] {
  const chunks: string[] = [];
  let buffer = '';
  // Prefer splits at blank lines, then single newlines, then hard cuts.
  for (const block of text.split(/\n\n+/)) {
    if (buffer.length + block.length + 2 <= SAFE_CHUNK_LENGTH) {
      buffer = buffer ? `${buffer}\n\n${block}` : block;
      continue;
    }
    if (buffer) {
      chunks.push(buffer);
      buffer = '';
    }
    if (block.length <= SAFE_CHUNK_LENGTH) {
      buffer = block;
    } else {
      for (let i = 0; i < block.length; i += SAFE_CHUNK_LENGTH) {
        chunks.push(block.slice(i, i + SAFE_CHUNK_LENGTH));
      }
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

/**
 * Translate agent / Picnic / Anthropic errors into a Dutch chat message and
 * (where appropriate) flip the bot into a known recovery state.
 */
async function handleAgentError(ctx: Context, err: unknown): Promise<void> {
  if (err instanceof AuthRequiredError) {
    await ctx.reply(AUTH_REQUIRED_PROMPT);
    return;
  }
  if (err instanceof DailySpendCapExceededError) {
    await ctx.reply(err.message);
    return;
  }
  if (err instanceof IterationCapExceededError) {
    await ctx.reply(
      'Er ging iets mis tijdens je vraag (te veel tool-aanroepen). Probeer het ' +
        'in kleinere stappen — of stuur /reset om de gespreksgeschiedenis te wissen.',
    );
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[telegram] agent error:', err);
  await ctx.reply(`Er ging iets onverwachts mis: ${msg}. Probeer het opnieuw of stuur /status.`);
}
