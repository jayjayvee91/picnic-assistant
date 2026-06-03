/**
 * Daily local backup of `data.db`.
 *
 * SQLite is just a file, so backup = copy. We use better-sqlite3's `backup()`
 * API rather than a raw filesystem copy: it captures a consistent snapshot
 * even if the DB is being written to.
 *
 * Retention: keep the N most recent backups; delete older ones. Stored under
 * `<dataDir>/backups/` so they are gitignored along with the DB itself.
 *
 * v1 is intentionally local-only — no off-VPS copies. That's a v2 backlog item.
 */

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.js';

export interface BackupOptions {
  /** Where to put backup files. Created if missing. */
  backupDir: string;
  /** Number of backups to retain (oldest beyond this are deleted). */
  keep?: number;
  /** Override the timestamp portion of the filename (for tests). */
  now?: Date;
}

const DEFAULT_KEEP = 14;

/** Filename prefix used for our backups; lets us safely sweep this folder. */
const BACKUP_PREFIX = 'data-';
const BACKUP_SUFFIX = '.db';

export interface BackupResult {
  path: string;
  bytes: number;
  removedOldBackups: number;
}

/**
 * Create a backup file and prune older ones. Returns the new file's path.
 * Uses better-sqlite3's online backup, so safe to call while the bot is live.
 */
export async function backupDatabase(db: DB, opts: BackupOptions): Promise<BackupResult> {
  mkdirSync(opts.backupDir, { recursive: true });
  const filename = `${BACKUP_PREFIX}${formatTimestamp(opts.now ?? new Date())}${BACKUP_SUFFIX}`;
  const target = join(opts.backupDir, filename);

  await db.backup(target);

  const removed = pruneOldBackups(opts.backupDir, opts.keep ?? DEFAULT_KEEP);
  const stat = statSync(target);
  return { path: target, bytes: stat.size, removedOldBackups: removed };
}

/** Format: `YYYY-MM-DDTHH-mm-ss` (filename-safe ISO). */
function formatTimestamp(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`
  );
}

/** Delete all but the `keep` newest backups in `dir`. Returns the count deleted. */
function pruneOldBackups(dir: string, keep: number): number {
  const entries = readdirSync(dir)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const toRemove = entries.slice(keep);
  for (const entry of toRemove) {
    rmSync(join(dir, entry.name), { force: true });
  }
  return toRemove.length;
}
