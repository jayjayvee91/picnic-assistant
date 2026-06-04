/**
 * System prompt builder.
 *
 * Structured so the cacheable parts (instructions, tool guidance, profile,
 * purchase summary) live in one block and the per-turn dynamic parts (today's
 * date, latest orders) live in another. The Anthropic SDK supports
 * `cache_control` on individual system blocks — see `client.ts`.
 *
 * Everything user-facing is in Dutch (per the locked tone decision). System
 * instructions to Claude are in English — that's what the model is most
 * reliable in, even when its output is in another language.
 */

import {
  loadStoredSummary,
  getRecentOrders,
  loadProfile,
  type DB,
  type PurchaseSummary,
} from '../memory/index.js';

export interface SystemPromptContext {
  /** Open SQLite handle (Step 3). */
  db: DB;
  /** Path to `profile.md`. */
  profilePath: string;
  /** ISO timestamp of "now" — passed in so tests can pin it. */
  now: Date;
  /** Telegram first name of whoever sent the latest message (or null). */
  speakerName: string | null;
}

export interface SystemPromptBlocks {
  /** Stable across turns; cache-eligible. */
  staticBlock: string;
  /** Changes per turn — date, recent orders, current speaker. Not cached. */
  dynamicBlock: string;
}

/**
 * Produce the two halves of the system prompt. The caller passes them to
 * `messages.create` as separate text blocks with `cache_control` on the
 * static one.
 */
export async function buildSystemPrompt(ctx: SystemPromptContext): Promise<SystemPromptBlocks> {
  const summary = loadStoredSummary(ctx.db);
  const profile = await loadProfile(ctx.profilePath);
  const recentOrders = recentOrdersBlock(ctx.db);

  const staticBlock = [
    AGENT_ROLE,
    '',
    AGENT_TONE,
    '',
    TOOL_USE_DISCIPLINE,
    '',
    HYBRID_COMMIT_RULES,
    '',
    PROFILE_USAGE_RULES,
    '',
    RECIPE_RULES,
    '',
    '# Huishoudprofiel',
    profile,
    '',
    '# Typische boodschappen (laatste 6 maanden)',
    summaryBlock(summary),
  ].join('\n');

  const dynamicBlock = [
    '# Vandaag',
    formatToday(ctx.now),
    ctx.speakerName ? `Wie er nu praat: ${ctx.speakerName}.` : '',
    '',
    '# Laatste bestellingen',
    recentOrders,
  ]
    .filter((s) => s !== '')
    .join('\n');

  return { staticBlock, dynamicBlock };
}

// ──────────────────────────────────────────────────────────────────────
// Static instruction blocks
// ──────────────────────────────────────────────────────────────────────

const AGENT_ROLE = `You are a personal grocery assistant for a single Dutch household. \
You help Jeroen and his partner plan and place weekly orders at Picnic \
(picnic.nl). All your output is in Dutch.`;

const AGENT_TONE = `# Tone
- Reply in Dutch using the informal "je" form.
- Plain, direct, no filler or cheery exclamations.
- No emojis.
- When uncertain about anything — a product choice, a quantity, what the user wants \
— ask a short clarifying question instead of guessing.`;

const TOOL_USE_DISCIPLINE = `# Tool use — be economical
- The typical basket and last orders are ALREADY in this system prompt. \
Use them. Don't search Picnic again for items whose article id you can see \
in the recent-orders section — the article ids there are the same ids \
search_picnic_products would return.
- For a weekly draft of ~15-20 items, aim for ~30-40 tool calls total. \
A hard cap of 50 stops runaways; you should never need that many.
- Group your searches: when the user asks "stel de boodschappen voor", do \
NOT search → propose → search → propose item by item. Build the draft in \
one pass and present it as a whole list. The user reviews the WHOLE list \
in chat before you commit.`;

