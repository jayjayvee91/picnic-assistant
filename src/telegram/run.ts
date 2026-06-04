/**
 * Telegram runtime entry point.
 *
 * Run with:
 *   npm run start:telegram
 *
 * What it does:
 *   1. Loads env, opens SQLite, restores the Picnic session.
 *   2. Constructs the agent loop (same `AgentLoop` the smoke uses).
 *   3. Starts the Telegram bot in long-polling mode.
 *   4. Handles SIGINT cleanly so we don't leave a stale Telegram polling
 *      connection hanging on Ctrl+C.
 *
 * This is the v1 production runtime. Step 7 wires the weekly nudge into the
 * same process; Step 9 puts it behind systemd on a VPS.
 */

import 'dotenv/config';
import { join } from 'node:path';
import { PicnicClient, type PicnicCountryCode } from '../picnic/index.js';
import { openDatabase, ensureProfileSeeded, type DB } from '../memory/index.js';
import { AgentAnthropicClient, AgentLoop, type AgentContext } from '../agent/index.js';
import { startWeeklyNudge } from '../scheduler/index.js';
import { createBot } from './bot.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const username = requireEnv('PICNIC_USERNAME');
  const password = requireEnv('PICNIC_PASSWORD');
  const anthropicKey = requireEnv('ANTHROPIC_API_KEY');
  const telegramToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const envChatId = process.env['TELEGRAM_ALLOWED_CHAT_ID'] ?? null;

  const model = process.env['ANTHROPIC_MODEL'] ?? 'claude-sonnet-4-5-20250929';
  const dailyLimit = Number(process.env['DAILY_SPEND_LIMIT_EUR'] ?? '2');
  const dataDir = process.env['DATA_DIR'] ?? './data';
  const sessionFile = process.env['PICNIC_SESSION_FILE'] ?? join(dataDir, 'picnic-session.json');
  const dbPath = join(dataDir, 'data.db');
  const profilePath = join(dataDir, 'profile.md');
  const dryRun = process.env['DRY_RUN'] !== 'false';

  const db: DB = openDatabase(dbPath);
  await ensureProfileSeeded(profilePath);

  const picnic = new PicnicClient({
    username,
    password,
    countryCode: (process.env['PICNIC_COUNTRY_CODE'] ?? 'NL') as PicnicCountryCode,
    sessionFile,
    dryRun,
  });

  const restored = await picnic.restoreSession();
  if (!restored) {
    console.error('No Picnic session on disk. Run `npm run smoke:picnic` first to authenticate.');
    process.exit(2);
  }

  const anthropic = new AgentAnthropicClient({ apiKey: anthropicKey, model });

  const ctx: AgentContext = {
    db,
    picnic,
    profilePath,
    conversationKey: 'telegram-main',
    proposedProfileAdditions: new Map(),
  };

  const agent = new AgentLoop({
    ctx,
    anthropic,
    profilePath,
    dailySpendLimitEur: Number.isFinite(dailyLimit) ? dailyLimit : 2,
  });

  const bot = createBot({
    token: telegramToken,
    db,
    picnic,
    agent,
    envAllowedChatId: envChatId,
  });

  // Start the weekly Thursday-20:00 cron in the same process so we don't
  // need a separate service. The job no-ops when the bot is /stopped.
  const nudgeJob = startWeeklyNudge({
    bot,
    db,
    envAllowedChatId: envChatId,
  });

  // Graceful shutdown so Telegram releases the long-poll on exit.
  const stop = (signal: string): void => {
    console.log(`[telegram] received ${signal}, stopping bot…`);
    nudgeJob.stop();
    bot.stop(signal);
    db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  console.log(`[telegram] starting bot (DRY_RUN=${dryRun}, model=${model})…`);
  console.log(`[telegram] daily spend cap: €${dailyLimit.toFixed(2)}`);
  console.log(
    '[telegram] if no chat is set yet, message the bot with /chatid then /setchat in the chat you want to use.',
  );

  await bot.launch();
  console.log('[telegram] bot stopped.');
}

main().catch((err) => {
  console.error('Telegram runtime failed:');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
