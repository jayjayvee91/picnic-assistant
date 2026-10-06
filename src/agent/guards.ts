/**
 * Guards: tool-call iteration cap, conversation token cap, daily API spend
 * kill-switch.
 *
 * These three guards together bound the worst case if Claude or our code
 * misbehaves — see the grilling agreement (Q7) for the rationale and limits.
 */

import { recordApiSpend, getTodayApiSpend, getMeta, setMeta, type DB } from '../memory/index.js';

// ──────────────────────────────────────────────────────────────────────
// Tool-call iteration cap
// ──────────────────────────────────────────────────────────────────────

/**
 * Per-turn tool-call cap. The point is to catch **runaway loops** (Claude
 * gets confused and calls the same tool a thousand times) — NOT to bound
 * legitimate multi-step work. A weekly draft naturally needs ~2 tool calls
 * per item (search Picnic, then add_to_draft), so 30-40 calls is real,
 * normal work for a 15-20-item shop.
 *
 * 50 is comfortably above legitimate use and well below runaway. The actual
 * cost ceiling is the daily €2 spend kill-switch, not this cap.
 */
export const MAX_TOOL_CALLS_PER_TURN = 50;

export class IterationCapExceededError extends Error {
  constructor() {
    super(
      `Agent hit the per-turn tool-call cap of ${MAX_TOOL_CALLS_PER_TURN}. ` +
        `Stopping to avoid a runaway loop.`,
    );
    this.name = 'IterationCapExceededError';
  }
}

// ──────────────────────────────────────────────────────────────────────
// Anthropic spend tracking + daily kill-switch
// ──────────────────────────────────────────────────────────────────────

/**
 * Per-million-token prices for Claude Sonnet 4.5 in USD as of writing. Update
 * here when Anthropic changes pricing or we change models. Cache reads are
 * roughly a 10× discount over fresh input, which is the whole point of the
 * caching design in the system prompt.
 */
export const SONNET_PRICING_USD_PER_MTOK = {
  input: 3.0,
  output: 15.0,
  cacheWrite: 3.75,
  cacheRead: 0.3,
} as const;

/** Rough USD→EUR rate. We don't need precision; this gates a soft cap. */
const USD_TO_EUR = 0.92;

export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Translate Anthropic API usage into an estimated EUR cost. We sum the four
 * token kinds at their respective prices and convert USD→EUR.
 *
 * Returned in EUR so the kill-switch can compare directly to the configured
 * `DAILY_SPEND_LIMIT_EUR` env var.
 */
export function estimateCostEur(usage: AnthropicUsage): number {
  const p = SONNET_PRICING_USD_PER_MTOK;
  const usd =
    (usage.inputTokens * p.input) / 1_000_000 +
    (usage.outputTokens * p.output) / 1_000_000 +
    ((usage.cacheCreationInputTokens ?? 0) * p.cacheWrite) / 1_000_000 +
    ((usage.cacheReadInputTokens ?? 0) * p.cacheRead) / 1_000_000;
  return usd * USD_TO_EUR;
}

export class DailySpendCapExceededError extends Error {
  constructor(spentEur: number, limitEur: number) {
    super(
      `Daglimiet bereikt: vandaag is €${spentEur.toFixed(2)} aan Anthropic-API ` +
        `uitgegeven (limiet: €${limitEur.toFixed(2)}). De bot stopt tot middernacht ` +
        `of tot iemand handmatig /start typt.`,
    );
    this.name = 'DailySpendCapExceededError';
  }
}

/**
 * Returns the remaining EUR budget for today. If the daily limit has been
 * exceeded, throws `DailySpendCapExceededError`. Call this BEFORE making the
 * Anthropic API call so we fail fast.
 */
export function assertWithinDailySpendCap(db: DB, limitEur: number): void {
  const spent = getTodayApiSpend(db);
  if (spent >= limitEur) {
    throw new DailySpendCapExceededError(spent, limitEur);
  }
}

/** Share of the daily limit at which the household gets a heads-up. */
export const BUDGET_WARNING_FRACTION = 0.75;

const KEY_BUDGET_WARNED_ON = 'budget_warning_sent_utc_date';

/**
 * The Dutch heads-up to post when today's spend has passed
 * `BUDGET_WARNING_FRACTION` of the limit — at most once per day, so a weekly
 * shop is never cut off without warning, and never nagged either. Returns
 * null when there is nothing to say.
 */
export function takeBudgetWarning(db: DB, limitEur: number, now = new Date()): string | null {
  const spent = getTodayApiSpend(db, now);
  if (spent < limitEur * BUDGET_WARNING_FRACTION) return null;
  const today = now.toISOString().slice(0, 10);
  if (getMeta(db, KEY_BUDGET_WARNED_ON) === today) return null;
  setMeta(db, KEY_BUDGET_WARNED_ON, today);
  const eur = (n: number) => `€${n.toFixed(2).replace('.', ',')}`;
  return (
    `Let op: vandaag is al ${eur(spent)} van de daglimiet van ${eur(limitEur)} ` +
    `aan de Anthropic-API uitgegeven. Bij de limiet stopt de bot tot middernacht.`
  );
}

/**
 * Record this call's cost. Should be invoked after every successful
 * `messages.create()` so the next call's cap check sees the true total.
 */
export function recordCallCost(db: DB, usage: AnthropicUsage): number {
  const eur = estimateCostEur(usage);
  recordApiSpend(db, eur);
  return eur;
}

// ──────────────────────────────────────────────────────────────────────
// Conversation token cap (rough heuristic)
// ──────────────────────────────────────────────────────────────────────

/**
 * Above this many (rough) tokens of prior conversation, the oldest part is
 * dropped. An emergency brake, not a budget: with the conversation cached, a
 * long weekly shop is cheap to keep, while every trim forgets recent context
 * and breaks the cache. A busy shop is ~40k; this leaves room for two and stays
 * well inside the model's context window.
 */
export const CONVERSATION_TOKEN_SOFT_CAP = 100_000;

/**
 * Very rough token estimate: 1 token ≈ 4 chars. Good enough for the soft cap
 * since we only need to know if we're in "starting to grow" territory. Real
 * usage numbers come from the API response after the call.
 */
export function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
