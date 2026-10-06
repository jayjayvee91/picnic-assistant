/**
 * Menu variety: no star ingredient more than twice in one menu.
 *
 * The split of work is deliberate. Deciding what a recipe's star ingredients
 * are is a judgement call — "Romige casarecce-pasta" is a spinach dish even
 * though its name never says so — and the model makes that call once per
 * recipe (see `set_recipe_stars`). Counting is NOT a judgement call, and
 * models are unreliable at tallying across five recipes, so the counting
 * happens here, in plain code.
 *
 * This is a warning, not a guard. Unlike gluten, a third spinach dish is
 * allowed when the household says so; the point is that it never happens by
 * accident.
 */

/** A star may appear in at most this many recipes of one menu. */
export const MAX_RECIPES_PER_STAR = 2;

export interface MenuRecipe {
  recipeId: string;
  name: string | null;
  stars: string[];
}

export interface StarClash {
  star: string;
  count: number;
  recipes: Array<{ recipeId: string; name: string | null }>;
}

/**
 * Clean a star for storage: lower case, single spaces. "  Babyspinazie " and
 * "babyspinazie" are the same entry.
 */
export function cleanStar(star: string): string {
  return star.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Comparison key: also ignores accents, so "crème fraîche" = "creme fraiche". */
function starKey(star: string): string {
  return cleanStar(star)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Stars that appear in more than `max` recipes, most frequent first. A recipe
 * that lists the same star twice still counts once.
 */
export function findStarClashes(
  menu: MenuRecipe[],
  max: number = MAX_RECIPES_PER_STAR,
): StarClash[] {
  const byKey = new Map<string, StarClash>();
  for (const recipe of menu) {
    const seen = new Set<string>();
    for (const star of recipe.stars) {
      const key = starKey(star);
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      const entry = byKey.get(key) ?? { star: cleanStar(star), count: 0, recipes: [] };
      entry.count++;
      entry.recipes.push({ recipeId: recipe.recipeId, name: recipe.name });
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].filter((c) => c.count > max).sort((a, b) => b.count - a.count);
}
