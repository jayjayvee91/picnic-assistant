/**
 * Cron wiring for the incremental order-history sync.
 *
 * Runs in the same Node process as the Telegram bot and the weekly nudge, so
 * there's still no separate scheduler service to operate.
 *
 * Two deliberate differences from the weekly nudge:
 *
 *   1. It does NOT check the `bot_running` flag. That pause exists so a
 *      `/stop` doesn't spam a paused chat — the nudge's own comment says as
 *      much. A sync sends no message and spends no Anthropic tokens; it is
 *      pure Picnic HTTP. Skipping it while paused would mean coming back from
 *      a weekend `/stop` to exactly the stale history this job exists to fix.
 *
 *   2. It can run once at startup. A deploy restarts the service, so a fresh
 *      release brings the history up to date immediately instead of waiting
 *      for the next 03:30.
 */

import { Cron } from 'croner';
import { syncRecentOrders, type DB } from '../memory/index.js';
import type { PicnicClient } from '../picnic/index.js';

/** Default fire time: every day at 03:30 Europe/Amsterdam. */
export const ORDER_SYNC_PATTERN = '30 3 * * *';
export const ORDER_SYNC_TIMEZONE = 'Europe/Amsterdam';

/** Delay before the optional startup sync, giving the bot time to launch. */
const STARTUP_DELAY_MS = 5_000;

export interface OrderSyncOptions {
  db: DB;
  picnic: PicnicClient;
  /** Override the cron expression (e.g. for tests). */
  pattern?: string;
  /** Override the timezone (rarely useful). */
  timezone?: string;
  /** Run one sync shortly after startup. Defaults to true. */
  runOnStart?: boolean;
}

/** Stops the schedule and cancels a pending startup run. */
export interface OrderSyncHandle {
  stop(): void;
}

/**
 * A sync walks deliveries sequentially with a throttle, so a slow run could
 * still be going when the next trigger arrives — or when the startup run and
 * the daily schedule land close together. Overlapping runs would double the
 * calls to Picnic for no benefit, so a second one is skipped rather than
 * queued: whatever it would have fetched, the next run picks up anyway.
 */
let syncInFlight = false;

export function startOrderSync(opts: OrderSyncOptions): OrderSyncHandle {
  const job = new Cron(
    opts.pattern ?? ORDER_SYNC_PATTERN,
    { timezone: opts.timezone ?? ORDER_SYNC_TIMEZONE, name: 'order-sync' },
    async () => {
      await fireOrderSync(opts);
    },
  );

  const nextRun = job.nextRun();
  if (nextRun) {
    console.log(
      `[scheduler] order sync scheduled — first fire: ${nextRun.toISOString()} ` +
        `(${opts.timezone ?? ORDER_SYNC_TIMEZONE})`,
    );
  } else {
    console.warn('[scheduler] order sync scheduled but next-run could not be computed.');
  }

  let startupTimer: NodeJS.Timeout | null = null;
  if (opts.runOnStart !== false) {
    startupTimer = setTimeout(() => {
      startupTimer = null;
      void fireOrderSync(opts);
    }, STARTUP_DELAY_MS);
    // Don't hold the event loop open on account of a pending catch-up sync.
    startupTimer.unref();
  }

  return {
    stop(): void {
      if (startupTimer !== null) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      job.stop();
    },
  };
}

/**
 * Run one sync. Exported so an operator command (e.g. a future `/sync_now`)
 * can reuse it without duplicating the guard and logging.
 *
 * Never throws: a Picnic outage must not take down the bot process that this
 * job happens to share.
 */
export async function fireOrderSync(opts: OrderSyncOptions): Promise<void> {
  if (syncInFlight) {
    console.log('[scheduler] order sync already running; skipping this trigger.');
    return;
  }

  syncInFlight = true;
  try {
    const result = await syncRecentOrders(opts.db, opts.picnic);
    if (result.ordersRecorded === 0 && result.deliveriesFailed === 0) {
      console.log(
        `[scheduler] order sync: nothing new since ${result.cutoff} ` +
          `(${result.deliveriesConsidered} deliveries checked).`,
      );
    } else {
      console.log(
        `[scheduler] order sync: recorded ${result.ordersRecorded} order(s), ` +
          `${result.itemsRecorded} item(s), ${result.deliveriesFailed} failed ` +
          `(${result.deliveriesConsidered} deliveries checked since ${result.cutoff}).`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] order sync failed: ${msg}`);
    // No retry — same reasoning as the nudge. If Picnic is down right now,
    // hammering it won't help, and the next run is at most a day away.
  } finally {
    syncInFlight = false;
  }
}
