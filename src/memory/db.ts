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
 *   chat_turns      lightweight transcript with identity (Telegram user)
 *   draft_cart      in-progress draft per conversation
 *   api_spend_daily Anthropic spend per UTC day for the kill-switch
 *   meta            tiny key/value for flags like `bootstrap_completed`
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
`;
