/**
 * Cron wiring for the weekly Thursday nudge.
 *
 * Uses `croner` — zero-dependency, modern, timezone-aware. DST in
 * Europe/Amsterdam is handled automatically: 20:00 CET in winter, 20:00 CEST
 * in summer, both correct.
 *
 * The cron job is owned by the same Node process as the Telegram bot, so
 * there's no separate scheduler service to operate. When the user `/stops`
 * the bot, the cron *still fires* — but the post itself checks the
 * `bot_running` flag and skips if paused. That way a "pause for the weekend"
 * doesn't permanently miss a Thursday, but it doesn't spam a paused bot
 * either.
 */

import { Cron } from 'croner';
import type { Telegraf } from 'telegraf';
import type { DB } from '../memory/index.js';
import { isBotRunning, getAllowedChatId } from '../telegram/index.js';
import { buildWeeklyNudge } from './nudge.js';

/** Default fire time: Thursday 20:00 Europe/Amsterdam. */
export const WEEKLY_NUDGE_PATTERN = '0 20 * * 4';
export const WEEKLY_NUDGE_TIMEZONE = 'Europe/Amsterdam';

export interface WeeklyNudgeOptions {
  bot: Telegraf;
  db: DB;
  envAllowedChatId: string | null;
  /** Override the cron expression (e.g. for tests). */
  pattern?: string;
  /** Override the timezone (rarely useful). */
  timezone?: string;
}

/**
 * Start the weekly Thursday-evening cron. Returns the running `Cron` handle
 * so the caller can `.stop()` it during graceful shutdown.
 */
export function startWeeklyNudge(opts: WeeklyNudgeOptions): Cron {
  const job = new Cron(
    opts.pattern ?? WEEKLY_NUDGE_PATTERN,
    { timezone: opts.timezone ?? WEEKLY_NUDGE_TIMEZONE, name: 'weekly-nudge' },
    async () => {
      await fireWeeklyNudge(opts);
    },
  );

  const nextRun = job.nextRun();
  if (nextRun) {
    console.log(
      `[scheduler] weekly nudge scheduled — first fire: ${nextRun.toISOString()} ` +
        `(${opts.timezone ?? WEEKLY_NUDGE_TIMEZONE})`,
    );
  } else {
    console.warn('[scheduler] weekly nudge scheduled but next-run could not be computed.');
  }

  return job;
}

/**
 * Send the nudge once. Exported so a future operator command (e.g.
 * `/nudge_now` for debugging) can reuse it without duplicating logic.
 */
export async function fireWeeklyNudge(opts: WeeklyNudgeOptions): Promise<void> {
  const chatId = getAllowedChatId(opts.db, opts.envAllowedChatId);
  if (chatId === null) {
    console.warn('[scheduler] no allowed chat id configured; skipping weekly nudge.');
    return;
  }
  if (!isBotRunning(opts.db)) {
    console.log('[scheduler] bot is paused (/stop); skipping weekly nudge.');
    return;
  }

  const text = buildWeeklyNudge({ db: opts.db });
  try {
    await opts.bot.telegram.sendMessage(chatId, text);
    console.log('[scheduler] weekly nudge sent.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] weekly nudge failed to send: ${msg}`);
    // No retry — per the cost-runaway design, a single failure logs and stops.
    // The nudge will fire again next Thursday; if Telegram is down right now,
    // hammering it won't help.
  }
}