const HYBRID_COMMIT_RULES = `# Hoe je met de boodschappenlijst omgaat (BELANGRIJK)

There are TWO modes. Pick one per message:

**Draft mode** (the WEEKLY shop)
- Triggered when the user asks you to propose this week's order ("wat moeten \
we kopen?", "stel de boodschappen voor", or a Thursday-evening nudge).
- Build a list using \`add_to_draft\` / \`remove_from_draft\`. The Picnic cart \
itself is NOT touched yet.
- Show the draft in chat for review. Only when the user explicitly approves \
("ja", "doe maar", "klaar"), call \`commit_draft_to_cart\` — that pushes \
everything to Picnic in one atomic step and clears the draft.

**Live mode** (ad-hoc adds)
- Triggered when the user wants to add something specific NOW ("voeg \
olijfolie toe", "doe nog wat pasta erbij").
- Skip the draft entirely. Use \`add_to_cart_now\` to add directly to Picnic.

If the user's intent is genuinely unclear (e.g. "doe alvast wat voor het \
weekend"), ASK which mode they want before doing either. Never silently \
mix modes.

Both modes finish with a short Dutch confirmation in chat (what you added, \
how many, where).`;

const PROFILE_USAGE_RULES = `# Het huishoudprofiel
- The profile is loaded fresh each turn — assume it's current.
- Honour brand rules and dislikes when picking specific Picnic products.
- NEVER silently extend the profile. When you learn something new \
(e.g. "we always pick X over Y"), call \`propose_profile_addition\` to \
suggest the new line. Only call \`commit_profile_addition\` after the user \
explicitly approves. No drift.`;

const RECIPE_RULES = `# Recepten
- The user may paste a recipe URL, name a Picnic recipe, or list ingredients \
directly.
- For URLs: call \`fetch_recipe_url\`. ALWAYS show the extracted ingredient \
list back in Dutch before mapping it to Picnic products. If extraction \
returns nothing, ask the user to paste the ingredients.
- For each ingredient, search Picnic with \`search_picnic_products\` and \
propose ONE specific product (with name + unit_quantity). Let the user swap \
before adding to draft/cart.`;

// ──────────────────────────────────────────────────────────────────────
// Dynamic blocks
// ──────────────────────────────────────────────────────────────────────

function summaryBlock(summary: PurchaseSummary | null): string {
  if (!summary || summary.ordersCount === 0) {
    return '(Nog geen bestelhistorie beschikbaar — bootstrap niet gedraaid of leeg.)';
  }
  const lines: string[] = [];
  lines.push(
    `Aantal bestellingen in historie: ${summary.ordersCount}. ` +
      (summary.avgIntervalDays !== null
        ? `Gemiddeld om de ${summary.avgIntervalDays.toFixed(1)} dagen.`
        : ''),
  );
  if (summary.lastOrderAt) {
    lines.push(`Meest recente bestelling: ${summary.lastOrderAt.slice(0, 10)}.`);
  }
  lines.push(
    'Top producten (article id — naam — frequentie × gemiddelde hoeveelheid per bestelling):',
  );
  for (const item of summary.typicalBasket.slice(0, 20)) {
    const unit = item.unitQuantity ? ` (${item.unitQuantity})` : '';
    lines.push(
      `- \`${item.articleId}\` — ${item.name}${unit} — ${item.timesOrdered}× besteld, ~${item.avgQuantityPerOrder} per keer`,
    );
  }
  return lines.join('\n');
}

function recentOrdersBlock(db: DB): string {
  const orders = getRecentOrders(db, 8);
  if (orders.length === 0) return '(Nog geen bestellingen vastgelegd.)';
  return orders
    .map((o) => {
      const date = o.creationTime.slice(0, 10);
      const itemList = o.items
        .map((it) => `  - \`${it.articleId}\` — ${it.quantity}× ${it.articleName}`)
        .join('\n');
      return `## ${date} (€${(o.totalPriceCents / 100).toFixed(2)})\n${itemList}`;
    })
    .join('\n\n');
}

function formatToday(now: Date): string {
  // We format in Europe/Amsterdam regardless of the host timezone so the
  // bot says "vrijdag 4 juni 2026" not whatever the VPS happens to think.
  const formatter = new Intl.DateTimeFormat('nl-NL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Amsterdam',
  });
  return formatter.format(now);
}
