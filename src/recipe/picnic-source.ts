/**
 * Picnic as a recipe source.
 *
 * Thin: it fetches the two Fusion pages and hands them to the pure parsers in
 * `fusion-parse.ts`. All the fragile knowledge (which page, which parameter
 * name, where the data hides) lives in `PicnicClient` and the parser, so this
 * file stays readable.
 *
 * Caching matters more here than elsewhere. The saved-recipes page is ~8.5 MB
 * and a recipe detail page ~2.9 MB; re-fetching either inside a single
 * menu-planning conversation would be wasteful and slow. Both are cached for
 * the process lifetime with a short TTL.
 */

import type { PicnicClient } from '../picnic/index.js';
import { parseRecipeDetails, parseRecipeList } from './fusion-parse.js';
import type { RecipeDetails, RecipeSource, RecipeSummary } from './types.js';

export interface PicnicRecipeSourceOptions {
  picnic: PicnicClient;
  /** How long fetched pages stay cached, in ms. Default 10 minutes. */
  cacheTtlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  at: number;
}

export class PicnicRecipeSource implements RecipeSource {
  readonly name = 'picnic';

  private readonly opts: PicnicRecipeSourceOptions;
  private savedCache: CacheEntry<RecipeSummary[]> | null = null;
  private readonly detailCache = new Map<string, CacheEntry<RecipeDetails | null>>();

  constructor(opts: PicnicRecipeSourceOptions) {
    this.opts = opts;
  }

  /**
   * The household's saved recipes.
   *
   * `savedOnly: false` currently returns the same list. The meals overview
   * does carry a browsable catalogue, but only as carousels capped at ~20 per
   * category — so it is not a usable "all recipes" listing, and pretending
   * otherwise would give the agent a misleadingly narrow view of what Picnic
   * offers. Saved recipes are the reliable set, and the household's own
   * favourites are the better menu source anyway.
   */
  async listRecipes(opts: { savedOnly?: boolean } = {}): Promise<RecipeSummary[]> {
    void opts;
    const now = this.clock();
    if (this.savedCache && now - this.savedCache.at < this.ttl()) {
      return this.savedCache.value;
    }
    const page = await this.opts.picnic.getSavedRecipesPage();
    const recipes = parseRecipeList(page, { saved: true });
    this.savedCache = { value: recipes, at: now };
    return recipes;
  }

  async getRecipeDetails(id: string): Promise<RecipeDetails | null> {
    const now = this.clock();
    const cached = this.detailCache.get(id);
    if (cached && now - cached.at < this.ttl()) return cached.value;

    const page = await this.opts.picnic.getRecipeDetailsPage(id);
    const details = parseRecipeDetails(page, id);
    this.detailCache.set(id, { value: details, at: now });
    return details;
  }

  /** Drop cached pages — used when a conversation runs long. */
  clearCache(): void {
    this.savedCache = null;
    this.detailCache.clear();
  }

  private ttl(): number {
    return this.opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  }

  private clock(): number {
    return (this.opts.now ?? Date.now)();
  }
}
