/**
 * Recipe domain types — deliberately source-agnostic.
 *
 * Picnic is the first implementation, but the household plans to add a
 * personal recipe database later. Nothing in these types mentions Picnic, so a
 * second source slots in behind the same interface without the agent tools or
 * the system prompt changing at all.
 *
 * The one Picnic-shaped concession is `articleId` on an ingredient, and it
 * earns its place: Picnic's recipe pages hand back the actual selling-unit id
 * for each ingredient, which is what makes both the gluten guard and the
 * brand-preference logic exact rather than name-matched. Sources that cannot
 * supply it leave it null and the ingredient is resolved by name instead.
 */

/** A recipe as it appears in a listing — enough to show and pick from. */
export interface RecipeSummary {
  /** Stable id within its source. */
  id: string;
  name: string;
  /** Which source produced this. Lets the agent say where a suggestion came from. */
  source: string;
  /** True when the household has explicitly saved/favourited it. */
  saved: boolean;
  /** Source-specific image reference, if any. */
  image?: string | null;
}

/** One ingredient of a recipe. */
export interface RecipeIngredient {
  /** Id within the recipe. Not a product id. */
  ingredientId: string;
  /** Human-readable name, when the source provides one. */
  name: string | null;
  /**
   * The grocery article this ingredient maps to, when the source knows it.
   * For Picnic this is a selling-unit id like "s1012860" — directly usable
   * with the allergen guard and the cart, no search step required.
   */
  articleId: string | null;
  /** How many of `articleId` the recipe needs at the stated portion count. */
  requiredAmount: number;
  /** Price in cents for one unit, when known. */
  priceCents: number | null;
  /** False when Picnic currently cannot supply it. */
  available: boolean;
  /**
   * CORE ingredients define the dish; non-core are pantry extras the app
   * pre-selects less aggressively. Kept so the agent can treat "olive oil you
   * already own" differently from "the chorizo".
   */
  core: boolean;
}

/** A recipe with everything needed to build a shopping list from it. */
export interface RecipeDetails {
  id: string;
  name: string | null;
  source: string;
  /** Portions the ingredient amounts correspond to. */
  portions: number | null;
  ingredients: RecipeIngredient[];
}

/**
 * A place recipes come from. Implemented by `PicnicRecipeSource` today; a
 * personal-database source can be added later without touching callers.
 */
export interface RecipeSource {
  /** Short stable name, e.g. "picnic". Appears in `RecipeSummary.source`. */
  readonly name: string;

  /**
   * List recipes. `savedOnly` asks for just the household's saved/favourited
   * ones; a source with no concept of saving may ignore it and return
   * everything with `saved: false`.
   */
  listRecipes(opts?: { savedOnly?: boolean }): Promise<RecipeSummary[]>;

  /** Full detail for one recipe, or null when this source does not have it. */
  getRecipeDetails(id: string): Promise<RecipeDetails | null>;
}
