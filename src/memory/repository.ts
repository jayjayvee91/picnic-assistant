/**
 * Repository functions over the SQLite schema in `db.ts`.
 *
 * Pure data layer — no Picnic API calls, no LLM logic. Each function takes
 * the open `DB` and returns plain TypeScript values. Higher layers
 * (`bootstrap.ts`, `summary.ts`, the agent) compose these.
 *
 * Money is stored in cents (INTEGER). Timestamps are ISO 8601 strings.
 */

import type { DB } from './db.js';

// ──────────────────────────────────────────────────────────────────────
// Domain types — flat shapes that the bot's higher layers see.
// ──────────────────────────────────────────────────────────────────────

export interface OrderRecord {
  orderId: string;
  deliveryId: string;
  creationTime: string;
  deliveryWindowStart: string | null;
  deliveryWindowEnd: string | null;
  status: string;
  totalPriceCents: number;
  totalSavingsCents: number;
  items: OrderItemRecord[];
}

export interface OrderItemRecord {
  articleId: string;
  articleName: string;
  unitQuantity: string | null;
  quantity: number;
  priceCents: number;
}

export interface SuggestionLogRecord {
  id: number;
  createdAt: string;
  payloadJson: string;
}

export interface DraftCart {
  conversationKey: string;
  items: Array<{ articleId: string; articleName: string; quantity: number }>;
  updatedAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// Orders & items
// ──────────────────────────────────────────────────────────────────────

/**
 * Insert or replace an order and its items in a single transaction.
 * Also updates the `products_seen` catalogue:
 *   - first_seen_at / last_seen_at extended by this order's creation_time
 *   - total_times_ordered bumped by 1 per article occurrence
 *
 * Idempotent: re-recording the same order_id replaces the row (and its items
 * via the FK cascade) without inflating product totals — we recompute totals
 * from `order_items` to keep this true.
 */
export function recordOrder(db: DB, order: OrderRecord): void {
  const tx = db.transaction(() => {
    // 1. Replace the order row.
    db.prepare(
      `INSERT INTO orders (
         order_id, delivery_id, creation_time,
         delivery_window_start, delivery_window_end,
         status, total_price_cents, total_savings_cents
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         delivery_id           = excluded.delivery_id,
         creation_time         = excluded.creation_time,
         delivery_window_start = excluded.delivery_window_start,
         delivery_window_end   = excluded.delivery_window_end,
         status                = excluded.status,
         total_price_cents     = excluded.total_price_cents,
         total_savings_cents   = excluded.total_savings_cents`,
    ).run(
      order.orderId,
      order.deliveryId,
      order.creationTime,
      order.deliveryWindowStart,
      order.deliveryWindowEnd,
      order.status,
      order.totalPriceCents,
      order.totalSavingsCents,
    );

    // 2. Replace the items for this order.
    db.prepare(`DELETE FROM order_items WHERE order_id = ?`).run(order.orderId);
    const insertItem = db.prepare(
      `INSERT INTO order_items
         (order_id, article_id, article_name, unit_quantity, quantity, price_cents)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const item of order.items) {
      insertItem.run(
        order.orderId,
        item.articleId,
        item.articleName,
        item.unitQuantity,
        item.quantity,
        item.priceCents,
      );
    }

    // 3. Maintain `products_seen` from the canonical `order_items` data.
    //    Done as one upsert per article in this order.
    const upsertProduct = db.prepare(
      `INSERT INTO products_seen
         (article_id, name, unit_quantity, first_seen_at, last_seen_at, total_times_ordered)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(article_id) DO UPDATE SET
         name              = excluded.name,
         unit_quantity     = excluded.unit_quantity,
         first_seen_at     = MIN(products_seen.first_seen_at, excluded.first_seen_at),
         last_seen_at      = MAX(products_seen.last_seen_at, excluded.last_seen_at)`,
    );
    for (const item of order.items) {
      upsertProduct.run(
        item.articleId,
        item.articleName,
        item.unitQuantity,
        order.creationTime,
        order.creationTime,
      );
    }

    // 4. Recompute total_times_ordered from scratch for the touched articles.
    //    Keeps the count correct across idempotent re-records.
    const recount = db.prepare(
      `UPDATE products_seen
       SET total_times_ordered = (
         SELECT COUNT(*) FROM order_items WHERE order_items.article_id = products_seen.article_id
       )
       WHERE article_id = ?`,
    );
    for (const item of order.items) {
      recount.run(item.articleId);
    }
  });

  tx();
}

/** Most recent N orders (with items), newest first. */
export function getRecentOrders(db: DB, limit: number): OrderRecord[] {
  const rows = db
    .prepare(
      `SELECT order_id, delivery_id, creation_time, delivery_window_start, delivery_window_end,
              status, total_price_cents, total_savings_cents
       FROM orders ORDER BY creation_time DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    order_id: string;
    delivery_id: string;
    creation_time: string;
    delivery_window_start: string | null;
    delivery_window_end: string | null;
    status: string;
    total_price_cents: number;
    total_savings_cents: number;
  }>;
  return rows.map((r) => ({
    orderId: r.order_id,
    deliveryId: r.delivery_id,
    creationTime: r.creation_time,
    deliveryWindowStart: r.delivery_window_start,
    deliveryWindowEnd: r.delivery_window_end,
    status: r.status,
    totalPriceCents: r.total_price_cents,
    totalSavingsCents: r.total_savings_cents,
    items: getItemsForOrder(db, r.order_id),
  }));
}

/**
 * Free-text search across orders' items by article name.
 * Used by the agent's `search_order_history` tool — e.g. "have we ever bought soy sauce?".
 * Returns matching items with the order's date attached.
 */
export interface OrderHistorySearchHit {
  orderId: string;
  creationTime: string;
  articleId: string;
  articleName: string;
  quantity: number;
  priceCents: number;
}

export function searchOrderHistory(db: DB, query: string, limit = 50): OrderHistorySearchHit[] {
  const like = `%${query.toLowerCase()}%`;
  const rows = db
    .prepare(
      `SELECT o.order_id, o.creation_time, i.article_id, i.article_name, i.quantity, i.price_cents
       FROM order_items i
       JOIN orders o ON o.order_id = i.order_id
       WHERE LOWER(i.article_name) LIKE ?
       ORDER BY o.creation_time DESC
       LIMIT ?`,
    )
    .all(like, limit) as Array<{
    order_id: string;
    creation_time: string;
    article_id: string;
    article_name: string;
    quantity: number;
    price_cents: number;
  }>;
  return rows.map((r) => ({
    orderId: r.order_id,
    creationTime: r.creation_time,
    articleId: r.article_id,
    articleName: r.article_name,
    quantity: r.quantity,
    priceCents: r.price_cents,
  }));
}

function getItemsForOrder(db: DB, orderId: string): OrderItemRecord[] {
  const rows = db
    .prepare(
      `SELECT article_id, article_name, unit_quantity, quantity, price_cents
       FROM order_items WHERE order_id = ?`,
    )
    .all(orderId) as Array<{
    article_id: string;
    article_name: string;
    unit_quantity: string | null;
    quantity: number;
    price_cents: number;
  }>;
  return rows.map((r) => ({
    articleId: r.article_id,
    articleName: r.article_name,
    unitQuantity: r.unit_quantity,
    quantity: r.quantity,
    priceCents: r.price_cents,
  }));
}

// ──────────────────────────────────────────────────────────────────────
// Suggestion log (kept in v1 so the v2 diff-observation feature has data)
// ──────────────────────────────────────────────────────────────────────

export function logSuggestion(db: DB, payload: unknown): number {
  const result = db
    .prepare(`INSERT INTO suggestion_log (payload_json) VALUES (?)`)
    .run(JSON.stringify(payload));
  return Number(result.lastInsertRowid);
}

export function getLatestSuggestion(db: DB): SuggestionLogRecord | null {
  const row = db
    .prepare(`SELECT id, created_at, payload_json FROM suggestion_log ORDER BY id DESC LIMIT 1`)
    .get() as { id: number; created_at: string; payload_json: string } | undefined;
  if (!row) return null;
  return { id: row.id, createdAt: row.created_at, payloadJson: row.payload_json };
}

// ──────────────────────────────────────────────────────────────────────
// Draft cart (the in-progress weekly draft per conversation)
// ──────────────────────────────────────────────────────────────────────

export function upsertDraftCart(db: DB, conversationKey: string, items: DraftCart['items']): void {
  db.prepare(
    `INSERT INTO draft_cart (conversation_key, payload_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(conversation_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       updated_at   = datetime('now')`,
  ).run(conversationKey, JSON.stringify({ items }));
}

export function getDraftCart(db: DB, conversationKey: string): DraftCart | null {
  const row = db
    .prepare(
      `SELECT conversation_key, payload_json, updated_at FROM draft_cart WHERE conversation_key = ?`,
    )
    .get(conversationKey) as
    | { conversation_key: string; payload_json: string; updated_at: string }
    | undefined;
  if (!row) return null;
  const parsed = JSON.parse(row.payload_json) as { items: DraftCart['items'] };
  return {
    conversationKey: row.conversation_key,
    items: parsed.items,
    updatedAt: row.updated_at,
  };
}

export function clearDraftCart(db: DB, conversationKey: string): void {
  db.prepare(`DELETE FROM draft_cart WHERE conversation_key = ?`).run(conversationKey);
}

// ──────────────────────────────────────────────────────────────────────
// API spend (€2/day kill-switch in Step 5)
// ──────────────────────────────────────────────────────────────────────

function utcDateKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function recordApiSpend(db: DB, eur: number, now = new Date()): void {
  const key = utcDateKey(now);
  db.prepare(
    `INSERT INTO api_spend_daily (utc_date, spend_eur)
     VALUES (?, ?)
     ON CONFLICT(utc_date) DO UPDATE SET spend_eur = api_spend_daily.spend_eur + excluded.spend_eur`,
  ).run(key, eur);
}

export function getTodayApiSpend(db: DB, now = new Date()): number {
  const key = utcDateKey(now);
  const row = db.prepare(`SELECT spend_eur FROM api_spend_daily WHERE utc_date = ?`).get(key) as
    | { spend_eur: number }
    | undefined;
  return row?.spend_eur ?? 0;
}

// ──────────────────────────────────────────────────────────────────────
// Meta (small flag store: bootstrap_completed, last_backup_at, etc.)
// ──────────────────────────────────────────────────────────────────────

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// ──────────────────────────────────────────────────────────────────────
// Chat turns (lightweight transcript with identity)
// ──────────────────────────────────────────────────────────────────────

export interface ChatTurnInput {
  telegramUserId: number | null;
  telegramUserName: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export function appendChatTurn(db: DB, turn: ChatTurnInput): void {
  db.prepare(
    `INSERT INTO chat_turns (telegram_user_id, telegram_user_name, role, content)
     VALUES (?, ?, ?, ?)`,
  ).run(turn.telegramUserId, turn.telegramUserName, turn.role, turn.content);
}
