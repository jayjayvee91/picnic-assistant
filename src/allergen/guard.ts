/**
 * The gluten guard.
 *
 * This is the enforcement half of the coeliac requirement. The household
 * profile states WHAT must be avoided; this module decides, in code, whether a
 * specific Picnic article may enter the cart — on every path, every time.
 *
 * Why code and not a prompt instruction
 * -------------------------------------
 * A line in the system prompt is a request. It asks the model to remember to
 * check, on every product, forever. Models are good but not perfect, and the
 * failure mode here is someone with coeliac disease eating gluten. This
 * codebase already draws that distinction for money — `guards.ts` enforces the
 * daily spend cap in code rather than asking the model to stay under budget. A
 * medical constraint gets at least the same treatment.
 *
 * The decision layers (first match wins)
 * --------------------------------------
 *   0. Override      — a human decision for this specific article. Outranks
 *                      everything, in both directions: "Picnic mislabelled
 *                      this, always block it" and "I know this has gluten and
 *                      I want it anyway".
 *   1. Picnic        — the allergen list Picnic declares for the product. If
 *                      gluten appears there, block. This is the strongest
 *                      automatic signal available.
 *   2. Rulebook      — your own terms (`gluten-rules.md`) matched against the
 *                      product's ingredient declaration. Blocking terms block;
 *                      doubtful terms mark the product unverified.
 *   3. Conclusion    — with no hit from the layers above: allow only when
 *                      Picnic actually declared allergens (so the absence of
 *                      gluten is meaningful); otherwise unverified.
 *
 * The three verdicts
 * ------------------
 *   `blocked`    — must not enter the cart. Only a deliberate, explicit human
 *                  exception can override it, and never the model on its own.
 *   `allowed`    — positively verified free of declared gluten.
 *   `unverified` — we genuinely could not tell. Per the household's chosen
 *                  policy the item is still added, but flagged prominently so
 *                  a human checks it. "No data" NEVER means "safe".
 *
 * Fail-safe posture
 * -----------------
 * Every uncertainty resolves toward caution: a fetch failure, an upstream
 * parser break, an empty allergen list, or an unreadable ingredient text all
 * produce `unverified`, never `allowed`.
 *
 * A note on precision
 * -------------------
 * Picnic's product page distinguishes "Bevat" (contains) from "Bevat mogelijk"
 * (may contain / traces), but the upstream library flattens both into one
 * `allergens` array and drops the headings. That costs us nothing in safety —
 * this household blocks on either — but it does mean a block reason says
 * "staat op de allergenenlijst" rather than distinguishing the two. Recovering
 * the split would require re-parsing the raw Fusion page ourselves.
 */

import type { ProductDetails } from '../picnic/index.js';
import { matchRules, normaliseText, type GlutenRulebook, type RuleMatch } from './rulebook.js';

export type GlutenVerdict = 'blocked' | 'allowed' | 'unverified';

/** Which layer produced the verdict. Mirrors `allergen_decisions.decided_by`. */
export type DecidedBy = 'override' | 'picnic_allergens' | 'rulebook' | 'no_data' | 'exception';

export interface GlutenDecision {
  verdict: GlutenVerdict;
  decidedBy: DecidedBy;
  /** One-line Dutch explanation, suitable to show the user verbatim. */
  reason: string;
  /** Rulebook terms that matched, normalised. Empty unless `decidedBy` is 'rulebook'. */
  matchedTerms: string[];
  /** Picnic's declared allergens as seen, or null when we had no product data. */
  allergens: string[] | null;
  /** The ingredient text evaluated, or null when unavailable. */
  ingredientsText: string | null;
}

/** A human decision for one article, forcing a verdict regardless of the data. */
export interface OverrideInput {
  verdict: 'blocked' | 'allowed';
  reason: string;
}

export interface EvaluateGlutenInput {
  /**
   * Product details from Picnic, or null when the fetch failed / the upstream
   * parser broke. Null is explicitly NOT "safe" — it yields `unverified`.
   */
  details: ProductDetails | null;
  rulebook: GlutenRulebook;
  /** An override for this article, if one exists. */
  override?: OverrideInput | null;
}

/**
 * Allergen names that mean gluten when they appear in Picnic's declared
 * allergen list. Kept here rather than in the rulebook because this list is
 * about Picnic's own vocabulary for the *allergen*, not about ingredient
 * terms — users tune ingredients, not the meaning of the word "gluten".
 *
 * Matching is substring-on-normalised-text so "glutenbevattende granen" and
 * "tarwe (gluten)" both hit.
 */
const GLUTEN_ALLERGEN_NAMES = [
  'gluten',
  'tarwe',
  'spelt',
  'gerst',
  'rogge',
  'haver',
  'kamut',
  'khorasan',
];

/** Title of the product info section holding the ingredient declaration. */
const INGREDIENTS_SECTION = /ingredi/i;

/**
 * Decide whether an article is safe for a coeliac household.
 *
 * Pure: no I/O, no database, no clock. Everything it needs is in the input,
 * which is what makes the decision reproducible and testable with fixtures.
 */
