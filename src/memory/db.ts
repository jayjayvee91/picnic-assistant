/**
 * SQLite handle + idempotent schema migration.
 *
 * Why SQLite (and `better-sqlite3` specifically)
 * ----------------------------------------------
 * - Single-file database; trivial to back up and reason about.
 * - One process (the bot) is the only writer; no concurrency to manage.
 * - `better-sqlite3` is synchronous and ships prebuilt Windows + Linux binaries,
 *   so `npm install` works on a fresh VPS without a C toolchain.
 *
 * Migration strategy
 * ------------------
 * For v1 we use `CREATE TABLE IF NOT EXISTS` rather than a numbered migration
 * framework. The schema is small and we control the only deployment. If we
 * ever need destructive changes, we'll add a `schema_version` table and
 * proper up-migrations — out of scope for v1.
 *
 * Money fields are stored as integer cents to avoid floating-point drift.
 * Timestamps are ISO 8601 strings (SQLite has no native date type and this
 * keeps interop with Picnic's API trivial).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

/**
 * Open (or create) the SQLite database at `dbPath` and run migrations.
 * Safe to call multiple times.
 */
export function openDatabase(dbPath: string): DB {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  // Recommended pragmas for a small single-writer app:
  // - WAL mode: better concurrency for readers + crash safety.
  // - foreign_keys: enforce referential integrity (off by default in SQLite).
  // - synchronous=NORMAL: WAL pairs well with this — faster, still crash-safe.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(SCHEMA);
  migrateColumns(db);
}

