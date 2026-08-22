/**
 * Recipe rotation — ordering and filtering a recipe library by how recently
 * each one was cooked.
 *
 * Why this exists
 * ---------------
 * The weekly menu kept proposing what the household had just eaten. Nothing in
 * the system was wrong in isolation: the model was told to propose "a varied
 * set", and it did — varied *within* the week. It had no way to vary against
 * last week, because nothing recorded what last week's recipes were, and
 * `list_recipes` handed back names with no time dimension at all.
 *
 * So the fix is in the data, not the prompt. `recipe_usage` records what was
 * cooked; this module turns that history into something a listing can be
 * ranked by. Telling the model harder to avoid repeats, without giving it the
 * facts, would only have produced confident-sounding variety that wasn't
 * actually informed by anything.
 *
 * Why it lives in the recipe layer rather than in the agent's tool handlers:
 * same reason as `match.ts` — it is recipe-domain logic, and keeping it here
 * makes it directly testable by `npm run smoke:recipe`, offline, with no DB
 * and no credentials.
 */

import type { RecipeSummary } from './types.js';

/**
 * How recently a recipe was cooked. Sourced from `recipe_usage`; recipes with
 * no history simply have no entry.
 */
export interface RecipeUsageInfo {
  /** ISO timestamp of the most recent use. */
  lastUsedAt: string;
  timesUsed: number;
}

/** A recipe with its rotation history attached. */
export interface RankedRecipe extends RecipeSummary {
  /** ISO date (YYYY-MM-DD) of the last use, or null when never cooked. */
  lastUsedAt: string | null;
  /**
   * Whole days since the last use, or null when never cooked.
   *
   * Null means "no record", which early on means "we only started tracking
   * recently" rather than "never eaten" — callers must not present it as the
   * latter. See `NEVER_USED_NOTE`.
   */
  daysSinceUsed: number | null;
  timesUsed: number;
}

/**
 * Default rotation window: a recipe cooked within this many days is considered
 * too recent for a new week's menu.
 *
 * Two weeks is a starting point, not a rule. The household can state their own
 * window in the Patterns section of the profile and the agent honours that
 * instead — which is why this is a default rather than a hard filter applied
 * unconditionally.
 */
export const DEFAULT_ROTATION_DAYS = 14;

/**
 * Attach usage history to a listing and sort it stalest-first: never cooked,
 * then longest ago, then most recent.
 *
 * The sort matters more than it looks, because listings get truncated. The
 * household has ~95 saved recipes and `list_recipes` returns 40, so before
 * this the model saw the same first 40 in Picnic's own page order every single
 * week — recipes past that point could not be suggested at all, no matter how
 * long since they were last cooked. Sorting by staleness means the truncated
 * window is exactly the part of the library worth choosing from.
 *
 * Ties break on name so the order is stable across calls; an unstable listing
 * would make the same request return different recipes on a retry.
 */
export function rankByRotation(
  recipes: RecipeSummary[],
  usage: Map<string, RecipeUsageInfo>,
  now: Date,
): RankedRecipe[] {
  const ranked = recipes.map((r) => {
    const seen = usage.get(r.id);
    return {
      ...r,
      lastUsedAt: seen ? seen.lastUsedAt.slice(0, 10) : null,
      daysSinceUsed: seen ? daysBetween(seen.lastUsedAt, now) : null,
      timesUsed: seen?.timesUsed ?? 0,
    };
  });

  return ranked.sort((a, b) => {
    // Never cooked sorts first — it is the strongest "propose this" signal
    // there is, and it cannot be expressed as a day count.
    if (a.daysSinceUsed === null && b.daysSinceUsed === null) {
      return a.name.localeCompare(b.name, 'nl');
    }
    if (a.daysSinceUsed === null) return -1;
    if (b.daysSinceUsed === null) return 1;
    if (a.daysSinceUsed !== b.daysSinceUsed) return b.daysSinceUsed - a.daysSinceUsed;
    return a.name.localeCompare(b.name, 'nl');
  });
}

/**
 * Split a ranked listing into recipes eligible for a new menu and those cooked
 * too recently.
 *
 * Returned as a split rather than a plain filter because the count of what was
 * held back is worth saying out loud ("ik heb er 3 overgeslagen die je vorige
 * week gemaakt hebt"). Silently returning a shorter list would read as a
 * smaller library.
 *
 * A recipe with no usage record is always eligible: no record is not evidence
 * of a recent meal.
 */
export function splitByRotationWindow(
  ranked: RankedRecipe[],
  withinDays: number,
): { eligible: RankedRecipe[]; tooRecent: RankedRecipe[] } {
  const eligible: RankedRecipe[] = [];
  const tooRecent: RankedRecipe[] = [];
  for (const r of ranked) {
    if (r.daysSinceUsed !== null && r.daysSinceUsed < withinDays) {
      tooRecent.push(r);
    } else {
      eligible.push(r);
    }
  }
  return { eligible, tooRecent };
}

/**
 * Whole days between an ISO timestamp and `now`, floored, never negative.
 *
 * Clamping at zero keeps a clock skew or a same-day double commit from
 * producing a negative age that would sort a just-cooked recipe to the top of
 * a stalest-first list — the exact opposite of what it should do.
 */
function daysBetween(isoTimestamp: string, now: Date): number | null {
  const then = Date.parse(isoTimestamp);
  if (!Number.isFinite(then)) return null;
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  return days < 0 ? 0 : days;
}

/**
 * Handed to the model alongside any listing carrying `daysSinceUsed`.
 *
 * Without it, `null` reads as "never eaten", and the assistant would announce
 * that about recipes the household cooks all the time — the same class of
 * confidently-wrong claim that `match.ts` exists to prevent. History only
 * starts where the tracking does.
 */
export const NEVER_USED_NOTE =
  'daysSinceUsed telt vanaf het moment dat de bot recepten is gaan bijhouden. ' +
  'null betekent "niet in die administratie", NIET "nog nooit gemaakt" — zeg dus ' +
  'niet tegen het huishouden dat ze een recept nooit gemaakt hebben.';
