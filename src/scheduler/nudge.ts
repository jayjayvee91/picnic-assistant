/**
 * Weekly nudge composition.
 *
 * Per the design we agreed in grilling Q2 + Q4:
 *   - Fires Thursday 20:00 Europe/Amsterdam (configurable for tests).
 *   - One message that *invites* the user to start the weekly-draft flow —
 *     it does NOT proactively call the agent. The agent only runs when the
 *     user replies. This keeps the nudge cheap and predictable.
 *   - Includes a recap question (Step 8): "how did last week go, anything I
 *     should remember?". Reply flows through the existing
 *     propose_profile_addition tool via the normal agent loop.
 */

import { getRecentOrders, type DB } from '../memory/index.js';

export interface NudgeMessageContext {
  db: DB;
  /** Override "now" for tests; defaults to the real clock. */
  now?: Date;
}

/**
 * Build the Dutch nudge text. Pure function so it's trivially testable and
 * the cron job can pass it through Telegraf as a plain string.
 */
export function buildWeeklyNudge(ctx: NudgeMessageContext): string {
  const now = ctx.now ?? new Date();
  const recent = getRecentOrders(ctx.db, 1);
  const lastOrder = recent[0];

  const context = lastOrder
    ? `Vorige bestelling: ${formatRelativeDays(lastOrder.creationTime, now)}.`
    : '(Nog geen bestelhistorie vastgelegd.)';

  return [
    'Donderdagavond — tijd voor de wekelijkse boodschappen.',
    '',
    context,
    '',
    // Recap question (Step 8). Light-touch — easy to ignore if nothing
    // memorable happened. Reply goes through `propose_profile_addition`.
    'Hoe ging de bestelling van vorige week? Moet ik iets onthouden voor de volgende keer?',
    '',
    'Zal ik een lijst voor deze week voorstellen? Zeg "ja" of "doe maar" om te starten.',
  ].join('\n');
}

/** "5 dagen geleden", "1 dag geleden", "vandaag" — small human helper. */
export function formatRelativeDays(isoTimestamp: string, now: Date): string {
  const then = Date.parse(isoTimestamp);
  if (!Number.isFinite(then)) return 'onbekend';
  const diffMs = now.getTime() - then;
  const days = Math.floor(diffMs / 86_400_000);
  if (days <= 0) return 'vandaag';
  if (days === 1) return '1 dag geleden';
  return `${days} dagen geleden`;
}
