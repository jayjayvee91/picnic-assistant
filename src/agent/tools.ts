/**
 * Tool definitions and handlers.
 *
 * Each tool has:
 *   - An Anthropic-shaped `Tool` definition (name + description + input schema)
 *     that we pass to `messages.create`.
 *   - A handler that the agent loop calls when Claude emits a matching
 *     `tool_use` block. Handlers return a serialisable result; the loop
 *     packages it into a `tool_result` block in the next request.
 *
 * The handler signatures all take an `AgentContext` with the shared resources
 * (Picnic client, DB, profile path, conversation key) so tools don't reach
 * across modules to find them.
 *
 * `propose_profile_addition` and `commit_profile_addition` are deliberately
 * split: the propose tool stages a change in a tiny in-memory ledger; the
 * commit tool only writes after the user explicitly approves in chat (the
 * system prompt instructs the model to wait for approval).
 */

import type { Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages.mjs';
import type { PicnicClient, SellingUnit } from '../picnic/index.js';
import {
  appendToProfileSection,
  isKnownSection,
  getRecentOrders,
  searchOrderHistory,
  logSuggestion,
  type DB,
  type ProfileSection,
} from '../memory/index.js';
import { addToDraft, removeFromDraft, loadDraft, emptyDraft, type DraftItem } from './draft.js';
import { extractRecipeFromUrl } from './recipes.js';

// ──────────────────────────────────────────────────────────────────────
// Agent context — everything tools need
// ──────────────────────────────────────────────────────────────────────

export interface AgentContext {
  db: DB;
  picnic: PicnicClient;
  profilePath: string;
  /** Key used in the `draft_cart` table — one per Telegram chat. */
  conversationKey: string;
  /**
   * Profile additions the agent has PROPOSED but not yet committed. Keyed by
   * a short proposal id the agent passes back in `commit_profile_addition`.
   */
  proposedProfileAdditions: Map<string, { section: ProfileSection; bullet: string }>;
}

// ──────────────────────────────────────────────────────────────────────
// Tool definitions (passed to Anthropic)
// ──────────────────────────────────────────────────────────────────────

export const AGENT_TOOLS: Tool[] = [
  // ── Read tools ────────────────────────────────────────────────────
  {
    name: 'search_picnic_products',
    description:
      'Search Picnic for products by free-text query (Dutch). Returns matching ' +
      'articles with id, name, unit_quantity, and price. Use this to map a ' +
      'recipe ingredient or a user request to a specific Picnic article.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Dutch search term, e.g. "melk", "Calvé pindakaas".',
        },
        limit: { type: 'number', description: 'Maximum results to return (default 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_cart',
    description:
      "Return the current Picnic cart contents (what is actually on the user's " +
      'account right now). Use this before committing a draft to check for ' +
      'overlap with items the user added directly in the Picnic app.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_recent_orders',
    description:
      "Return the household's most recent N completed orders (with items). " +
      'Use sparingly — recent orders are already in the system prompt. Call ' +
      'this if the user explicitly asks for older detail.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of orders to return, max 20.' },
      },
    },
  },
  {
    name: 'search_order_history',
    description:
      'Free-text search across ALL recorded order items by article name. ' +
      'Returns matching items with dates. Use this for questions like ' +
      '"hebben we ooit sojasaus gekocht?".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to search for in product names.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_recipe_url',
    description:
      'Fetch a recipe page and extract its ingredient list (best-effort, ' +
      'JSON-LD only). Returns name, servings, and a string array of ingredients ' +
      'as written by the source. ALWAYS show the extracted list to the user ' +
      'before mapping to Picnic products. Returns an error message if extraction ' +
      'fails — in that case ask the user to paste ingredients directly.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Recipe URL.' },
      },
      required: ['url'],
    },
  },

  // ── Draft tools ───────────────────────────────────────────────────
  {
    name: 'add_to_draft',
    description:
      'Add an article to the WEEKLY DRAFT (not Picnic itself). Use during the ' +
      'weekly-cart conversation. Increments quantity if the article is already ' +
      'in the draft.',
    input_schema: {
      type: 'object',
      properties: {
        articleId: {
          type: 'string',
          description: 'Picnic article id from search_picnic_products.',
        },
        articleName: { type: 'string', description: 'Human-readable name to display.' },
        quantity: { type: 'number', description: 'How many to add (default 1).' },
      },
      required: ['articleId', 'articleName'],
    },
  },
  {
    name: 'remove_from_draft',
    description:
      'Remove an article from the WEEKLY DRAFT, or decrement its quantity. ' +
      'If the resulting quantity is zero or less, the item is removed entirely.',
    input_schema: {
      type: 'object',
      properties: {
        articleId: { type: 'string' },
        quantity: {
          type: 'number',
          description: 'Quantity to decrement. Omit to remove the entire line.',
        },
      },
      required: ['articleId'],
    },
  },
  {
    name: 'show_draft',
    description: 'Return the current weekly draft (all items + quantities).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'commit_draft_to_cart',
    description:
      "Push the entire weekly draft to the user's Picnic cart in one step, " +
      'then clear the draft. Only call after the user has explicitly approved ' +
      'the proposed list. Logs the suggestion for v2 diff observation.',
    input_schema: { type: 'object', properties: {} },
  },

  // ── Live (ad-hoc) tool ────────────────────────────────────────────
  {
    name: 'add_to_cart_now',
    description:
      'Add an article DIRECTLY to the Picnic cart (skip the draft). Use only ' +
      'for ad-hoc, single-item requests like "voeg pasta toe". For the weekly ' +
      'shopping list, use add_to_draft.',
    input_schema: {
      type: 'object',
      properties: {
        articleId: { type: 'string' },
        quantity: { type: 'number', description: 'How many to add (default 1).' },
      },
      required: ['articleId'],
    },
  },

  // ── Profile tools ─────────────────────────────────────────────────
  {
    name: 'propose_profile_addition',
    description:
      'Propose adding a bullet to the household profile (Preferences / Dislikes / ' +
      'Brands / Patterns). Does NOT write to disk. Returns a proposal id; show the ' +
      'proposed line to the user and only call commit_profile_addition after they ' +
      'explicitly approve.',
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['Preferences', 'Dislikes', 'Brands', 'Patterns'],
        },
        bullet: { type: 'string', description: 'Single-line Dutch bullet text (no leading dash).' },
      },
      required: ['section', 'bullet'],
    },
  },
  {
    name: 'commit_profile_addition',
    description:
      'Actually append a previously proposed line to profile.md. Only call after ' +
      'the user has approved.',
    input_schema: {
      type: 'object',
      properties: {
        proposalId: { type: 'string', description: 'Id returned by propose_profile_addition.' },
      },
      required: ['proposalId'],
    },
  },
];