/**
 * Schema. Everything is `IF NOT EXISTS` so re-running is safe.
 *
 * Tables:
 *   orders          one row per placed Picnic order (a Delivery may contain
 *                   multiple Orders; in practice it is usually one)
 *   order_items     denormalised: one row per (order, article) with quantity
 *   products_seen   catalogue of every article we have ever observed
 *   suggestion_log  payload of each draft the bot has proposed (kept for v2
 *                   diff observation; we log to it in v1 already)
 *   recipe_usage    which recipes were actually cooked, and when — the memory
 *                   that stops the weekly menu repeating itself
 *   chat_turns      lightweight transcript with identity (Telegram user)
 *   draft_cart      in-progress draft per conversation
 *   api_spend_daily Anthropic spend per UTC day for the kill-switch
 *   meta            tiny key/value for flags like `bootstrap_completed`
 *   allergen_decisions        audit trail of every gluten verdict (transparency)
 *   product_allergen_overrides  per-product human corrections + deliberate
 *                               exceptions, which outrank all automatic layers
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  order_id              TEXT PRIMARY KEY,
  delivery_id           TEXT NOT NULL,
  creation_time         TEXT NOT NULL,
  delivery_window_start TEXT,
  delivery_window_end   TEXT,
  status                TEXT NOT NULL,
  total_price_cents     INTEGER NOT NULL,
  total_savings_cents   INTEGER NOT NULL DEFAULT 0,
  recorded_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_creation_time ON orders(creation_time DESC);

CREATE TABLE IF NOT EXISTS order_items (
  order_id      TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  article_id    TEXT NOT NULL,
  article_name  TEXT NOT NULL,
  unit_quantity TEXT,
  quantity      INTEGER NOT NULL,
  price_cents   INTEGER NOT NULL,
  PRIMARY KEY (order_id, article_id)
);
CREATE INDEX IF NOT EXISTS idx_order_items_article ON order_items(article_id);

CREATE TABLE IF NOT EXISTS products_seen (
  article_id            TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  unit_quantity         TEXT,
  first_seen_at         TEXT NOT NULL,
  last_seen_at          TEXT NOT NULL,
  total_times_ordered   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS suggestion_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggestion_log_created ON suggestion_log(created_at DESC);

-- Which recipes the household has actually cooked, and when.
--
-- This is the one thing the order history cannot tell us. An order records
-- articles, and recipes overlap heavily in their ingredients (onion, tomato,
-- garlic), so "did we eat the risotto last week" is not recoverable from
-- order_items without guessing. Without this table the weekly menu has no
-- way to avoid repeating what was just eaten — which is exactly what it did.
--
-- One row per (recipe, commit). Written when a draft containing the recipe is
-- committed to the Picnic cart, NOT when it is added to the draft: a recipe
-- the household rejected during review was never eaten and must not suppress
-- itself from next week's suggestions.
--
-- "Committed to the cart" is a proxy for "cooked" — the household still places
-- the order themselves in the Picnic app, and could in principle drop the
-- ingredients before checkout. It is the last point the bot can observe, and
-- it is close enough: the alternative is matching carts against later
-- deliveries by ingredient overlap, which is the same guesswork this table
-- exists to avoid.
--
-- used_at is part of the key so the same recipe can be recorded on many
-- occasions; that history is what the timesUsed count reflects.
CREATE TABLE IF NOT EXISTS recipe_usage (
  recipe_id     TEXT NOT NULL,   -- qualified across sources, e.g. "picnic:6335ac…"
  recipe_name   TEXT NOT NULL,
  source        TEXT NOT NULL,
  used_at       TEXT NOT NULL,
  -- The suggestion_log row for the same commit, when there is one. Lets a
  -- past menu be reconstructed with its articles rather than names alone.
  suggestion_id INTEGER,
  PRIMARY KEY (recipe_id, used_at)
);
CREATE INDEX IF NOT EXISTS idx_recipe_usage_used_at ON recipe_usage(used_at DESC);

CREATE TABLE IF NOT EXISTS chat_turns (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  telegram_user_id   INTEGER,
  telegram_user_name TEXT,
  role               TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_turns_created ON chat_turns(created_at DESC);

CREATE TABLE IF NOT EXISTS draft_cart (
  conversation_key TEXT PRIMARY KEY,
  payload_json     TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_spend_daily (
  utc_date  TEXT PRIMARY KEY,    -- YYYY-MM-DD
  spend_eur REAL NOT NULL DEFAULT 0.0
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Every gluten evaluation, whatever the outcome. This is the "show me how it
-- decided" surface: raw inputs, which layer fired, and the resulting verdict.
-- Append-only; never rewritten. Retained indefinitely (rows are tiny) so a
-- past decision can always be re-examined.
CREATE TABLE IF NOT EXISTS allergen_decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  article_id      TEXT NOT NULL,
  article_name    TEXT,
  allergen        TEXT NOT NULL DEFAULT 'gluten',
  verdict         TEXT NOT NULL CHECK (verdict IN ('blocked','allowed','unverified')),
  -- Which layer produced the verdict: 'override' | 'picnic_allergens'
  -- | 'rulebook' | 'no_data' | 'exception'
  decided_by      TEXT NOT NULL,
  reason          TEXT NOT NULL,
  -- Raw inputs the decision saw, so a verdict can be audited after the fact
  -- even if Picnic later changes the product's data.
  allergens_json  TEXT,
  ingredients_txt TEXT,
  matched_terms   TEXT
);
CREATE INDEX IF NOT EXISTS idx_allergen_decisions_created
  ON allergen_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_allergen_decisions_article
  ON allergen_decisions(article_id);

-- Human corrections and deliberate exceptions, keyed by article. Outranks
-- every automatic layer — this is both "Picnic mislabelled this, always block
-- it" and "yes, I know this has gluten, I want it anyway".
--
-- The verdict column is what the override forces. The scope column
-- distinguishes a standing rule from a one-off: 'standing' persists, 'once' is
-- consumed by the next add and then deleted, so a single deliberate exception
-- cannot silently become permanent.
-- The kind column separates two very different human acts:
--   'correction' — "this product is fine / is not fine", based on reading the
--                  packet. An ALLOWED correction must NOT survive the guard
--                  later finding actual gluten (a Picnic relabel, a new rule):
--                  the household corrected a gap in the data, not a finding.
--   'exception'  — "I know this contains gluten and I want it anyway". This
--                  one DOES outrank a block, because the human acknowledged
--                  exactly that.
CREATE TABLE IF NOT EXISTS product_allergen_overrides (
  article_id   TEXT NOT NULL,
  allergen     TEXT NOT NULL DEFAULT 'gluten',
  verdict      TEXT NOT NULL CHECK (verdict IN ('blocked','allowed')),
  scope        TEXT NOT NULL DEFAULT 'standing' CHECK (scope IN ('standing','once')),
  kind         TEXT NOT NULL DEFAULT 'correction' CHECK (kind IN ('correction','exception')),
  article_name TEXT,
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (article_id, allergen)
);
`;

/**
 * Additive migrations for databases created before a column existed.
 *
 * v1 uses `CREATE TABLE IF NOT EXISTS` rather than a migration framework, which
 * cannot add a column to a table that already exists. Each entry here is
 * attempted and its "duplicate column" error ignored, which is safe because
 * every one is additive with a default.
 */
function migrateColumns(db: DB): void {
  const additive = [
    `ALTER TABLE product_allergen_overrides ADD COLUMN kind TEXT NOT NULL DEFAULT 'correction'`,
  ];
  for (const sql of additive) {
    try {
      db.exec(sql);
    } catch (err) {
      // "duplicate column name" means the migration already ran. Anything else
      // is a real problem and must not be swallowed.
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(message)) throw err;
    }
  }
}
