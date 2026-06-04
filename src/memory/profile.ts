/**
 * Household profile — a human-editable Markdown file at `DATA_DIR/profile.md`.
 *
 * Why a Markdown file (not SQLite)
 * --------------------------------
 * - You (or your partner) can `ssh` in, open the file in any editor, and read
 *   or correct it. No tool required.
 * - Easy to version-control privately if you ever want to (it stays gitignored
 *   in this repo).
 * - The agent embeds its contents verbatim in the system prompt — cheaper and
 *   more transparent than translating SQL rows into prose every turn.
 *
 * Sections
 * --------
 * `## Preferences`, `## Dislikes`, `## Brands`, `## Patterns`. Append-only via
 * the bot; you can edit freely by hand. The bot never silently rewrites — it
 * proposes a line, you approve, then this module appends it.
 *
 * Concurrent edits
 * ----------------
 * Reads are always fresh (`loadProfile` re-reads on every call). Writes are
 * atomic (`writeFile` to `<path>.tmp` then `rename`). If you happen to be
 * SSH-editing at the exact moment the bot appends, your in-progress changes
 * may be overwritten on the next save — accepted trade-off for v1; a file
 * lock is in the v2 backlog.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/** Section headers we know how to target programmatically. */
export type ProfileSection = 'Preferences' | 'Dislikes' | 'Brands' | 'Patterns';

const KNOWN_SECTIONS: ProfileSection[] = ['Preferences', 'Dislikes', 'Brands', 'Patterns'];

/**
 * Read the profile file fresh from disk. Returns the entire Markdown content.
 * Throws if the file does not exist — call `ensureProfileSeeded` first if
 * you want a forgiving startup path.
 */
export async function loadProfile(profilePath: string): Promise<string> {
  return await fs.readFile(profilePath, 'utf8');
}

/**
 * Create `profile.md` from the template if it does not yet exist. Idempotent:
 * if a profile already exists, this is a no-op.
 *
 * Returns true if the file was created, false if it already existed.
 */
export async function ensureProfileSeeded(profilePath: string): Promise<boolean> {
  try {
    await fs.access(profilePath);
    return false;
  } catch {
    // Doesn't exist — seed it from the inlined template.
    await fs.mkdir(dirname(profilePath), { recursive: true });
    await atomicWriteProfile(profilePath, PROFILE_TEMPLATE);
    return true;
  }
}

/**
 * Replace the entire profile file in one atomic step. Writes to `<path>.tmp`
 * and renames over the target. A crash mid-write leaves the old content intact.
 */
export async function atomicWriteProfile(profilePath: string, content: string): Promise<void> {
  await fs.mkdir(dirname(profilePath), { recursive: true });
  const tmp = `${profilePath}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.rename(tmp, profilePath);
  await fs.chmod(profilePath, 0o600).catch(() => {
    // Best-effort: Windows ignores POSIX perms. Production is Linux, where it works.
  });
}

/**
 * Append a single bullet line to a named section, then atomically save.
 *
 * Behaviour:
 *   - Section exists → bullet is added at the end of its body, just before the
 *     next `## ` heading or end-of-file.
 *   - Section does not exist → it's appended to the end of the file with the
 *     new bullet as its only entry.
 *
 * `bullet` should be the bullet text only (no leading `- `). Newlines are
 * stripped to keep the file shape clean.
 */
export async function appendToProfileSection(
  profilePath: string,
  section: ProfileSection,
  bullet: string,
): Promise<void> {
  const sanitised = bullet.replace(/\s+/g, ' ').trim();
  if (sanitised.length === 0) {
    throw new Error('Refusing to append an empty bullet to profile.');
  }

  const current = await loadProfile(profilePath);
  const next = insertBulletUnderSection(current, section, sanitised);
  await atomicWriteProfile(profilePath, next);
}

/**
 * Pure helper: given the current Markdown and a section + bullet, return the
 * new Markdown. Exported for unit testability without filesystem access.
 */
export function insertBulletUnderSection(
  markdown: string,
  section: ProfileSection,
  bullet: string,
): string {
  const lines = markdown.split('\n');
  const sectionHeader = `## ${section}`;
  const headerLineIndex = lines.findIndex((line) => line.trim() === sectionHeader);

  if (headerLineIndex === -1) {
    // Section doesn't exist — append it to the bottom.
    const trailing = lines.length > 0 && lines[lines.length - 1] !== '' ? '\n' : '';
    return `${markdown}${trailing}\n${sectionHeader}\n\n- ${bullet}\n`;
  }

  // Find the line that ends the section body: the next `## ` header, or EOF.
  let endLineIndex = lines.length;
  for (let i = headerLineIndex + 1; i < lines.length; i++) {
    const value = lines[i];
    if (value !== undefined && value.startsWith('## ')) {
      endLineIndex = i;
      break;
    }
  }

  // Walk backwards from endLineIndex to find the insertion point: just after
  // the last non-blank line of the section body.
  let insertAt = endLineIndex;
  while (insertAt > headerLineIndex + 1) {
    const candidate = lines[insertAt - 1];
    if (candidate !== undefined && candidate.trim() !== '') break;
    insertAt -= 1;
  }

  const newLine = `- ${bullet}`;
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  return [...before, newLine, ...after].join('\n');
}

/** Type guard for accepting a section name from less-typed callers (e.g. tools). */
export function isKnownSection(value: string): value is ProfileSection {
  return (KNOWN_SECTIONS as string[]).includes(value);
}

/**
 * Inlined seed template. Inlined (rather than read from a sibling `.md` file)
 * so the production build doesn't need extra steps to copy non-`.ts` assets
 * into `dist/`. The template kept here mirrors `profile.template.md` for
 * reference and human review.
 */
const PROFILE_TEMPLATE = `# Huishoudprofiel

Dit document beschrijft jullie voorkeuren. De assistent leest het bij elk gesprek
en past suggesties hierop aan. Je kunt het zelf direct aanpassen — wijzigingen
worden bij het volgende bericht meegenomen.

## Preferences

- (Nog niets gedeeld — de assistent vult dit aan na het kennismakingsgesprek.)

## Dislikes

- (Nog niets gedeeld — de assistent vult dit aan na het kennismakingsgesprek.)

## Brands

- Kies bij voorkeur Picnic huismerk waar dat kan.
- Pindakaas: altijd Calvé.

## Patterns

- (Nog niets gedeeld — de assistent vult dit aan na het kennismakingsgesprek.)
`;
