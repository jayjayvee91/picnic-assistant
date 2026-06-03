/**
 * One-time order-history backfill.
 *
 * On first run, walks the user's Picnic delivery history, pulls the detail
 * of each delivery within the look-back window, flattens it to our schema,
 * and writes it via `recordOrder`. Then recomputes the purchase summary.
 *
 * Idempotent and safely resumable:
 *   - The `meta.bootstrap_completed` flag gates re-runs. We never run a
 *     full backfill twice unless the operator explicitly forces it.
 *   - `recordOrder` upserts by `order_id`, so even a forced re-run would
 *     converge to the same state rather than duplicate rows.
 *
 * Polite to Picnic:
 *   - Sequential detail fetches with a small throttle between calls so we
 *     don't burst hundreds of requests in a second.
 *   - On a transient failure mid-walk we stop, leaving partial progress
 *     in the DB; the next run will pick up where we left off.
 */

import type { Delivery, DeliveryDetail, PicnicClient } from '../picnic/index.js';
import type { DB } from './db.js';
import { recordOrder, getMeta, setMeta, type OrderRecord } from './repository.js';
import { recomputeAndStoreSummary } from './summary.js';

const BOOTSTRAP_FLAG = 'bootstrap_completed';

export interface BootstrapOptions {
  /** Cutoff for how far back we backfill. Defaults to ~6 months. */
  lookbackDays?: number;
  /** Milliseconds to wait between detail fetches. */
  throttleMs?: number;
  /** If true, ignore the `bootstrap_completed` flag and run again. */
  force?: boolean;
  /** Progress reporter — receives a count after every delivery processed. */
  onProgress?: (processed: number, total: number) => void;
}

export interface BootstrapResult {
  status: 'completed' | 'skipped';
  totalDeliveriesConsidered: number;
  ordersRecorded: number;
  itemsRecorded: number;
  windowStart: string;
  windowEnd: string;
}

const DEFAULT_LOOKBACK_DAYS = 183; // ~6 months
const DEFAULT_THROTTLE_MS = 250;

export async function runBootstrap(
  db: DB,
  picnic: PicnicClient,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;

  if (!opts.force && getMeta(db, BOOTSTRAP_FLAG) === 'true') {
    return {
      status: 'skipped',
      totalDeliveriesConsidered: 0,
      ordersRecorded: 0,
      itemsRecorded: 0,
      windowStart: '',
      windowEnd: '',
    };
  }

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - lookbackDays * 86_400_000);

  const deliveries = await picnic.getDeliveries(['COMPLETED']);
  const inWindow = deliveries.filter((d) => {
    const created = Date.parse(d.creation_time);
    return Number.isFinite(created) && created >= windowStart.getTime();
  });

  let ordersRecorded = 0;
  let itemsRecorded = 0;

  for (let i = 0; i < inWindow.length; i++) {
    const delivery = inWindow[i];
    if (!delivery) continue;

    const detail = await picnic.getDelivery(delivery.delivery_id);
    const flattened = flattenDelivery(detail, delivery);
    for (const order of flattened) {
      recordOrder(db, order);
      ordersRecorded += 1;
      itemsRecorded += order.items.length;
    }
    opts.onProgress?.(i + 1, inWindow.length);
    if (i < inWindow.length - 1 && throttleMs > 0) {
      await sleep(throttleMs);
    }
  }

  recomputeAndStoreSummary(db);
  setMeta(db, BOOTSTRAP_FLAG, 'true');

  return {
    status: 'completed',
    totalDeliveriesConsidered: inWindow.length,
    ordersRecorded,
    itemsRecorded,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  };
}

/**
 * Translate a Picnic `DeliveryDetail` into our internal `OrderRecord`s.
 * A Delivery usually contains exactly one Order; we still handle N for safety.
 *
 * For each `OrderLine`, Picnic represents quantity by repeating the
 * `OrderArticle` in `items[]` (e.g. ordering 3 cartons → 3 entries). We
 * collapse this to `{ articleId, quantity, ... }` in our schema.
 */
function flattenDelivery(detail: DeliveryDetail, slim: Delivery): OrderRecord[] {
  const windowStart = slim.slot?.window_start ?? null;
  const windowEnd = slim.slot?.window_end ?? null;

  return detail.orders.map((order) => {
    const byArticle = new Map<
      string,
      { name: string; unitQuantity: string | null; quantity: number; pricePerArticleCents: number }
    >();

    for (const line of order.items) {
      const articles = line.items ?? [];
      for (const article of articles) {
        const existing = byArticle.get(article.id);
        if (existing) {
          existing.quantity += 1;
        } else {
          byArticle.set(article.id, {
            name: article.name,
            unitQuantity: article.unit_quantity ?? null,
            quantity: 1,
            // Picnic's `price` on the article is per-unit in cents.
            pricePerArticleCents: article.price ?? 0,
          });
        }
      }
    }

    const items = [...byArticle.entries()].map(([articleId, info]) => ({
      articleId,
      articleName: info.name,
      unitQuantity: info.unitQuantity,
      quantity: info.quantity,
      priceCents: info.pricePerArticleCents,
    }));

    return {
      orderId: order.id,
      deliveryId: slim.delivery_id,
      creationTime: order.creation_time,
      deliveryWindowStart: windowStart,
      deliveryWindowEnd: windowEnd,
      status: order.status,
      totalPriceCents: order.total_price ?? 0,
      totalSavingsCents: order.total_savings ?? 0,
      items,
    };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