export function evaluateGluten(input: EvaluateGlutenInput): GlutenDecision {
  const { details, rulebook, override } = input;

  const allergens = details ? normaliseAllergenList(details.allergens) : null;
  const ingredientsText = details ? extractIngredientsText(details) : null;

  // ── Layer 0: human override ────────────────────────────────────────
  // Deliberately first: a human who has physically read the packet outranks
  // every heuristic below, in both directions.
  if (override) {
    return {
      verdict: override.verdict,
      decidedBy: 'override',
      reason: override.reason,
      matchedTerms: [],
      allergens,
      ingredientsText,
    };
  }

  // No product data at all — fail safe. This covers a failed fetch and an
  // upstream PDP parser break alike.
  if (!details) {
    return {
      verdict: 'unverified',
      decidedBy: 'no_data',
      reason:
        'Kon de productgegevens niet ophalen bij Picnic, dus glutenstatus is onbekend. ' +
        'Controleer dit product zelf.',
      matchedTerms: [],
      allergens: null,
      ingredientsText: null,
    };
  }

  // ── Layer 1: Picnic's declared allergens ───────────────────────────
  const declaredGluten = (allergens ?? []).filter((a) => mentionsGluten(a));
  if (declaredGluten.length > 0) {
    return {
      verdict: 'blocked',
      decidedBy: 'picnic_allergens',
      reason:
        `Picnic vermeldt dit als allergeen: ${declaredGluten.join(', ')}. ` +
        'Bevat gluten of mogelijk sporen daarvan.',
      matchedTerms: [],
      allergens,
      ingredientsText,
    };
  }

  // ── Layer 2: your rulebook against the ingredient declaration ──────
  if (ingredientsText !== null && ingredientsText.length > 0) {
    const matches = matchRules(ingredientsText, rulebook);
    const blocking = matches.filter((m) => m.section === 'Bevat gluten');
    if (blocking.length > 0) {
      return {
        verdict: 'blocked',
        decidedBy: 'rulebook',
        reason: `Ingrediënten bevatten ${listTerms(blocking)} — dat staat in je glutenregels als "bevat gluten".`,
        matchedTerms: blocking.map((m) => m.term),
        allergens,
        ingredientsText,
      };
    }

    const doubtful = matches.filter((m) => m.section === 'Twijfel');
    if (doubtful.length > 0) {
      return {
        verdict: 'unverified',
        decidedBy: 'rulebook',
        reason:
          `Ingrediënten bevatten ${listTerms(doubtful)} — dat staat in je glutenregels als ` +
          'twijfelgeval. Niet zeker of er gluten in zit; controleer dit zelf.',
        matchedTerms: doubtful.map((m) => m.term),
        allergens,
        ingredientsText,
      };
    }
  }

  // ── Layer 3: conclusion ────────────────────────────────────────────
  // A non-empty allergen list means Picnic actively declared allergens for
  // this product. Gluten being absent from that list is therefore meaningful,
  // and is the strongest "safe" signal we can get.
  if (allergens !== null && allergens.length > 0) {
    return {
      verdict: 'allowed',
      decidedBy: 'picnic_allergens',
      reason:
        `Picnic declareert allergenen (${allergens.join(', ')}) en gluten staat er niet bij` +
        (ingredientsText ? ', en de ingrediënten bevatten geen glutenterm.' : '.'),
      matchedTerms: [],
      allergens,
      ingredientsText,
    };
  }

  // Empty allergen list is ambiguous: it can mean "no allergens" or "no data".
  // We cannot tell the two apart, so we do not claim safety.
  return {
    verdict: 'unverified',
    decidedBy: 'no_data',
    reason: ingredientsText
      ? 'Picnic geeft geen allergeneninformatie voor dit product. De ingrediënten ' +
        'bevatten geen bekende glutenterm, maar dat is geen garantie — controleer zelf.'
      : 'Picnic geeft geen allergenen- of ingrediënteninformatie voor dit product. ' +
        'Glutenstatus onbekend; controleer zelf.',
    matchedTerms: [],
    allergens,
    ingredientsText,
  };
}

/**
 * Apply a deliberate, human-authorised exception to a decision.
 *
 * Separate from `evaluateGluten` on purpose: the guard itself has no notion of
 * "allow anyway", so no amount of model confusion inside the normal add path
 * can produce one. Reaching this function requires the caller to have taken
 * the dedicated exception route, which the system prompt gates behind an
 * explicit human acknowledgement of the gluten.
 */
export function applyException(decision: GlutenDecision, acknowledgement: string): GlutenDecision {
  return {
    ...decision,
    verdict: 'allowed',
    decidedBy: 'exception',
    reason: `Bewuste uitzondering: ${acknowledgement} (oorspronkelijk: ${decision.reason})`,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/** True if an allergen label refers to gluten or a gluten-bearing grain. */
function mentionsGluten(allergen: string): boolean {
  const normalised = normaliseText(allergen);
  if (normalised.length === 0) return false;
  // "glutenvrij" is a claim of absence, not a declaration of presence — and it
  // does appear in allergen blocks on some products.
  if (normalised.includes('glutenvrij')) return false;
  return GLUTEN_ALLERGEN_NAMES.some((name) => normalised.includes(name));
}

/** Defensive: the upstream type says string[], but the parser is experimental. */
function normaliseAllergenList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

/**
 * Pull the ingredient declaration out of the product's info sections. Returns
 * null when there is no such section — distinct from an empty string, because
 * "no ingredients section" and "empty ingredients section" are both unknown
 * but we want the reason text to be honest about which.
 */
function extractIngredientsText(details: ProductDetails): string | null {
  const sections = Array.isArray(details.infoSections) ? details.infoSections : [];
  const section = sections.find(
    (s) => typeof s?.title === 'string' && INGREDIENTS_SECTION.test(s.title),
  );
  if (!section || typeof section.content !== 'string') return null;
  const text = section.content.replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

function listTerms(matches: RuleMatch[]): string {
  return matches.map((m) => `"${m.term}"`).join(', ');
}
