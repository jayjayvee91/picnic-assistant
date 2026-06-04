/**
 * Recipe URL extraction — best-effort.
 *
 * Step 5 ships only the structured-data path:
 *   1. Fetch the URL.
 *   2. Find `<script type="application/ld+json">` blocks.
 *   3. Walk them for a `@type: Recipe` (or `@graph` containing one).
 *   4. Return ingredient strings (and a few helpful fields like name, servings).
 *
 * If extraction fails, we return `null`. The agent's tool handler then asks
 * the user to paste the ingredients directly — per the always-show rule
 * agreed in grilling, the user reviews extracted ingredients before they
 * land in the draft anyway.
 *
 * The LLM-fallback path (send the page text to Claude and ask it to extract)
 * is deliberately deferred. It would work but adds non-trivial cost and
 * another failure mode for v1. Schema.org Recipe markup is present on most
 * big NL recipe sites (AH, Jumbo, Smulweb, Leukerecepten) so coverage is
 * already decent.
 */

export interface ExtractedRecipe {
  /** Source URL (echoed back). */
  url: string;
  /** Human-readable name if the structured data provided one. */
  name: string | null;
  /** Free-text servings (e.g. "4 personen"). */
  servings: string | null;
  /** Free-text ingredient strings as written in the source. */
  ingredients: string[];
}

export interface RecipeFetchOptions {
  /** Override the fetcher. Default: global `fetch`. Useful for tests. */
  fetcher?: typeof fetch;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fetch a URL and pull ingredients via JSON-LD Recipe markup. Returns null
 * if the page is unreachable, has no JSON-LD recipe, or yields no ingredients.
 */
export async function extractRecipeFromUrl(
  url: string,
  opts: RecipeFetchOptions = {},
): Promise<ExtractedRecipe | null> {
  const fetcher = opts.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let html: string;
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) return null;
    html = await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  return extractRecipeFromHtml(html, url);
}

/**
 * Pure helper: given a raw HTML string, try to extract a Recipe. Separated so
 * tests can pass canned HTML without hitting the network.
 */
export function extractRecipeFromHtml(html: string, url: string): ExtractedRecipe | null {
  for (const block of findLdJsonBlocks(html)) {
    const recipe = findRecipeNode(block);
    if (!recipe) continue;
    const ingredients = normaliseIngredients(recipe.recipeIngredient);
    if (ingredients.length === 0) continue;
    return {
      url,
      name: typeof recipe.name === 'string' ? recipe.name : null,
      servings: extractServings(recipe),
      ingredients,
    };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

interface RecipeNode {
  '@type'?: string | string[];
  name?: unknown;
  recipeIngredient?: unknown;
  recipeYield?: unknown;
}

/**
 * Yield each `application/ld+json` block as a parsed value. Skips malformed
 * blocks rather than throwing — many sites ship slightly broken JSON-LD.
 */
function* findLdJsonBlocks(html: string): Generator<unknown> {
  // Greedy, but anchored at the script tag — handles whitespace and attribute
  // ordering. `[\s\S]` rather than `.` because the body may span lines.
  const re = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const body = match[1];
    if (!body) continue;
    try {
      yield JSON.parse(body) as unknown;
    } catch {
      // Some pages have multiple JSON objects in one block, comma-separated
      // or with stray characters. Worth a single fallback attempt.
      const trimmed = body.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        // Already attempted; nothing else to do.
        continue;
      }
    }
  }
}

/**
 * Walk a parsed JSON-LD value and return the first Recipe-typed node it finds.
 * Handles three common shapes:
 *   - top-level Recipe: { "@type": "Recipe", ... }
 *   - graph wrapper:    { "@graph": [ { "@type": "Recipe", ... }, ... ] }
 *   - array of objects: [ { "@type": "WebPage" }, { "@type": "Recipe", ... } ]
 */
function findRecipeNode(value: unknown): RecipeNode | null {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (isRecipeType(obj['@type'])) return obj as RecipeNode;
  if (Array.isArray(obj['@graph'])) {
    return findRecipeNode(obj['@graph']);
  }
  return null;
}

function isRecipeType(value: unknown): boolean {
  if (typeof value === 'string') return value === 'Recipe';
  if (Array.isArray(value)) return value.some((v) => typeof v === 'string' && v === 'Recipe');
  return false;
}

function normaliseIngredients(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

function extractServings(recipe: RecipeNode): string | null {
  const y = recipe.recipeYield;
  if (typeof y === 'string') return y;
  if (typeof y === 'number') return String(y);
  if (Array.isArray(y) && y.length > 0) {
    const first = y[0];
    if (typeof first === 'string') return first;
    if (typeof first === 'number') return String(first);
  }
  return null;
}
