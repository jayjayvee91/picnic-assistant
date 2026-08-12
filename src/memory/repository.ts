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
  items: Array<{
    articleId: string;
    articleName: string;
    quantity: number;
    /** Gluten verdict at add time; absent on drafts written before the guard. */
    glutenStatus?: 'allowed' | 'unverified';
    glutenNote?: string;
  }>;
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

// ──────────────────────────────────────────────────────────────────────
// Allergen decisions + per-product overrides
// ──────────────────────────────────────────────────────────────────────

export type AllergenVerdict = 'blocked' | 'allowed' | 'unverified';
export type OverrideVerdict = 'blocked' | 'allowed';
export type OverrideScope = 'standing' | 'once';
/**
 * 'correction' fixes a gap in Picnic's data; an ALLOWED correction must not
 * survive the guard later finding real gluten. 'exception' is a human saying
 * "I know this has gluten and want it anyway", which does outrank a block.
 */
export type OverrideKind = 'correction' | 'exception';

export interface AllergenDecisionInput {
  articleId: string;
  articleName: string | null;
  /** Which allergen this verdict is about. Only 'gluten' in v1. */
  allergen: string;
  verdict: AllergenVerdict;
  /** 'override' | 'picnic_allergens' | 'rulebook' | 'no_data' | 'exception' */
  decidedBy: string;
  reason: string;
  /** Picnic's declared allergen list as seen at decision time. */
  allergens: string[] | null;
  /** The ingredient text the decision was made against (may be long). */
  ingredientsText: string | null;
  /** Rulebook terms that matched, if any. */
  matchedTerms: string[];
}

export interface AllergenDecisionRecord extends AllergenDecisionInput {
  id: number;
  createdAt: string;
}

/**
 * Append a decision to the audit trail. Called for EVERY evaluation, including
 * allows — a log that only records blocks cannot answer "why was this
 * allowed?", which is half the transparency requirement.
 */
export function logAllergenDecision(db: DB, decision: AllergenDecisionInput): number {
  const result = db
    .prepare(
      `INSERT INTO allergen_decisions
         (article_id, article_name, allergen, verdict, decided_by, reason,
          allergens_json, ingredients_txt, matched_terms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      decision.articleId,
      decision.articleName,
      decision.allergen,
      decision.verdict,
      decision.decidedBy,
      decision.reason,
      decision.allergens === null ? null : JSON.stringify(decision.allergens),
      decision.ingredientsText,
      JSON.stringify(decision.matchedTerms),
    );
  return Number(result.lastInsertRowid);
}

/** Most recent decisions, newest first. Powers `/gluten-log`. */
export function getRecentAllergenDecisions(db: DB, limit = 20): AllergenDecisionRecord[] {
  const rows = db
    .prepare(
      `SELECT id, created_at, article_id, article_name, allergen, verdict,
              decided_by, reason, allergens_json, ingredients_txt, matched_terms
       FROM allergen_decisions ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number;
    created_at: string;
    article_id: string;
    article_name: string | null;
    allergen: string;
    verdict: AllergenVerdict;
    decided_by: string;
    reason: string;
    allergens_json: string | null;
    ingredients_txt: string | null;
    matched_terms: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    articleId: r.article_id,
    articleName: r.article_name,
    allergen: r.allergen,
    verdict: r.verdict,
    decidedBy: r.decided_by,
    reason: r.reason,
    allergens: r.allergens_json === null ? null : (JSON.parse(r.allergens_json) as string[]),
    ingredientsText: r.ingredients_txt,
    matchedTerms: r.matched_terms === null ? [] : (JSON.parse(r.matched_terms) as string[]),
  }));
}

export interface AllergenOverride {
  articleId: string;
  allergen: string;
  verdict: OverrideVerdict;
  scope: OverrideScope;
  kind: OverrideKind;
  articleName: string | null;
  reason: string;
  createdAt: string;
}

export function getAllergenOverride(
  db: DB,
  articleId: string,
  allergen = 'gluten',
): AllergenOverride | null {
  const row = db
    .prepare(
      `SELECT article_id, allergen, verdict, scope, kind, article_name, reason, created_at
       FROM product_allergen_overrides WHERE article_id = ? AND allergen = ?`,
    )
    .get(articleId, allergen) as
    | {
        article_id: string;
        allergen: string;
        verdict: OverrideVerdict;
        scope: OverrideScope;
        kind: OverrideKind;
        article_name: string | null;
        reason: string;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    articleId: row.article_id,
    allergen: row.allergen,
    verdict: row.verdict,
    scope: row.scope,
    kind: row.kind,
    articleName: row.article_name,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export function upsertAllergenOverride(
  db: DB,
  override: Omit<AllergenOverride, 'createdAt'>,
): void {
  db.prepare(
    `INSERT INTO product_allergen_overrides
       (article_id, allergen, verdict, scope, kind, article_name, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(article_id, allergen) DO UPDATE SET
       verdict      = excluded.verdict,
       scope        = excluded.scope,
       kind         = excluded.kind,
       article_name = excluded.article_name,
       reason       = excluded.reason,
       created_at   = datetime('now')`,
  ).run(
    override.articleId,
    override.allergen,
    override.verdict,
    override.scope,
    override.kind,
    override.articleName,
    override.reason,
  );
}

export function deleteAllergenOverride(db: DB, articleId: string, allergen = 'gluten'): void {
  db.prepare(`DELETE FROM product_allergen_overrides WHERE article_id = ? AND allergen = ?`).run(
    articleId,
    allergen,
  );
}

/** All standing + pending one-off overrides, newest first. */
export function listAllergenOverrides(db: DB, limit = 50): AllergenOverride[] {
  const rows = db
    .prepare(
      `SELECT article_id, allergen, verdict, scope, kind, article_name, reason, created_at
       FROM product_allergen_overrides ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    article_id: string;
    allergen: string;
    verdict: OverrideVerdict;
    scope: OverrideScope;
    kind: OverrideKind;
    article_name: string | null;
    reason: string;
    created_at: string;
  }>;
  return rows.map((r) => ({
    articleId: r.article_id,
    allergen: r.allergen,
    verdict: r.verdict,
    scope: r.scope,
    kind: r.kind,
    articleName: r.article_name,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}
