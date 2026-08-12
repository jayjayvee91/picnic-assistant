/**
 * The recipe-source registry.
 *
 * This is the seam that makes "combine Picnic with a personal recipe database
 * later" a configuration change rather than a rewrite. The agent tools query
 * the registry, never a specific source, so adding a second source means
 * constructing it and registering it — no tool definitions change, no system
 * prompt changes.
 *
 * Ids are namespaced as `<source>:<id>` when crossing the registry boundary,
 * because two sources can legitimately use the same internal id. Callers pass
 * the qualified id back and the registry routes it.
 */

import type { RecipeDetails, RecipeSource, RecipeSummary } from './types.js';

export class RecipeRegistry {
  private readonly sources: RecipeSource[] = [];

  constructor(sources: RecipeSource[] = []) {
    for (const s of sources) this.register(s);
  }

  register(source: RecipeSource): void {
    if (this.sources.some((s) => s.name === source.name)) {
      throw new Error(`Recipe source "${source.name}" is already registered.`);
    }
    this.sources.push(source);
  }

  get sourceNames(): string[] {
    return this.sources.map((s) => s.name);
  }

  /**
   * List recipes across every registered source.
   *
   * A failing source does NOT fail the whole call — it is reported instead, so
   * one broken source cannot leave the household with no menu suggestions at
   * all. The caller can surface which sources were unavailable.
   */
  async listRecipes(
    opts: { savedOnly?: boolean } = {},
  ): Promise<{ recipes: RecipeSummary[]; failures: Array<{ source: string; error: string }> }> {
    const recipes: RecipeSummary[] = [];
    const failures: Array<{ source: string; error: string }> = [];

    for (const source of this.sources) {
      try {
        const found = await source.listRecipes(opts);
        for (const r of found) recipes.push({ ...r, id: qualify(source.name, r.id) });
      } catch (err) {
        failures.push({
          source: source.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { recipes, failures };
  }

  /**
   * Details for a qualified id (`picnic:6335ac…`). An unqualified id is tried
   * against every source, so ids taken from a listing keep working even if a
   * caller strips the prefix.
   */
  async getRecipeDetails(qualifiedId: string): Promise<RecipeDetails | null> {
    const { sourceName, id } = unqualify(qualifiedId);

    if (sourceName) {
      const source = this.sources.find((s) => s.name === sourceName);
      if (!source) return null;
      const details = await source.getRecipeDetails(id);
      return details ? { ...details, id: qualify(source.name, details.id) } : null;
    }

    for (const source of this.sources) {
      const details = await source.getRecipeDetails(id);
      if (details) return { ...details, id: qualify(source.name, details.id) };
    }
    return null;
  }
}

function qualify(source: string, id: string): string {
  return id.startsWith(`${source}:`) ? id : `${source}:${id}`;
}

function unqualify(value: string): { sourceName: string | null; id: string } {
  const idx = value.indexOf(':');
  if (idx <= 0) return { sourceName: null, id: value };
  return { sourceName: value.slice(0, idx), id: value.slice(idx + 1) };
}
