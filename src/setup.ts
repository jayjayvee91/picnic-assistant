/**
 * Shared boot preparation for the data directory.
 *
 * Why this exists as its own module
 * ---------------------------------
 * The Telegram runtime and the agent smoke test each set up the same files:
 * the household profile, the `Allergies` section within it, and the gluten
 * rulebook. They drifted — production seeded the `Allergies` section while the
 * smoke test did not, so smoke runs exercised the agent with the household's
 * coeliac constraint MISSING from its system prompt. The guard still enforced
 * it (that is the whole point of enforcing in code), but every smoke test was
 * quietly measuring a slightly different assistant than the real one.
 *
 * Two call sites that must agree is exactly the shape that drifts again, so
 * the sequence lives here and both call it.
 */

import { ensureProfileSeeded, ensureProfileSection } from './memory/index.js';
import { ensureRulebookSeeded } from './allergen/index.js';

/** The coeliac line seeded into an existing profile that predates the guard. */
const COELIAC_LINE =
  'Coeliakie in het huishouden: NOOIT producten bestellen die gluten bevatten of ' +
  'waar sporen van gluten in kunnen zitten.';

export interface PrepareDataDirOptions {
  profilePath: string;
  rulebookPath: string;
  /** Called with a human-readable line for anything that was created. */
  onCreated?: (message: string) => void;
}

/**
 * Make sure the profile and rulebook exist and carry the sections the agent
 * depends on. Idempotent — safe on every boot.
 */
export async function prepareDataDir(opts: PrepareDataDirOptions): Promise<void> {
  const note = opts.onCreated ?? ((): void => {});

  if (await ensureProfileSeeded(opts.profilePath)) {
    note(`Seeded household profile at ${opts.profilePath}`);
  }

  // A household running since before the allergen guard has a profile without
  // this section. Add it so the medical constraint is in the prompt from the
  // first turn after upgrade, rather than only after the first profile write.
  if (await ensureProfileSection(opts.profilePath, 'Allergies', COELIAC_LINE)) {
    note(`Added the Allergies section to ${opts.profilePath}`);
  }

  if (await ensureRulebookSeeded(opts.rulebookPath)) {
    note(`Seeded gluten rulebook at ${opts.rulebookPath}`);
  }
}
