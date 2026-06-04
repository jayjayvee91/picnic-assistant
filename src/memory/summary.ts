/**
 * Purchase summary.
 *
 * Computes a small JSON blob that the agent's system prompt embeds every turn:
 *   - typical basket: top-N most frequently ordered articles + how often
 *   - average interval between deliveries (helps the bot reason about "due for…")
 *
 * Recomputed after every order is recorded — cheap (two aggregate queries).
 * Stored in the `meta` table under `purchase_summary_json` so the agent can
 * load it without a fresh aggregation per request.
 *
 * Intentionally NOT a vector store, NOT a similarity index. The plan was
 * explicit: a few hundred rows of human-scale shopping fit in Claude's prompt
 * with room to spare. We summarise to keep the prompt small and the cache hot.
 */

import type { DB } from './db.js';
import { setMeta } from './repository.js';

export interface PurchaseSummary {
  /** When this summary was computed (ISO). */
  computedAt: string;
  /** Total number of orders considered. */
  ordersCount: number;
  /** Average days between deliveries, or null when fewer than 2 orders. */
  avgIntervalDays: number | null;
  /** ISO date of the most recent order, or null. */
  lastOrderAt: string | null;
  /** Most frequently ordered articles, descending. */
  typicalBasket: TypicalBasketEntry[];
}

export interface TypicalBasketEntry {
  articleId: string;
  name: string;
  unitQuantity: string | null;
  timesOrdered: number;
  /** Mean count per order in which the article appears. */
  avgQuantityPerOrder: number;
  /** Last seen ISO timestamp. */
  lastSeenAt: string;
}

const DEFAULT_TOP_N = 30;
const META_KEY = 'purchase_summary_json';

/**
 * Recompute the summary from canonical tables and persist it under
 * `meta.purchase_summary_json`. Returns the freshly computed value.
 */
export function recomputeAndStoreSummary(db: DB, topN = DEFAULT_TOP_N): PurchaseSummary {
  const summary = computeSummary(db, topN);
  setMeta(db, META_KEY, JSON.stringify(summary));
  return summary;
}

/** Load a previously stored summary. Null if it hasn't been computed yet. */
export function loadStoredSummary(db: DB): PurchaseSummary | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.value) as PurchaseSummary;
}

function computeSummary(db: DB, topN: number): PurchaseSummary {
  const ordersAgg = db
    .prepare(
      `SELECT
         COUNT(*)                       AS orders_count,
         MAX(creation_time)             AS last_order_at,
         MIN(creation_time)             AS first_order_at
       FROM orders`,
    )
    .get() as {
    orders_count: number;
    last_order_at: string | null;
    first_order_at: string | null;
  };

  const avgIntervalDays = computeAvgIntervalDays(
    ordersAgg.orders_count,
    ordersAgg.first_order_at,
    ordersAgg.last_order_at,
  );

  // The correlated subquery selects `unit_quantity` from the most recent order
  // for each article rather than the lexically-greatest unit string. With
  // `LIMIT topN` on the outer query it runs only topN times — cheap and
  // honest about pack-size changes over time (e.g. 500g → 600g).
  const typical = db
    .prepare(
      `SELECT
         i.article_id,
         i.article_name,
         (SELECT i2.unit_quantity
            FROM order_items i2
            JOIN orders o2 ON o2.order_id = i2.order_id
            WHERE i2.article_id = i.article_id
            ORDER BY o2.creation_time DESC
            LIMIT 1)                              AS unit_quantity,
         COUNT(DISTINCT i.order_id)              AS times_ordered,
         CAST(SUM(i.quantity) AS REAL) /
           COUNT(DISTINCT i.order_id)            AS avg_quantity_per_order,
         MAX(o.creation_time)                    AS last_seen_at
       FROM order_items i
       JOIN orders o ON o.order_id = i.order_id
       GROUP BY i.article_id
       ORDER BY times_ordered DESC, last_seen_at DESC
       LIMIT ?`,
    )
    .all(topN) as Array<{
    article_id: string;
    article_name: string;
    unit_quantity: string | null;
    times_ordered: number;
    avg_quantity_per_order: number;
    last_seen_at: string;
  }>;

  return {
    computedAt: new Date().toISOString(),
    ordersCount: ordersAgg.orders_count,
    avgIntervalDays,
    lastOrderAt: ordersAgg.last_order_at,
    typicalBasket: typical.map((r) => ({
      articleId: r.article_id,
      name: r.article_name,
      unitQuantity: r.unit_quantity,
      timesOrdered: r.times_ordered,
      avgQuantityPerOrder: Number(r.avg_quantity_per_order.toFixed(2)),
      lastSeenAt: r.last_seen_at,
    })),
  };
}

function computeAvgIntervalDays(
  ordersCount: number,
  firstISO: string | null,
  lastISO: string | null,
): number | null {
  if (ordersCount < 2 || !firstISO || !lastISO) return null;
  const first = Date.parse(firstISO);
  const last = Date.parse(lastISO);
  if (Number.isNaN(first) || Number.isNaN(last) || last <= first) return null;
  const totalDays = (last - first) / (1000 * 60 * 60 * 24);
  // (N - 1) intervals between N orders.
  return Number((totalDays / (ordersCount - 1)).toFixed(2));
}
