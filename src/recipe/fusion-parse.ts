/**
 * Parsers for Picnic's Fusion (PML) recipe pages.
 *
 * These are pure functions over already-fetched JSON, so they can be exercised
 * against fixtures with no network. That matters: the shapes below were
 * derived from real captured responses, and fixtures are the only way to keep
 * them honest as Picnic evolves.
 *
 * Why parsing at all
 * ------------------
 * Picnic returns UI descriptions, not recipe documents: an 8.5 MB tree for the
 * saved list, 2.9 MB for one recipe. There is no clean REST endpoint (the one
 * the library's routes reference documents, `GET /recipes/{id}`, 404s). So we
 * mine the two spots where the data survives in structured form.
 *
 * Where the data actually lives
 * -----------------------------
 * 1. **Saved list** — recipe tiles hide their names behind PML expression
 *    variables, but every tile has a navigation deep link that spells
 *    everything out:
 *      app.picnic://store/page;id=action-bottom-sheet,...,id=<recipeId>
 *        &image=<path>&name=<name>&source=SELLING_GROUP_TILE
 *    Reading the links sidesteps the template layer entirely.
 *
 * 2. **Recipe details** — the page carries a React-style state object holding
 *    `ingredientsState`, where each ingredient names its selling units with
 *    price and required amount. An analytics context alongside it repeats the
 *    same mapping and adds `recipe_name` and `portions`. We prefer the state
 *    object (richer) and fall back to analytics (more stable), because the two
 *    fail in different ways.
 */

import type { RecipeDetails, RecipeIngredient, RecipeSummary } from './types.js';

const SOURCE = 'picnic';

/** Picnic recipe ids are 24-hex; selling units look like "s1012860". */
const RECIPE_ID = /^[0-9a-f]{24}$/i;

// ──────────────────────────────────────────────────────────────────────
// Saved / listed recipes
// ──────────────────────────────────────────────────────────────────────

/**
 * Extract recipes from a listing page (the saved "deep dive" content page, or
 * the meals overview).
 *
 * `saved` is stamped onto every result because the caller knows which page it
 * fetched; the tiles themselves carry no saved flag.
 */
export function parseRecipeList(page: unknown, opts: { saved: boolean }): RecipeSummary[] {
  const byId = new Map<string, RecipeSummary>();

  forEachString(page, (value) => {
    if (!value.includes('SELLING_GROUP_TILE')) return;
    const id = /[?&,]id=([0-9a-f]{24})/i.exec(value)?.[1];
    if (!id) return;
    const rawName = /[?&]name=([^&]+)/.exec(value)?.[1];
    if (!rawName) return;
    const rawImage = /[?&]image=([^&]+)/.exec(value)?.[1];
    // First occurrence wins; later duplicates are the same tile re-rendered.
    if (byId.has(id)) return;
    byId.set(id, {
      id,
      name: safeDecode(rawName),
      source: SOURCE,
      saved: opts.saved,
      image: rawImage ? safeDecode(rawImage) : null,
    });
  });

  return [...byId.values()];
}

// ──────────────────────────────────────────────────────────────────────
// Recipe details
// ──────────────────────────────────────────────────────────────────────

/** The page's state object, the richest description of the ingredients. */
interface IngredientState {
  ingredientId?: unknown;
  ingredientType?: unknown;
  isAvailable?: unknown;
  isExcluded?: unknown;
  sellingUnits?: unknown;
}

/**
 * Parse a recipe detail page into ingredients with article ids.
 *
 * Returns null when neither the state object nor the analytics context can be
 * found — the caller must treat that as "unknown", never as "no ingredients",
 * since an empty shopping list would silently drop the recipe.
 */
export function parseRecipeDetails(page: unknown, recipeId: string): RecipeDetails | null {
  const meta = findRecipeMeta(page);
  const fromState = parseFromState(page);
  const fromAnalytics = parseFromAnalytics(page);

  // Prefer the state object: it carries price, availability and CORE/non-core.
  const ingredients = fromState.length > 0 ? fromState : fromAnalytics;
  if (ingredients.length === 0) return null;

  return {
    id: meta?.recipeId ?? recipeId,
    name: meta?.name ?? null,
    source: SOURCE,
    portions: meta?.portions ?? null,
    ingredients,
  };
}

/**
 * `$.body.child.state.ingredientsState[]` — one entry per ingredient:
 *
 *   { ingredientId, ingredientType: "CORE", isAvailable, isExcluded,
 *     sellingUnits: { "s1012860": { price, requiredAmount, sellingUnitId } } }
 */