// ──────────────────────────────────────────────────────────────────────
// Handler dispatch
// ──────────────────────────────────────────────────────────────────────

export async function handleToolUse(
  ctx: AgentContext,
  block: ToolUseBlock,
): Promise<{ content: string; isError: boolean }> {
  const input = (block.input ?? {}) as Record<string, unknown>;
  try {
    const result = await dispatch(ctx, block.name, input);
    return { content: JSON.stringify(result), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: JSON.stringify({ error: msg }), isError: true };
  }
}

async function dispatch(
  ctx: AgentContext,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    // Read tools
    case 'search_picnic_products':
      return await handleSearchProducts(ctx, input);
    case 'get_cart':
      return await handleGetCart(ctx);
    case 'get_recent_orders':
      return handleGetRecentOrders(ctx, input);
    case 'search_order_history':
      return handleSearchOrderHistory(ctx, input);
    case 'fetch_recipe_url':
      return await handleFetchRecipeUrl(input);

    // Draft tools
    case 'add_to_draft':
      return handleAddToDraft(ctx, input);
    case 'remove_from_draft':
      return handleRemoveFromDraft(ctx, input);
    case 'show_draft':
      return handleShowDraft(ctx);
    case 'commit_draft_to_cart':
      return await handleCommitDraft(ctx);

    // Live
    case 'add_to_cart_now':
      return await handleAddToCartNow(ctx, input);

    // Profile
    case 'propose_profile_addition':
      return handleProposeProfileAddition(ctx, input);
    case 'commit_profile_addition':
      return await handleCommitProfileAddition(ctx, input);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Individual handlers
// ──────────────────────────────────────────────────────────────────────

async function handleSearchProducts(
  ctx: AgentContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const query = requireString(input, 'query');
  const limit = clampNumber(input['limit'], 1, 20, 8);
  const products = await ctx.picnic.searchProducts(query);
  return products.slice(0, limit).map(summariseProduct);
}

async function handleGetCart(ctx: AgentContext): Promise<unknown> {
  const cart = await ctx.picnic.getCart();
  // The Cart type is large; only return what the agent actually needs.
  return {
    total_count: (cart as { total_count?: number }).total_count ?? null,
    total_price_cents:
      typeof (cart as { total_price?: number }).total_price === 'number'
        ? (cart as { total_price: number }).total_price
        : null,
  };
}

function handleGetRecentOrders(ctx: AgentContext, input: Record<string, unknown>): unknown {
  const limit = clampNumber(input['limit'], 1, 20, 5);
  return getRecentOrders(ctx.db, limit).map((o) => ({
    date: o.creationTime.slice(0, 10),
    total_eur: (o.totalPriceCents / 100).toFixed(2),
    items: o.items.map((it) => ({
      name: it.articleName,
      qty: it.quantity,
      unit: it.unitQuantity,
    })),
  }));
}

function handleSearchOrderHistory(ctx: AgentContext, input: Record<string, unknown>): unknown {
  const query = requireString(input, 'query');
  return searchOrderHistory(ctx.db, query, 30).map((h) => ({
    date: h.creationTime.slice(0, 10),
    name: h.articleName,
    qty: h.quantity,
  }));
}

async function handleFetchRecipeUrl(input: Record<string, unknown>): Promise<unknown> {
  const url = requireString(input, 'url');
  const extracted = await extractRecipeFromUrl(url);
  if (!extracted) {
    return {
      ok: false,
      note: 'Kon de ingrediënten niet uit deze pagina halen. Vraag de gebruiker om ze te plakken.',
    };
  }
  return {
    ok: true,
    name: extracted.name,
    servings: extracted.servings,
    ingredients: extracted.ingredients,
  };
}

function handleAddToDraft(ctx: AgentContext, input: Record<string, unknown>): unknown {
  const articleId = requireString(input, 'articleId');
  const articleName = requireString(input, 'articleName');
  const quantity = clampNumber(input['quantity'], 1, 50, 1);
  const items = addToDraft(ctx.db, ctx.conversationKey, articleId, articleName, quantity);
  return { ok: true, draft: items };
}

function handleRemoveFromDraft(ctx: AgentContext, input: Record<string, unknown>): unknown {
  const articleId = requireString(input, 'articleId');
  const quantity =
    typeof input['quantity'] === 'number' && Number.isFinite(input['quantity'])
      ? (input['quantity'] as number)
      : undefined;
  const items = removeFromDraft(ctx.db, ctx.conversationKey, articleId, quantity);
  return { ok: true, draft: items };
}

function handleShowDraft(ctx: AgentContext): unknown {
  return { draft: loadDraft(ctx.db, ctx.conversationKey) };
}

async function handleCommitDraft(ctx: AgentContext): Promise<unknown> {
  const items = loadDraft(ctx.db, ctx.conversationKey);
  if (items.length === 0) {
    return { ok: false, note: 'De concept-lijst is leeg, dus er valt niets vast te leggen.' };
  }

  // Log the suggestion BEFORE writing to Picnic so v2 diff observation has
  // a snapshot even if a Picnic call fails mid-commit.
  const suggestionId = logSuggestion(ctx.db, { items });

  const applied: DraftItem[] = [];
  const failed: Array<{ item: DraftItem; error: string }> = [];
  for (const item of items) {
    try {
      await ctx.picnic.addProductToCart(item.articleId, item.quantity);
      applied.push(item);
    } catch (err) {
      failed.push({ item, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Only clear the draft if everything landed — if some failed, we keep the
  // unapplied portion so the agent can retry or surface a question.
  if (failed.length === 0) {
    emptyDraft(ctx.db, ctx.conversationKey);
  } else {
    const remaining = items.filter((i) => !applied.some((a) => a.articleId === i.articleId));
    // Replace the draft with only the failed items.
    emptyDraft(ctx.db, ctx.conversationKey);
    for (const r of remaining) {
      addToDraft(ctx.db, ctx.conversationKey, r.articleId, r.articleName, r.quantity);
    }
  }

  return { ok: failed.length === 0, applied, failed, suggestionId };
}

async function handleAddToCartNow(
  ctx: AgentContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const articleId = requireString(input, 'articleId');
  const quantity = clampNumber(input['quantity'], 1, 50, 1);
  await ctx.picnic.addProductToCart(articleId, quantity);
  return { ok: true, articleId, quantity };
}

function handleProposeProfileAddition(ctx: AgentContext, input: Record<string, unknown>): unknown {
  const section = requireString(input, 'section');
  const bullet = requireString(input, 'bullet');
  if (!isKnownSection(section)) {
    throw new Error(`Unknown profile section: ${section}`);
  }
  const proposalId = `prop_${ctx.proposedProfileAdditions.size + 1}_${Date.now().toString(36)}`;
  ctx.proposedProfileAdditions.set(proposalId, { section, bullet });
  return { proposalId, section, bullet };
}

async function handleCommitProfileAddition(
  ctx: AgentContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const proposalId = requireString(input, 'proposalId');
  const proposal = ctx.proposedProfileAdditions.get(proposalId);
  if (!proposal) {
    throw new Error(`Unknown proposalId: ${proposalId}. Did the user approve a different one?`);
  }
  await appendToProfileSection(ctx.profilePath, proposal.section, proposal.bullet);
  ctx.proposedProfileAdditions.delete(proposalId);
  return { ok: true, section: proposal.section, bullet: proposal.bullet };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function summariseProduct(p: SellingUnit): unknown {
  const obj = p as unknown as {
    id?: string;
    name?: string;
    unit_quantity?: string;
    price?: number;
    display_price?: number;
  };
  return {
    id: obj.id ?? null,
    name: obj.name ?? null,
    unit_quantity: obj.unit_quantity ?? null,
    price_cents: obj.display_price ?? obj.price ?? null,
  };
}

function requireString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Tool input missing required string field "${key}".`);
  }
  return v;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
