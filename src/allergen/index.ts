/**
 * Public surface of the allergen guard.
 *
 * The agent and Telegram layers import from here only. The split inside:
 *   - `guard.ts`    pure decision engine (fixtures-testable, no I/O)
 *   - `rulebook.ts` the human-editable rules file and its parser
 *   - `check.ts`    the impure orchestration (Picnic fetch, cache, audit log)
 */

export {
  evaluateGluten,
  applyException,
  type GlutenVerdict,
  type GlutenDecision,
  type DecidedBy,
  type EvaluateGlutenInput,
  type OverrideInput,
} from './guard.js';

export {
  loadRulebook,
  ensureRulebookSeeded,
  appendRule,
  parseRulebook,
  matchRules,
  normaliseText,
  insertBullet,
  EMPTY_RULEBOOK,
  type GlutenRulebook,
  type RuleSection,
  type RuleMatch,
} from './rulebook.js';

export {
  AllergenChecker,
  verdictLabel,
  GLUTEN,
  type AllergenCheckerOptions,
  type CheckResult,
} from './check.js';