function parseFromState(page: unknown): RecipeIngredient[] {
  const out: RecipeIngredient[] = [];
  const seen = new Set<string>();

  // `defaultSelectedIngredientIds` is what the app ticks when you open the
  // recipe — the true shopping list. Everything else is an offered extra.
  // Collected first so it is available while walking the ingredients.
  const preSelected = new Set<string>();
  forEachObject(page, (obj) => {
    const ids = obj['defaultSelectedIngredientIds'];
    if (!Array.isArray(ids)) return;
    for (const id of ids) if (typeof id === 'string') preSelected.add(id);
  });

  forEachObject(page, (obj) => {
    const list = obj['ingredientsState'];
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as IngredientState;
      const ingredientId = asString(entry.ingredientId);
      if (!ingredientId || seen.has(ingredientId)) continue;

      // An excluded ingredient is one the household de-selected in the app.
      // Honour that: it should not reappear on a generated shopping list.
      if (entry.isExcluded === true) continue;

      const unit = firstSellingUnit(entry.sellingUnits);
      seen.add(ingredientId);
      out.push({
        ingredientId,
        name: null,
        articleId: unit?.sellingUnitId ?? null,
        requiredAmount: unit?.requiredAmount ?? 1,
        priceCents: unit?.price ?? null,
        available: entry.isAvailable !== false,
        core: entry.ingredientType === 'CORE',
        // Fall back to the CORE flag only when the page carried no explicit
        // selection list, so a layout change cannot silently mark every
        // pantry extra as "buy this".
        selected:
          preSelected.size > 0 ? preSelected.has(ingredientId) : entry.ingredientType === 'CORE',
      });
    }
  });

  return out;
}

/**
 * Analytics fallback: `{ recipe_id, recipe_name, portions, selling_units: [
 *   { ingredient_id, selling_unit_id, quantity, status, checked } ] }`.
 *
 * Less detail than the state object, but a different code path in Picnic's
 * renderer — so it tends to survive when the other changes.
 */
function parseFromAnalytics(page: unknown): RecipeIngredient[] {
  const out: RecipeIngredient[] = [];
  const seen = new Set<string>();

  forEachObject(page, (obj) => {
    const units = obj['selling_units'];
    if (!Array.isArray(units)) return;
    for (const raw of units) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const ingredientId = asString(entry['ingredient_id']);
      const articleId = asString(entry['selling_unit_id']);
      if (!ingredientId || seen.has(ingredientId)) continue;
      seen.add(ingredientId);
      out.push({
        ingredientId,
        name: null,
        articleId,
        requiredAmount: asNumber(entry['quantity']) ?? 1,
        priceCents: null,
        available: entry['status'] !== 'UNAVAILABLE',
        core: true,
        // `checked` is this path's equivalent of the selection list.
        selected: entry['checked'] !== false,
      });
    }
  });

  return out;
}

/** Recipe name + portions, from whichever block carries them. */
function findRecipeMeta(
  page: unknown,
): { recipeId: string; name: string; portions: number } | null {
  let found: { recipeId: string; name: string; portions: number } | null = null;
  forEachObject(page, (obj) => {
    if (found) return;
    const id = asString(obj['recipe_id']);
    const name = asString(obj['recipe_name']);
    if (!id || !RECIPE_ID.test(id) || !name) return;
    found = { recipeId: id, name, portions: asNumber(obj['portions']) ?? 0 };
  });
  return found;
}

/**
 * `sellingUnits` is keyed by article id. Recipes normally offer exactly one
 * unit per ingredient; when several are present we take the first
 * deterministically (sorted) so repeat runs agree.
 */
function firstSellingUnit(
  value: unknown,
): { sellingUnitId: string; price: number | null; requiredAmount: number } | null {
  if (!value || typeof value !== 'object') return null;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const key = keys[0];
  if (key === undefined) return null;
  const unit = (value as Record<string, unknown>)[key];
  if (!unit || typeof unit !== 'object') return null;
  const u = unit as Record<string, unknown>;
  return {
    sellingUnitId: asString(u['sellingUnitId']) ?? key,
    price: asNumber(u['price']),
    requiredAmount: asNumber(u['requiredAmount']) ?? 1,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Traversal helpers
// ──────────────────────────────────────────────────────────────────────

const MAX_DEPTH = 60;

/**
 * Visit every plain object. Arrays are walked in full — capping them would
 * risk silently dropping recipes, which is exactly the bug that made an
 * earlier version of the capture tooling report 12 saved recipes instead of 96.
 */
function forEachObject(
  value: unknown,
  fn: (obj: Record<string, unknown>) => void,
  depth = 0,
): void {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) forEachObject(item, fn, depth + 1);
    return;
  }
  fn(value as Record<string, unknown>);
  for (const v of Object.values(value)) forEachObject(v, fn, depth + 1);
}

function forEachString(value: unknown, fn: (text: string) => void, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  if (typeof value === 'string') {
    fn(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) forEachString(item, fn, depth + 1);
    return;
  }
  for (const v of Object.values(value)) forEachString(v, fn, depth + 1);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
