/**
 * Interactive smoke test for the agent layer.
 *
 * Run with:
 *   npm run smoke:agent
 *
 * What it does:
 *   1. Loads env, opens SQLite, restores the Picnic session from Step 2,
 *      ensures `profile.md` exists.
 *   2. Drops you into a REPL where every line you type becomes a user turn
 *      to the agent. The bot's Dutch reply is printed back.
 *   3. Per-turn cost and tool-call count are shown so you can spot runaways.
 *   4. `DRY_RUN=true` (the default in .env.example) means Picnic writes are
 *      no-ops — safe to experiment with "voeg X toe" without affecting your
 *      real cart.
 *
 * This is NOT the production runtime — Step 6 wires the same `AgentLoop`
 * to Telegram. The smoke is purely a fast way for Jeroen to talk to the bot
 * from the terminal.
 *
 * To exit: press Ctrl+C, or send EOF (Ctrl+Z on Windows then Enter).
 */

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.mjs';

import { PicnicClient } from '../picnic/index.js';
import { openDatabase, ensureProfileSeeded, type DB } from '../memory/index.js';
import {
  AgentAnthropicClient,
  AgentLoop,
  DailySpendCapExceededError,
  IterationCapExceededError,
} from './index.js';
import type { AgentContext } from './index.js';

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
    countryCode: (process.env['PICNIC_COUNTRY_CODE'] ?? 'NL') as 'NL' | 'DE' | 'FR',
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
    conversationKey: 'smoke',
    proposedProfileAdditions: new Map(),
  };

  const loop = new AgentLoop({
    ctx,
    anthropic,
    profilePath,
    dailySpendLimitEur: Number.isFinite(dailyLimit) ? dailyLimit : 2,
  });

  // ── Banner ─────────────────────────────────────────────────────────
  console.log(`Picnic Assistant smoke test (DRY_RUN=${dryRun}).`);
  console.log(`Model: ${model}. Daily cap: €${dailyLimit.toFixed(2)}.`);
  console.log(`Type een bericht in het Nederlands. Ctrl+C om te stoppen.`);
  console.log('');

  const rl = createInterface({ input: stdin, output: stdout });
  const history: MessageParam[] = [];
  let totalSpent = 0;

  try {
    while (true) {
      const userMessage = (await rl.question('jij> ')).trim();
      if (userMessage.length === 0) continue;
      if (userMessage === '/quit' || userMessage === '/exit') break;

      try {
        const result = await loop.runTurn({
          userMessage,
          speakerName: 'Jeroen',
          history,
        });
        console.log(`\nbot> ${result.reply}\n`);
        console.log(
          `(€${result.spentEur.toFixed(4)} deze beurt, ${result.toolCallCount} tool calls, ` +
            `€${(totalSpent += result.spentEur).toFixed(4)} totaal)\n`,
        );
        // Adopt the loop's updated conversation as our new baseline.
        history.length = 0;
        history.push(...result.updatedHistory);
      } catch (err) {
        if (err instanceof DailySpendCapExceededError) {
          console.error(`\n${err.message}\n`);
          break;
        }
        if (err instanceof IterationCapExceededError) {
          console.error(`\n${err.message}\n`);
          // Continue the REPL — user can try a different message.
          continue;
        }
        console.error('\nUnexpected error:', err instanceof Error ? err.message : err, '\n');
        // For other errors, exit fast per "no auto-retries" rule.
        break;
      }
    }
  } finally {
    rl.close();
    db.close();
  }

  console.log(`\nKlaar. Totaal vandaag: €${totalSpent.toFixed(4)} op deze sessie.`);
}

main().catch((err) => {
  console.error('Agent smoke test failed:');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
