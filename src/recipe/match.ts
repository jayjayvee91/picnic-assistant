/**
 * Matching a search phrase against a recipe name.
 *
 * This lives in the recipe layer rather than in the agent's tool handlers
 * because it is recipe-domain logic, and because keeping it here makes it
 * directly testable by `npm run smoke:recipe` without the agent's credentials.
 *
 * Why the matching is deliberately generous
 * -----------------------------------------
 * A plain substring test shipped a real defect: asked about "Quinoabowl met
 * bloemkool en pompoen" — the household's own saved recipe — a query phrased
 * slightly differently matched nothing, and the assistant reported that the
 * recipe was not saved. Confidently denying something the household owns is
 * far worse than returning a few extra candidates for them to pick from, so
 * every ambiguity here resolves towards showing more.
 */

/**
 * Dutch filler words, dropped before matching.
 *
 * Every remaining word must appear in the name, so any word kept here becomes
 * mandatory. Left in, "met" would make the query "recept met kip" require the
 * literal string "met" in the recipe's title — reintroducing exactly the
 * false-negative the word-based match was written to fix.
 *
 * Kept deliberately short: each entry is a word that can never distinguish one
 * recipe from another. Ingredient and dish words never belong here.
 */
const STOPWORDS = new Set([
  'de',
  'het',
  'een',
  'en',
  'met',
  'van',
  'voor',
  'in',
  'op',
  'uit',
  'aan',
  'of',
  'recept',
  'recepten',
]);

/** Lower-case and strip diacritics, so "soufflé" matches "souffle". */
function normalise(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Split a phrase into the words that are allowed to decide a match.
 *
 * Exported so the smoke test can assert on the tokens directly — a match
 * failure is much easier to diagnose when you can see what the query was
 * actually reduced to.
 */
export function significantWords(query: string): string[] {
  return normalise(query)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * True when every significant word in `query` appears somewhere in `name`,
 * in any order, ignoring case and diacritics.
 *
 * A query with no significant words (empty, punctuation only, or nothing but
 * filler) matches everything. That is the safe direction: the caller shows the
 * full list rather than an empty result that reads as "you have no such
 * recipe".
 */
export function matchesRecipeQuery(name: string, query: string): boolean {
  const words = significantWords(query);
  if (words.length === 0) return true;

  const haystack = normalise(name);
  return words.every((w) => haystack.includes(w));
}
