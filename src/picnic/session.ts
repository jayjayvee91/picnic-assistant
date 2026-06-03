/**
 * Picnic session persistence.
 *
 * After successful 2FA, Picnic returns a long-lived `authKey` that we re-use
 * across restarts. We store it as JSON on disk with `0600` perms — same
 * protection level as `.env`. Atomic write via temp + rename so a crash never
 * leaves a half-written file.
 *
 * The auth key is the only secret in this file. We do not store the user's
 * password — once 2FA is done, the key alone authenticates future calls.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export interface PicnicSession {
  authKey: string;
  savedAt: string; // ISO 8601
}

/**
 * Load a saved session. Returns null if the file doesn't exist or is unreadable.
 * We do NOT validate the auth key here — the first real API call decides.
 */
export async function loadSession(sessionFile: string): Promise<PicnicSession | null> {
  try {
    const raw = await fs.readFile(sessionFile, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'authKey' in parsed &&
      typeof (parsed as { authKey: unknown }).authKey === 'string' &&
      (parsed as { authKey: string }).authKey.length > 0
    ) {
      return parsed as PicnicSession;
    }
    return null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Persist a session atomically. Ensures the parent directory exists, writes
 * to `<file>.tmp`, then renames over the target. File perms are set to `0600`
 * so only the bot's user can read it.
 */
export async function saveSession(sessionFile: string, session: PicnicSession): Promise<void> {
  await fs.mkdir(dirname(sessionFile), { recursive: true });
  const tmp = `${sessionFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  await fs.rename(tmp, sessionFile);
  // Re-apply mode after rename in case the platform didn't honour the write mode.
  await fs.chmod(sessionFile, 0o600).catch(() => {
    // Best effort — Windows may not support POSIX perms. Acceptable for local dev;
    // production lives on Linux where chmod works.
  });
}

/**
 * Remove the saved session. Used during forced re-auth or `panic` flows.
 */
export async function clearSession(sessionFile: string): Promise<void> {
  await fs.rm(sessionFile, { force: true });
}
