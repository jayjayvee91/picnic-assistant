/**
 * Allergen checking — the impure layer around the pure `evaluateGluten` engine.
 *
 * Responsibilities:
 *   - Fetch product details from Picnic (cached; one PDP call per article per
 *     run, because a 20-item weekly draft would otherwise be 20 extra calls).
 *   - Load the rulebook fresh from disk so hand edits apply immediately.
 *   - Look up any human override for the article.
 *   - Run the pure engine.
 *   - Write the decision to the audit trail — always, for every verdict.
 *
 * Error posture
 * -------------
 * A failed PDP fetch becomes `unverified` (never `allowed`), EXCEPT for
 * `AuthRequiredError`, which propagates. That distinction matters: an expired
 * Picnic session is a recoverable condition the Telegram layer handles with
 * the `/sms` re-auth flow, and silently degrading every product to "unverified"
 * would hide it — turning a fixable auth problem into a stream of unexplained
 * warnings on a safety feature.
 */

import { AuthRequiredError, type PicnicClient, type ProductDetails } from '../picnic/index.js';
import {
  getAllergenOverride,
  deleteAllergenOverride,
  logAllergenDecision,
  type DB,
} from '../memory/index.js';
import { loadRulebook, type GlutenRulebook } from './rulebook.js';
import { evaluateGluten, type GlutenDecision } from './guard.js';

/** The allergen this guard covers in v1. */
export const GLUTEN = 'gluten';

export interface AllergenCheckerOptions {
  db: DB;
  picnic: PicnicClient;
  /** Path to `gluten-rules.md`. */
  rulebookPath: string;
  /** How long a fetched PDP stays cached, in ms. Default 15 minutes. */
  cacheTtlMs?: number;
  /** Override the clock for tests. */
  now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  details: ProductDetails | null;
  fetchedAt: number;
}

export interface CheckResult extends GlutenDecision {
  articleId: string;
  articleName: string | null;
  /** Row id in `allergen_decisions`, so a reply can point at the audit trail. */
  decisionId: number;
}

/**
 * Stateful checker: holds the PDP cache for the process lifetime. One instance
 * is shared by the agent context so a single weekly draft reuses fetches.
 */
export class AllergenChecker {
  private readonly opts: AllergenCheckerOptions;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: AllergenCheckerOptions) {
    this.opts = opts;
  }

  /**
   * Evaluate one article and record the decision.
   *
   * `articleName` is only used for logging and display — the verdict never
   * depends on it.
   */
  async check(articleId: string, articleName: string | null = null): Promise<CheckResult> {
    const rulebook = await this.loadRules();
    const override = getAllergenOverride(this.opts.db, articleId, GLUTEN);
    const details = await this.fetchDetails(articleId);

    const decision = evaluateGluten({
      details,
      rulebook,
      override: override ? { verdict: override.verdict, reason: override.reason } : null,
    });

    // A one-off override is consumed the moment it is used, so a single
    // deliberate exception cannot silently become a standing rule.
    if (override && override.scope === 'once') {
      deleteAllergenOverride(this.opts.db, articleId, GLUTEN);
    }

    const decisionId = logAllergenDecision(this.opts.db, {
      articleId,
      articleName,
      allergen: GLUTEN,
      verdict: decision.verdict,
      decidedBy: decision.decidedBy,
      reason: decision.reason,
      allergens: decision.allergens,
      ingredientsText: decision.ingredientsText,
      matchedTerms: decision.matchedTerms,
    });

    return { ...decision, articleId, articleName, decisionId };
  }

  /** Drop cached product data (e.g. after a long-running conversation). */
  clearCache(): void {
    this.cache.clear();
  }

  private async loadRules(): Promise<GlutenRulebook> {
    return await loadRulebook(this.opts.rulebookPath);
  }

  /**
   * Fetch product details, cached. Returns null when Picnic could not give us
   * usable data — the caller treats that as "unknown", never "safe".
   */
  private async fetchDetails(articleId: string): Promise<ProductDetails | null> {
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

    const cached = this.cache.get(articleId);
    if (cached && now - cached.fetchedAt < ttl) {
      return cached.details;
    }

    let details: ProductDetails | null;
    try {
      details = await this.opts.picnic.getProductDetails(articleId);
    } catch (err) {
      // An expired session is a distinct, recoverable problem — surface it
      // rather than burying it as "unverified".
      if (err instanceof AuthRequiredError) throw err;
      console.warn(
        `[allergen] could not fetch product details for ${articleId}: ` +
          `${err instanceof Error ? err.message : String(err)}. Treating as unverified.`,
      );
      details = null;
    }

    this.cache.set(articleId, { details, fetchedAt: now });
    return details;
  }
}

/**
 * Short Dutch label for a verdict, for use in chat replies and draft listings.
 * Kept here so every surface phrases the same verdict identically.
 */
export function verdictLabel(verdict: GlutenDecision['verdict']): string {
  switch (verdict) {
    case 'blocked':
      return 'BEVAT GLUTEN — geblokkeerd';
    case 'unverified':
      return 'NIET GEVERIFIEERD — zelf controleren';
    case 'allowed':
      return 'glutenvrij voor zover Picnic aangeeft';
  }
}
