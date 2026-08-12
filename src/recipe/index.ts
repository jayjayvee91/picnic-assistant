/**
 * Public surface of the recipe layer.
 *
 * The agent imports the registry and the types — never a concrete source — so
 * adding a personal recipe database later is a wiring change, not a rewrite.
 */

export { RecipeRegistry } from './registry.js';
export { PicnicRecipeSource, type PicnicRecipeSourceOptions } from './picnic-source.js';
export { parseRecipeList, parseRecipeDetails } from './fusion-parse.js';
export type { RecipeSource, RecipeSummary, RecipeDetails, RecipeIngredient } from './types.js';
