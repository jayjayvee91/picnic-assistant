/**
 * Manual smoke test for the Picnic adapter.
 *
 * Run with:
 *   npm run smoke:picnic
 *
 * What it does:
 *   1. Loads `.env` (must contain PICNIC_USERNAME, PICNIC_PASSWORD).
 *   2. Tries to restore an existing session from `DATA_DIR/picnic-session.json`.
 *   3. If no session, logs in. If Picnic requires 2FA, requests an SMS code
 *      and prompts you to paste it back.
 *   4. Fetches your last completed deliveries to confirm reads work.
 *   5. Prints a count and the most recent delivery date.
 *
 * No writes are performed (no addToCart, no slot reservation). Safe to run
 * against your real Picnic account.
 *
 * It is NOT part of the bot runtime — it lives here so we can verify the
 * adapter end-to-end with real credentials and a real SMS code before
 * wiring anything else.
 */

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PicnicClient } from './client.js';
import { AuthRequiredError, TwoFactorRequiredError } from './errors.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    console.error(`Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const username = requireEnv('PICNIC_USERNAME');
  const password = requireEnv('PICNIC_PASSWORD');
  const dataDir = process.env['DATA_DIR'] ?? './data';
  const sessionFile = process.env['PICNIC_SESSION_FILE'] ?? `${dataDir}/picnic-session.json`;
  const countryCode = (process.env['PICNIC_COUNTRY_CODE'] ?? 'NL') as 'NL' | 'DE' | 'FR';

  const client = new PicnicClient({
    username,
    password,
    countryCode,
    sessionFile,
    dryRun: true, // smoke test never writes; this is a belt-and-braces guard
  });

  // 1. Try to restore an existing session.
  const restored = await client.restoreSession();
  if (restored) {
    console.log('Restored session from disk — skipping login.');
  } else {
    console.log('No saved session. Logging in fresh…');
    try {
      await client.login();
      console.log('Login OK without 2FA (unusual but allowed).');
    } catch (err) {
      if (!(err instanceof TwoFactorRequiredError)) throw err;
      console.log('Picnic requires 2FA. Requesting an SMS code now…');
      await client.requestSmsCode();
      const code = await prompt('Enter the 6-digit SMS code: ');
      if (!/^\d{6}$/.test(code)) {
        console.error('That does not look like a 6-digit code. Aborting.');
        process.exit(1);
      }
      await client.verifyTwoFactorCode(code);
      console.log('2FA verified. Session persisted.');
    }
  }

  // 2. Verify reads work by fetching past deliveries.
  try {
    const deliveries = await client.getDeliveries(['COMPLETED']);
    console.log(`Found ${deliveries.length} completed deliveries.`);
    if (deliveries.length > 0) {
      const mostRecent = deliveries[0];
      // `slot.window_start` is the human-readable delivery window start.
      // The exact field name may vary; print the whole top-level keys to help
      // confirm shape on first run.
      console.log('Most recent delivery (top-level keys):', Object.keys(mostRecent ?? {}));
    }
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      console.error('Saved session is expired. Delete the session file and re-run.');
      process.exit(2);
    }
    throw err;
  }

  console.log('Smoke test OK.');
}

main().catch((err) => {
  console.error('Smoke test failed:');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
