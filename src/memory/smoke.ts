/**
 * Manual smoke test for the memory layer.
 *
 * Run with:
 *   npm run smoke:memory
 *
 * What it does:
 *   1. Opens the SQLite database at `DATA_DIR/data.db`.
 *   2. Restores the saved Picnic session (no SMS prompt — that lives in
 *      `smoke:picnic`).
 *   3. Runs the one-time bootstrap (idempotent) — pulls the last 6 months of
 *      order history from Picnic and stores it.
 *   4. Prints summary statistics: how many orders were stored, how many
 *      distinct items, average days between deliveries, top-N typical basket.
 *   5. Writes a backup snapshot to confirm the backup pipeline works.
 *
 * Safe to re-run: the bootstrap is gated by a meta flag and `recordOrder` is
 * upsert-by-order-id. Re-running is a no-op unless you pass `--force`.
 */

import 'dotenv/config';
import { join } from 'node:path';
import { PicnicClient } from '../picnic/index.js';
import {
  openDatabase,
  runBootstrap,
  recomputeAndStoreSummary,
  loadStoredSummary,
  backupDatabase,
} from './index.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  const username = requireEnv('PICNIC_USERNAME');
  const password = requireEnv('PICNIC_PASSWORD');
  const dataDir = process.env['DATA_DIR'] ?? './data';
  const sessionFile = process.env['PICNIC_SESSION_FILE'] ?? join(dataDir, 'picnic-session.json');
  const dbPath = join(dataDir, 'data.db');
  const backupDir = join(dataDir, 'backups');

  console.log(`Data dir: ${dataDir}`);
  console.log(`DB: ${dbPath}`);
  console.log(force ? 'Force mode: bootstrap will run even if already done.' : '');

  // 1. Open DB and restore Picnic session.
  const db = openDatabase(dbPath);
  const picnic = new PicnicClient({
    username,
    password,
    countryCode: (process.env['PICNIC_COUNTRY_CODE'] ?? 'NL') as 'NL' | 'DE' | 'FR',
    sessionFile,
    dryRun: true,
  });

  const restored = await picnic.restoreSession();
  if (!restored) {
    console.error('No Picnic session on disk. Run `npm run smoke:picnic` first to authenticate.');
    process.exit(2);
  }

  // 2. Run bootstrap.
  console.log('Running bootstrap…');
  let lastReportedPct = -1;
  const result = await runBootstrap(db, picnic, {
    force,
    onProgress: (processed, total) => {
      const pct = Math.floor((processed / total) * 100);
      if (pct !== lastReportedPct && pct % 10 === 0) {
        console.log(`  …${processed}/${total} (${pct}%)`);
        lastReportedPct = pct;
      }
    },
  });

  if (result.status === 'skipped') {
    console.log('Bootstrap already done — skipped. Pass --force to re-run.');
  } else {
    console.log(
      `Bootstrap complete: ${result.ordersRecorded} orders, ${result.itemsRecorded} items, ` +
        `from ${result.windowStart.slice(0, 10)} to ${result.windowEnd.slice(0, 10)}.`,
    );
    if (result.deliveriesFailed > 0) {
      console.warn(
        `  ${result.deliveriesFailed} delivery detail fetch(es) failed and were skipped — ` +
          `re-run to backfill them.`,
      );
    }
    if (result.ordersRecorded === 0 && result.totalDeliveriesConsidered === 0) {
      console.log('  (No completed orders in the lookback window — flag left unset.)');
    }
  }

  // 3. Print the purchase summary (recompute either way so we always see fresh stats).
  recomputeAndStoreSummary(db);
  const summary = loadStoredSummary(db);
  if (!summary) {
    console.error('No summary available after recompute — something is wrong.');
    process.exit(3);
  }

  console.log('');
  console.log('=== Purchase summary ===');
  console.log(`Orders considered: ${summary.ordersCount}`);
  console.log(`Last order:        ${summary.lastOrderAt ?? '(none)'}`);
  console.log(
    `Avg interval:      ${summary.avgIntervalDays === null ? '(insufficient data)' : `${summary.avgIntervalDays} days`}`,
  );
  console.log('');
  console.log('Top 10 most-frequently-ordered articles:');
  for (const entry of summary.typicalBasket.slice(0, 10)) {
    const unit = entry.unitQuantity ? ` (${entry.unitQuantity})` : '';
    console.log(
      `  ${entry.timesOrdered.toString().padStart(3)}× ` +
        `${entry.name}${unit} — avg ${entry.avgQuantityPerOrder} per order`,
    );
  }

  // 4. Smoke-test the backup pipeline.
  console.log('');
  console.log('Writing backup snapshot…');
  const backup = await backupDatabase(db, { backupDir, keep: 14 });
  console.log(
    `Backup OK: ${backup.path} (${(backup.bytes / 1024).toFixed(1)} KB). ` +
      `Pruned ${backup.removedOldBackups} old file(s).`,
  );

  console.log('');
  console.log('Memory smoke test OK.');
}

main().catch((err) => {
  console.error('Memory smoke test failed:');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
