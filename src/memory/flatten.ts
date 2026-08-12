/**
 * Translation from Picnic's delivery shapes to our internal `OrderRecord`.
 *
 * Lives on its own because two callers need it: the one-time backfill
 * (`bootstrap.ts`) and the recurring incremental sync (`sync.ts`). Keeping a
 * single implementation means both paths write identical rows — if this ever
 * diverged, a re-synced order would silently differ from its backfilled
 * version.
 */

import type { Delivery, DeliveryDetail } from '../picnic/index.js';
import type { OrderRecord } from './repository.js';

/**
 * Translate a Picnic `DeliveryDetail` into our internal `OrderRecord`s.
 * A Delivery usually contains exactly one Order; we still handle N for safety.
 *
 * For each `OrderLine`, Picnic represents quantity by repeating the
 * `OrderArticle` in `items[]` (e.g. ordering 3 cartons → 3 entries). We
 * collapse this to `{ articleId, quantity, ... }` in our schema.
 */
export function flattenDelivery(detail: DeliveryDetail, slim: Delivery): OrderRecord[] {
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
