/**
 * Incremental order-history sync.
 *
 * The one-time backfill in `bootstrap.ts` is gated behind a `meta` flag and is
 * only ever invoked by hand (`npm run smoke:memory`). Nothing in the running
 * bot wrote to `orders` after that first run, so the purchase summary the
 * agent sees froze at whenever the operator last ran the backfill. This module
 * is the recurring counterpart: cheap, idempotent, and safe to run on a timer.
 *
 * How it stays cheap:
 *   - The newest stored `creation_time` is the watermark. We only pull detail
 *     for deliveries at or after it, so a typical run fetches zero or one
 *     delivery rather than walking six months of history.
 *   - An overlap window before the watermark is re-fetched deliberately.
 *     Picnic finalises an order at delivery time (substitutions, weighted
 *     items, refunds), so an order we recorded on Monday can legitimately
 *     change by Wednesday. `recordOrder` upserts by `order_id`, so re-recording
 *     costs one HTTP call and converges to the corrected row.
 *
 * Scope note: this syncs COMPLETED deliveries only. Including `CURRENT` would
 * let the bot see an in-flight order, but a cancelled order would then lodge in
 * the database forever — nothing in the codebase deletes an order, so it would
 * sit there as a shop that never happened, quietly inflating the averages the
 * summary is built from. Doing that properly needs a delete path plus a
 * `products_seen` recount, which is deliberately left for a follow-up.
 */

import type { PicnicClient } from '../picnic/index.js';
import type { DB } from './db.js';
import { flattenDelivery } from './flatten.js';
import { getNewestOrderCreationTime, recordOrder } from './repository.js';
import { recomputeAndStoreSummary } from './summary.js';

export interface SyncOptions {
  /**
   * How far back before the watermark to re-check, catching orders Picnic
   * finalised after we first recorded them. Defaults to 3 days.
   */
  overlapDays?: number;
  /**
   * Window used when the `orders` table is empty. Kept short on purpose: a
   * cold start is the backfill's job, not this one's, and we don't want a
   * timer quietly firing a six-month walk on the production box.
   */
  coldStartLookbackDays?: number;
  /** Milliseconds to wait between detail fetches. */
  throttleMs?: number;
}

export interface SyncResult {
  /** Deliveries at or after the cutoff — i.e. the ones we fetched detail for. */
  deliveriesConsidered: number;
  ordersRecorded: number;
  itemsRecorded: number;
  /** Deliveries that failed mid-walk and were skipped. */
  deliveriesFailed: number;
  /** The ISO cutoff actually used this run. */
  cutoff: string;
  /** True when `orders` was empty and we fell back to the cold-start window. */
  coldStart: boolean;
}

const DEFAULT_OVERLAP_DAYS = 3;
const DEFAULT_COLD_START_LOOKBACK_DAYS = 30;
const DEFAULT_THROTTLE_MS = 250;

export async function syncRecentOrders(
  db: DB,
  picnic: PicnicClient,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const overlapDays = opts.overlapDays ?? DEFAULT_OVERLAP_DAYS;
  const coldStartLookbackDays = opts.coldStartLookbackDays ?? DEFAULT_COLD_START_LOOKBACK_DAYS;
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;

  const watermark = getNewestOrderCreationTime(db);
  const parsedWatermark = watermark === null ? NaN : Date.parse(watermark);
  // A stored-but-unparseable timestamp would otherwise produce a NaN cutoff,
  // which every comparison below fails — silently syncing nothing forever.
  const coldStart = !Number.isFinite(parsedWatermark);

  const cutoffMs = coldStart
    ? Date.now() - coldStartLookbackDays * 86_400_000
    : parsedWatermark - overlapDays * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString();

  if (coldStart) {
    console.warn(
      `[sync] no usable order watermark; falling back to the last ${coldStartLookbackDays} days. ` +
        `If this is a fresh install, run the backfill (npm run smoke:memory) for full history.`,
    );
  }

  const deliveries = await picnic.getDeliveries(['COMPLETED']);
  const candidates = deliveries.filter((d) => {
    const created = Date.parse(d.creation_time);
    return Number.isFinite(created) && created >= cutoffMs;
  });

  let ordersRecorded = 0;
  let itemsRecorded = 0;
  let deliveriesFailed = 0;

  for (let i = 0; i < candidates.length; i++) {
    const delivery = candidates[i];
    if (!delivery) continue;

    // Per-delivery try/catch: one failed `getDelivery` shouldn't abort the
    // walk or the summary recompute. The watermark doesn't advance past a
    // failure, so the next run picks it up again.
    try {
      const detail = await picnic.getDelivery(delivery.delivery_id);
      for (const order of flattenDelivery(detail, delivery)) {
        recordOrder(db, order);
        ordersRecorded += 1;
        itemsRecorded += order.items.length;
      }
    } catch (err) {
      deliveriesFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[sync] skipping delivery ${delivery.delivery_id}: ${msg}`);
    }

    if (i < candidates.length - 1 && throttleMs > 0) {
      await sleep(throttleMs);
    }
  }

  // Only recompute when something actually landed. The common case is a run
  // that finds nothing new, and there's no point rebuilding the summary — and
  // rewriting its `meta` row — to arrive at the same answer.
  if (ordersRecorded > 0) {
    recomputeAndStoreSummary(db);
  }

  return {
    deliveriesConsidered: candidates.length,
    ordersRecorded,
    itemsRecorded,
    deliveriesFailed,
    cutoff,
    coldStart,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
