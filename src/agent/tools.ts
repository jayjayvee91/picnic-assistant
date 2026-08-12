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
  getRecentAllergenDecisions,
  upsertAllergenOverride,
  type DB,
  type ProfileSection,
} from '../memory/index.js';
import {
  appendRule,
  verdictLabel,
  GLUTEN,
  type AllergenChecker,
  type CheckResult,
  type RuleSection,
} from '../allergen/index.js';
import type { RecipeRegistry } from '../recipe/index.js';
import {
  addToDraft,
  removeFromDraft,
  loadDraft,
  emptyDraft,
  unverifiedDraftItems,
  type DraftItem,
} from './draft.js';
import { extractRecipeFromUrl } from './recipes.js';

// ──────────────────────────────────────────────────────────────────────
// Agent context — everything tools need
// ──────────────────────────────────────────────────────────────────────

export interface AgentContext {
  db: DB;
  picnic: PicnicClient;
  profilePath: string;
  /** Path to `gluten-rules.md` — the human-editable rulebook. */
  rulebookPath: string;
  /**
   * Where recipes come from. A registry rather than a single source, so a
   * personal recipe database can be added later without touching these tools.
   */
  recipes: RecipeRegistry;
  /**
   * The gluten guard. Every path that puts an article into the draft or the
   * cart goes through this; it is not optional and not model-controlled.
   */
  allergen: AllergenChecker;
  /** Key used in the `draft_cart` table — one per Telegram chat. */
  conversationKey: string;
  /**
   * Profile additions the agent has PROPOSED but not yet committed. Keyed by
   * a short proposal id the agent passes back in `commit_profile_addition`.
   */
  proposedProfileAdditions: Map<string, { section: ProfileSection; bullet: string }>;
  /**
   * Gluten-rule additions proposed but not yet committed. Same approve-first
   * discipline as profile additions — the bot never changes what counts as
   * gluten without the household saying yes.
   */
  proposedGlutenRules: Map<string, { section: RuleSection; term: string; note?: string }>;
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
    name: 'list_recipes',
    description:
      "List the household's saved recipes (their Picnic favourites, plus any " +
      'other configured recipe source). Use this whenever they ask what to eat, ' +
      'for a week menu, or for recipe ideas. These are REAL saved recipes — ' +
      'prefer them over inventing dishes. Returns id, name and source.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional case-insensitive filter on the recipe name, e.g. "pasta", "curry".',
        },
        limit: { type: 'number', description: 'Max results (default 40, max 100).' },
      },
    },
  },
  {
    name: 'get_recipe_details',
    description:
      'Ingredients for one recipe, each already mapped to a specific Picnic ' +
      'article. Returns which ingredients Picnic pre-selects (the actual ' +
      'shopping list) versus optional pantry extras it merely offers, plus ' +
      "each product's name, brand, price and gluten verdict. Use the id from " +
      'list_recipes.',
    input_schema: {
      type: 'object',
      properties: {
        recipeId: { type: 'string', description: 'Id from list_recipes, e.g. "picnic:6335ac…".' },
        includeExtras: {
          type: 'boolean',
          description:
            'Also return the optional pantry extras (default false). The extras are ' +
            'things like oil and cheese that the household probably already has.',
        },
      },
      required: ['recipeId'],
    },
  },
  {
    name: 'add_recipe_to_draft',
    description:
      "Add a recipe's ingredients to the WEEKLY DRAFT. By default adds only " +
      'the ingredients Picnic pre-selects, NOT the optional pantry extras — ' +
      'adding everything roughly quadruples the cost. Every article goes ' +
      'through the gluten check first; anything containing gluten is refused ' +
      'and reported, never silently added. Show the resulting list to the user ' +
      'and honour their brand preferences before committing.',
    input_schema: {
      type: 'object',
      properties: {
        recipeId: { type: 'string' },
        includeExtras: {
          type: 'boolean',
          description: 'Also add the optional pantry extras (default false).',
        },
      },
      required: ['recipeId'],
    },
  },
  {
    name: 'check_product_gluten',
    description:
      'Check whether a specific Picnic article contains gluten (or traces). ' +
      'Returns a verdict — blocked / allowed / unverified — plus the reason and ' +
      'the raw allergen + ingredient data the verdict was based on. Use this to ' +
      'answer "zit hier gluten in?" and to vet a product BEFORE proposing it. ' +
      'Note: adding to the draft or cart runs this check automatically, so you ' +
      'do not need to call it first just to be safe.',
    input_schema: {
      type: 'object',
      properties: {
        articleId: { type: 'string', description: 'Picnic article id.' },
        articleName: { type: 'string', description: 'Name, for the log and the reply.' },
      },
      required: ['articleId'],
    },
  },
  {
    name: 'recent_gluten_decisions',
    description:
      'Return the most recent gluten decisions with their reasons and inputs. ' +
      'Use when the user asks how or why something was judged — e.g. "waarom heb ' +
      'je die saus geblokkeerd?" or "wat heb je laatst niet kunnen controleren?".',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many decisions (default 10, max 30).' },
      },
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
      'in the draft. Runs the gluten check first — an article that contains ' +
      'gluten is refused, and one that cannot be verified is added with a flag ' +
      'you must repeat to the user.',
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
    description:
      'Return the current weekly draft: items, quantities, per-item and total ' +
      'price, and a FRESH gluten verdict for each item. Use this whenever the ' +
      'user asks what is on the list or what it costs — do not add the prices ' +
      'up yourself.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'clear_draft',
    description:
      'Empty the weekly draft completely. Use when the user wants to start ' +
      'over ("begin opnieuw", "gooi de lijst weg", "wis alles"). The draft ' +
      'survives restarts, so it can still hold items from a previous ' +
      'conversation — clearing is the way to be sure you are starting fresh. ' +
      'Does NOT touch the real Picnic cart.',
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
      'shopping list, use add_to_draft. Runs the gluten check first — an ' +
      'article that contains gluten is refused, not added.',
    input_schema: {
      type: 'object',
      properties: {
        articleId: { type: 'string' },
        articleName: { type: 'string', description: 'Name, for the reply and the audit log.' },
        quantity: { type: 'number', description: 'How many to add (default 1).' },
      },
      required: ['articleId'],
    },
  },

  // ── Deliberate gluten exception ───────────────────────────────────
  {
    name: 'add_with_gluten_exception',
    description:
      'Add an article the gluten guard BLOCKED, as a deliberate exception. ' +
      'ONLY call this when the user has explicitly acknowledged the gluten and ' +
      'still wants the product — e.g. "ja, ik weet dat daar gluten in zit, doe ' +
      'toch maar". A plain "ja" approving a list is NOT enough; the user must ' +
      'address the gluten itself. Never call this on your own initiative, and ' +
      'never to work around a block you disagree with. First offer a ' +
      'gluten-free alternative; use this only if the user declines it. ' +
      'Scope "once" adds it this one time; scope "standing" also stops the ' +
      'guard blocking this same article in future.',
    input_schema: {
      type: 'object',
      properties: {
        articleId: { type: 'string' },
        articleName: { type: 'string' },
        quantity: { type: 'number', description: 'How many (default 1).' },
        scope: {
          type: 'string',
          enum: ['once', 'standing'],
          description: '"once" = this time only. "standing" = always allow this article.',
        },
        target: {
          type: 'string',
          enum: ['draft', 'cart'],
          description: 'Where it goes — the weekly draft, or straight to the Picnic cart.',
        },
        acknowledgement: {
          type: 'string',
          description:
            "Short quote or paraphrase of the user's explicit acknowledgement that this " +
            'product contains gluten. Recorded in the audit log.',
        },
      },
      required: ['articleId', 'articleName', 'scope', 'target', 'acknowledgement'],
    },
  },

  // ── Teaching the guard ────────────────────────────────────────────
  {
    name: 'propose_gluten_rule',
    description:
      'Propose a new term for the gluten rulebook (gluten-rules.md). Use when ' +
      'the user corrects a verdict — e.g. they checked a product and it DID ' +
      'contain gluten, or a term was flagged that is actually fine. Does NOT ' +
      'write. Returns a proposal id; show the proposed rule and only call ' +
      'commit_gluten_rule after the user approves. Sections: "Bevat gluten" ' +
      'blocks, "Twijfel" flags as unverified, "Veilig" prevents false matches.',
    input_schema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['Bevat gluten', 'Twijfel', 'Veilig'] },
        term: {
          type: 'string',
          description: 'The ingredient term, lower case, e.g. "moutextract".',
        },
        note: { type: 'string', description: 'Short Dutch rationale, e.g. "komt van gerst".' },
      },
      required: ['section', 'term'],
    },
  },
  {
    name: 'commit_gluten_rule',
    description:
      'Append a previously proposed rule to gluten-rules.md. Only after the ' +
      'user approves. The new rule applies to the very next check.',
    input_schema: {
      type: 'object',
      properties: {
        proposalId: { type: 'string', description: 'Id from propose_gluten_rule.' },
      },
      required: ['proposalId'],
    },
  },
  {
    name: 'set_product_gluten_override',
    description:
      'Force a verdict for ONE specific article, overriding the automatic ' +
      "check. Use when Picnic's data is wrong for this product but the term " +
      'rule should not generalise — e.g. the user checked the packet and it ' +
      'does contain gluten despite Picnic saying nothing ("blocked"), or a ' +
      'product is confirmed safe and should stop being flagged ("allowed"). ' +
      'Only call after the user explicitly asks for it.',
    input_schema: {
      type: 'object',
      properties: {
        articleId: { type: 'string' },
        articleName: { type: 'string' },
        verdict: { type: 'string', enum: ['blocked', 'allowed'] },
        reason: { type: 'string', description: 'Why — recorded and shown in the log.' },
      },
      required: ['articleId', 'verdict', 'reason'],
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
    case 'list_recipes':
      return await handleListRecipes(ctx, input);
    case 'get_recipe_details':
      return await handleGetRecipeDetails(ctx, input);
    case 'add_recipe_to_draft':
      return await handleAddRecipeToDraft(ctx, input);
    case 'check_product_gluten':
      return await handleCheckProductGluten(ctx, input);
    case 'recent_gluten_decisions':
      return handleRecentGlutenDecisions(ctx, input);

    // Draft tools
    case 'add_to_draft':
      return handleAddToDraft(ctx, input);
    case 'remove_from_draft':
      return handleRemoveFromDraft(ctx, input);
    case 'show_draft':
      return await handleShowDraft(ctx);
    case 'clear_draft':
      return handleClearDraft(ctx);
    case 'commit_draft_to_cart':
      return await handleCommitDraft(ctx);

    // Live
    case 'add_to_cart_now':
      return await handleAddToCartNow(ctx, input);

    // Deliberate exception + teaching the guard
    case 'add_with_gluten_exception':
      return await handleAddWithGlutenException(ctx, input);
    case 'propose_gluten_rule':
      return handleProposeGlutenRule(ctx, input);
    case 'commit_gluten_rule':
      return await handleCommitGlutenRule(ctx, input);
    case 'set_product_gluten_override':
      return handleSetProductGlutenOverride(ctx, input);

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

async function handleAddToDraft(
  ctx: AgentContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const articleId = requireString(input, 'articleId');
  const articleName = requireString(input, 'articleName');
  const quantity = clampNumber(input['quantity'], 1, 50, 1);

  // The guard runs BEFORE the item can enter the draft. There is no code path
  // from this tool to `addToDraft` that skips it.
  const check = await ctx.allergen.check(articleId, articleName);
  if (check.verdict === 'blocked') {
    return blockedResult(check, articleName);
  }

  const items = addToDraft(ctx.db, ctx.conversationKey, articleId, articleName, quantity, {
    status: check.verdict,
    note: check.reason,
  });
  return {
    ok: true,
    gluten: glutenSummary(check),
    draft: items,
  };
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

/**
 * Show the draft with FRESH verdicts and a computed total.
 *
 * Two problems this solves, both seen in a live weekly-draft run:
 *
 * 1. Verdicts were stored when an item was added and never revisited, so the
 *    draft kept showing a stale warning on a product that a later fix had
 *    since cleared. What the household reads must be what the guard currently
 *    thinks, not what it thought last week.
 * 2. Asked for a total, the model started adding ~25 prices by hand and gave
 *    up mid-answer ("nog aan het berekenen…"). Arithmetic over a list belongs
 *    in code.
 *
 * Re-checking costs nothing extra in practice: the allergen checker caches
 * product pages, so items looked at earlier in the conversation are free.
 */
async function handleShowDraft(ctx: AgentContext): Promise<unknown> {
  const items = loadDraft(ctx.db, ctx.conversationKey);
  if (items.length === 0) {
    return { draft: [], itemCount: 0, totalPriceEur: '0.00', note: 'De concept-lijst is leeg.' };
  }

  let totalCents = 0;
  const detailed = [];
  const unverified: string[] = [];
  const blocked: string[] = [];

  for (const item of items) {
    const check = await ctx.allergen.check(item.articleId, item.articleName);
    const lineCents = (check.priceCents ?? 0) * item.quantity;
    totalCents += lineCents;

    if (check.verdict === 'blocked') blocked.push(item.articleName);
    if (check.verdict === 'unverified') unverified.push(item.articleName);

    detailed.push({
      articleId: item.articleId,
      name: check.productName ?? item.articleName,
      brand: check.brand,
      quantity: item.quantity,
      unitPriceEur: check.priceCents === null ? null : (check.priceCents / 100).toFixed(2),
      linePriceEur: (lineCents / 100).toFixed(2),
      gluten: check.verdict,
      glutenReason: check.reason,
    });
  }

  return {
    draft: detailed,
    itemCount: items.length,
    totalPriceEur: (totalCents / 100).toFixed(2),
    ...(unverified.length > 0 ? { unverified } : {}),
    // An item can become blocked after it was added — a rulebook edit, or a
    // fix like this one. Surfacing it here means the household finds out while
    // reviewing, not when the commit refuses.
    ...(blocked.length > 0
      ? {
          blocked,
          blockedNote:
            'Deze staan nog in de lijst maar bevatten gluten. Ze worden bij het ' +
            'vastleggen geweigerd — haal ze eruit of vervang ze.',
        }
      : {}),
  };
}

function handleClearDraft(ctx: AgentContext): unknown {
  const had = loadDraft(ctx.db, ctx.conversationKey).length;
  emptyDraft(ctx.db, ctx.conversationKey);
  return {
    ok: true,
    removed: had,
    note: `Concept-lijst geleegd (${had} item(s) verwijderd). De Picnic-mand zelf is niet aangeraakt.`,
  };
}

async function handleCommitDraft(ctx: AgentContext): Promise<unknown> {
  const items = loadDraft(ctx.db, ctx.conversationKey);
  if (items.length === 0) {
    return { ok: false, note: 'De concept-lijst is leeg, dus er valt niets vast te leggen.' };
  }

  // Re-verify EVERY item at commit time rather than trusting the verdict
  // recorded at add time. Three reasons this matters:
  //   1. The household may have added a rule mid-conversation — it should
  //      protect the items already sitting in the draft, not just later ones.
  //   2. An override may have been set since.
  //   3. Drafts written before the guard existed carry no verdict at all.
  // Re-checking is cheap: the PDP cache means no extra Picnic calls for
  // articles already looked at in this run.
  const blocked: Array<{ item: DraftItem; reason: string }> = [];
  const rechecked: DraftItem[] = [];
  for (const item of items) {
    const check = await ctx.allergen.check(item.articleId, item.articleName);
    if (check.verdict === 'blocked') {
      blocked.push({ item, reason: check.reason });
      continue;
    }
    rechecked.push({ ...item, glutenStatus: check.verdict, glutenNote: check.reason });
  }

  if (blocked.length > 0) {
    // Refuse the whole commit. A partial push would leave the household
    // believing the approved list went through when part of it silently did
    // not — worse than stopping and saying so.
    return {
      ok: false,
      blockedByGlutenGuard: blocked.map((b) => ({
        articleId: b.item.articleId,
        name: b.item.articleName,
        reason: b.reason,
      })),
      note:
        'Er staan producten in de lijst die gluten bevatten. Er is niets naar de mand ' +
        'gestuurd. Haal ze eruit met remove_from_draft, of vervang ze door een ' +
        'glutenvrij alternatief. Wil de gebruiker er bewust toch één bij, dan kan dat ' +
        'alleen via add_with_gluten_exception na een expliciete bevestiging.',
    };
  }

  const unverified = unverifiedDraftItems(rechecked);

  // Log the suggestion BEFORE writing to Picnic so v2 diff observation has
  // a snapshot even if a Picnic call fails mid-commit.
  const suggestionId = logSuggestion(ctx.db, { items: rechecked });

  const applied: DraftItem[] = [];
  const failed: Array<{ item: DraftItem; error: string }> = [];
  for (const item of rechecked) {
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
    const remaining = rechecked.filter((i) => !applied.some((a) => a.articleId === i.articleId));
    // Replace the draft with only the failed items, verdicts intact.
    emptyDraft(ctx.db, ctx.conversationKey);
    for (const r of remaining) {
      addToDraft(
        ctx.db,
        ctx.conversationKey,
        r.articleId,
        r.articleName,
        r.quantity,
        r.glutenStatus ? { status: r.glutenStatus, note: r.glutenNote ?? '' } : undefined,
      );
    }
  }

  return {
    ok: failed.length === 0,
    applied,
    failed,
    suggestionId,
    // Surfaced so the agent repeats the warning in its confirmation message —
    // the household's last chance to catch an unverified item before delivery.
    unverified: unverified.map((i) => ({
      articleId: i.articleId,
      name: i.articleName,
      reason: i.glutenNote ?? 'Glutenstatus onbekend.',
    })),
    ...(unverified.length > 0
      ? {
          unverifiedNote:
            `LET OP: ${unverified.length} product(en) konden niet op gluten geverifieerd ` +
            'worden. Noem ze expliciet bij naam in je bevestiging, niet als terzijde.',
        }
      : {}),
  };
}

async function handleAddToCartNow(
  ctx: AgentContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const articleId = requireString(input, 'articleId');
  const articleName = typeof input['articleName'] === 'string' ? input['articleName'] : null;
  const quantity = clampNumber(input['quantity'], 1, 50, 1);

  // Ad-hoc adds are gated exactly like draft adds. The guard protects every
  // route into the cart, not just the weekly-shop route.
  const check = await ctx.allergen.check(articleId, articleName);
  if (check.verdict === 'blocked') {
    return blockedResult(check, articleName ?? articleId);
  }

  await ctx.picnic.addProductToCart(articleId, quantity);
  return { ok: true, articleId, quantity, gluten: glutenSummary(check) };
}

// ──────────────────────────────────────────────────────────────────────
// Recipes
// ──────────────────────────────────────────────────────────────────────

async function handleListRecipes(
  ctx: AgentContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const query = typeof input['query'] === 'string' ? input['query'].toLowerCase() : null;
  const limit = clampNumber(input['limit'], 1, 100, 40);

  const { recipes, failures } = await ctx.recipes.listRecipes({ savedOnly: true });
  const filtered = query ? recipes.filter((r) => r.name.toLowerCase().includes(query)) : recipes;

  const shown = filtered.slice(0, limit);
  return {
    total: recipes.length,
    matched: filtered.length,
    returned: shown.length,
    // Without this the model announces the total and then prints one page,
    // e.g. "here are your 95 saved recipes" above a list of 40.
    ...(shown.length < filtered.length
      ? {
          truncated: true,
          truncationNote:
            `Je ziet ${shown.length} van de ${filtered.length} recepten. Zeg dat er meer ` +
            'zijn; beweer niet dat dit de hele lijst is. Gebruik query of limit voor de rest.',
        }
      : {}),
    recipes: shown.map((r) => ({ id: r.id, name: r.name, source: r.source })),
    // Surfaced rather than swallowed: if a source is down the household should
    // hear "I couldn't reach X" instead of a silently shorter list.
    ...(failures.length > 0 ? { unavailableSources: failures } : {}),
    // A live run showed the model annotating this list with guessed verdicts
    // ("pasta = gluten") from its own knowledge, with no tool call behind them.
    // Gluten-free pasta and gnocchi exist and this household buys them, so the
    // guesses were both wrong and costly — and mixing them in with real
    // verdicts makes the real ones look like guesses too.
    glutenNote:
      'Deze lijst bevat GEEN glutenoordelen. Namen zeggen niets: er bestaat ' +
      'glutenvrije pasta, gnocchi en noedels. Annoteer deze recepten niet met ' +
      'vermoedens — roep get_recipe_details aan als iemand wil weten of een ' +
      'recept veilig is.',
  };
}

/**
 * Resolve a recipe's ingredients into concrete products, with a gluten verdict
 * on each.
 *
 * One call per article, but the allergen checker caches product pages, so
 * looking at a recipe and then adding it does not fetch anything twice.
 */
interface ResolvedIngredient {
  articleId: string;
  name: string | null;
  brand: string | null;
  unitQuantity: string | null;
  quantity: number;
  priceCents: number | null;
  optionalExtra: boolean;
  available: boolean;
  gluten: Record<string, unknown>;
  verdict: 'blocked' | 'allowed' | 'unverified';
}

interface ResolvedRecipe {
  recipe: { id: string; name: string | null; portions: number | null };
  items: ResolvedIngredient[];
  /** Ingredients Picnic listed without a product — the agent must search. */
  skippedNoArticle: number;
}

async function resolveIngredients(
  ctx: AgentContext,
  recipeId: string,
  includeExtras: boolean,
): Promise<ResolvedRecipe | null> {
  const details = await ctx.recipes.getRecipeDetails(recipeId);
  if (!details) return null;

  const wanted = details.ingredients.filter((i) => includeExtras || i.selected);
  const items: ResolvedIngredient[] = [];
  let skippedNoArticle = 0;

  for (const ing of wanted) {
    if (!ing.articleId) {
      skippedNoArticle++;
      continue;
    }
    const check = await ctx.allergen.check(ing.articleId, null);
    items.push({
      articleId: ing.articleId,
      name: check.productName,
      brand: check.brand,
      unitQuantity: check.unitQuantity,
      quantity: ing.requiredAmount,
      priceCents: ing.priceCents ?? check.priceCents,
      optionalExtra: !ing.selected,
      available: ing.available,
      gluten: glutenSummary(check),
      verdict: check.verdict,
    });
  }

  return {
    recipe: { id: details.id, name: details.name, portions: details.portions },
    items,
    skippedNoArticle,
  };
}

async function handleGetRecipeDetails(
  ctx: AgentContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const recipeId = requireString(input, 'recipeId');
  const includeExtras = input['includeExtras'] === true;

  const resolved = await resolveIngredients(ctx, recipeId, includeExtras);
  if (!resolved) {
    return {
      ok: false,
      note:
        'Kon dit recept niet ophalen of niet uitlezen. Vraag de gebruiker of ze het ' +
        'recept anders willen aanduiden, of gebruik list_recipes opnieuw.',
    };
  }

  const blocked = resolved.items.filter((i) => i.verdict === 'blocked');
  return {
    ok: true,
    ...resolved.recipe,
    ingredients: resolved.items,
    ...(blocked.length > 0
      ? {
          glutenWarning:
            `LET OP: ${blocked.length} ingredient(en) van dit recept bevatten gluten. ` +
            'Noem ze bij naam en stel glutenvrije alternatieven voor, of raad dit ' +
            'recept af.',
        }
      : {}),
    ...(includeExtras
      ? {}
      : {
          note: 'Alleen de ingrediënten die Picnic standaard aanvinkt. Gebruik includeExtras voor de rest.',
        }),
  };
}

async function handleAddRecipeToDraft(
  ctx: AgentContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const recipeId = requireString(input, 'recipeId');
  const includeExtras = input['includeExtras'] === true;

  const resolved = await resolveIngredients(ctx, recipeId, includeExtras);
  if (!resolved) {
    return { ok: false, note: 'Kon dit recept niet ophalen of niet uitlezen.' };
  }

  const added: unknown[] = [];
  const blocked: unknown[] = [];
  const unverified: unknown[] = [];

  for (const item of resolved.items) {
    if (item.verdict === 'blocked') {
      blocked.push({ articleId: item.articleId, name: item.name, gluten: item.gluten });
      continue;
    }
    addToDraft(
      ctx.db,
      ctx.conversationKey,
      item.articleId,
      item.name ?? item.articleId,
      item.quantity,
      {
        status: item.verdict,
        note: String((item.gluten as { reason?: unknown }).reason ?? ''),
      },
    );
    added.push({
      articleId: item.articleId,
      name: item.name,
      brand: item.brand,
      unitQuantity: item.unitQuantity,
      quantity: item.quantity,
      priceCents: item.priceCents,
    });
    if (item.verdict === 'unverified') {
      unverified.push({ articleId: item.articleId, name: item.name });
    }
  }

  return {
    ok: true,
    recipe: resolved.recipe,
    added,
    ...(blocked.length > 0
      ? {
          blockedByGlutenGuard: blocked,
          // The rest of the recipe still goes in, because those ingredients are
          // fine and the household may want them. But a recipe missing its main
          // component is a meal that cannot be cooked, and ordering merguez and
          // spinach with no gnocchi is a worse outcome than adding nothing —
          // so say plainly that this is unfinished business, not a result.
          recipeIncomplete: true,
          glutenNote:
            `"${resolved.recipe.name ?? 'Dit recept'}" is NIET compleet: ` +
            `${blocked.length} ingredient(en) bevatten gluten en zijn niet toegevoegd. ` +
            'Zo is het gerecht niet te koken. Zoek een glutenvrij alternatief met ' +
            'search_picnic_products en voeg dat toe, of haal de rest van dit recept ' +
            'weer uit de lijst. Laat dit niet ongemoeid staan tot het vastleggen.',
        }
      : {}),
    ...(unverified.length > 0
      ? {
          unverified,
          unverifiedNote:
            'Deze producten konden niet op gluten geverifieerd worden. Noem ze expliciet ' +
            'bij naam in je antwoord.',
        }
      : {}),
    ...(resolved.skippedNoArticle > 0
      ? {
          skippedNoArticle: resolved.skippedNoArticle,
          skippedNote:
            'Voor deze ingrediënten gaf Picnic geen product. Zoek ze zelf op met ' +
            'search_picnic_products en vraag de gebruiker om te kiezen.',
        }
      : {}),
    brandCheckReminder:
      'Controleer de merken hierboven tegen de Brands-sectie van het huishoudprofiel. ' +
      'Picnic kiest zelf een merk; de voorkeur van het huishouden gaat vóór. Stel een ' +
      'wissel voor waar dat afwijkt (remove_from_draft + search_picnic_products + add_to_draft).',
  };
}

// ──────────────────────────────────────────────────────────────────────
// Gluten: inspection, deliberate exceptions, and teaching the guard
// ──────────────────────────────────────────────────────────────────────

async function handleCheckProductGluten(
  ctx: AgentContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const articleId = requireString(input, 'articleId');
  const articleName = typeof input['articleName'] === 'string' ? input['articleName'] : null;
  const check = await ctx.allergen.check(articleId, articleName);
  return {
    ...glutenSummary(check),
    // The raw inputs, so the agent can quote what it actually saw rather than
    // paraphrasing a verdict it cannot substantiate.
    declaredAllergens: check.allergens,
    ingredients: check.ingredientsText,
  };
}

function handleRecentGlutenDecisions(ctx: AgentContext, input: Record<string, unknown>): unknown {
  const limit = clampNumber(input['limit'], 1, 30, 10);
  return getRecentAllergenDecisions(ctx.db, limit).map((d) => ({
    at: d.createdAt,
    articleId: d.articleId,
    name: d.articleName,
    verdict: d.verdict,
    decidedBy: d.decidedBy,
    reason: d.reason,
    matchedTerms: d.matchedTerms,
  }));
}

/**
 * The ONLY route by which a gluten-blocked article can reach the cart.
 *
 * It is a separate tool rather than a flag on `add_to_draft` deliberately: a
 * confused model cannot stumble into an override while doing ordinary work,
 * because the ordinary path has no parameter that permits it. Reaching here
 * requires the model to have chosen this tool by name, which the system prompt
 * gates behind an explicit human acknowledgement of the gluten.
 */
async function handleAddWithGlutenException(
  ctx: AgentContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const articleId = requireString(input, 'articleId');
  const articleName = requireString(input, 'articleName');
  const acknowledgement = requireString(input, 'acknowledgement');
  const scope = requireString(input, 'scope');
  const target = requireString(input, 'target');
  const quantity = clampNumber(input['quantity'], 1, 50, 1);

  if (scope !== 'once' && scope !== 'standing') {
    throw new Error(`Unknown scope: ${scope}. Use "once" or "standing".`);
  }
  if (target !== 'draft' && target !== 'cart') {
    throw new Error(`Unknown target: ${target}. Use "draft" or "cart".`);
  }

  // Record the exception first. A 'once' override is consumed by the very next
  // check (see AllergenChecker), so it cannot leak into future orders.
  upsertAllergenOverride(ctx.db, {
    articleId,
    allergen: GLUTEN,
    verdict: 'allowed',
    scope,
    articleName,
    reason: `Bewuste uitzondering door de gebruiker: ${acknowledgement}`,
  });

  // Re-run the check so the exception is exercised through the same path as
  // everything else, and lands in the audit trail as an explicit exception
  // rather than as a silent allow.
  const check = await ctx.allergen.check(articleId, articleName);
  if (check.verdict === 'blocked') {
    // Should not happen — the override forces 'allowed'. Fail closed if it does.
    return blockedResult(check, articleName);
  }

  if (target === 'cart') {
    await ctx.picnic.addProductToCart(articleId, quantity);
  } else {
    addToDraft(ctx.db, ctx.conversationKey, articleId, articleName, quantity, {
      status: 'unverified',
      note: `Bevat gluten — bewust toegevoegd. ${acknowledgement}`,
    });
  }

  return {
    ok: true,
    articleId,
    articleName,
    quantity,
    target,
    scope,
    note:
      scope === 'standing'
        ? `"${articleName}" wordt vanaf nu niet meer geblokkeerd. Bevestig dit expliciet ` +
          'in je antwoord, en vermeld dat het product gluten bevat.'
        : `"${articleName}" is deze ene keer toegevoegd ondanks gluten. Volgende keer ` +
          'blokkeert de controle het weer. Vermeld dit expliciet in je antwoord.',
  };
}

function handleProposeGlutenRule(ctx: AgentContext, input: Record<string, unknown>): unknown {
  const section = requireString(input, 'section');
  const term = requireString(input, 'term');
  const note = typeof input['note'] === 'string' ? input['note'] : undefined;
  if (section !== 'Bevat gluten' && section !== 'Twijfel' && section !== 'Veilig') {
    throw new Error(`Unknown rulebook section: ${section}.`);
  }
  const proposalId = `glut_${ctx.proposedGlutenRules.size + 1}_${Date.now().toString(36)}`;
  ctx.proposedGlutenRules.set(proposalId, { section, term, ...(note ? { note } : {}) });
  return {
    proposalId,
    section,
    term,
    note: note ?? null,
    effect:
      section === 'Bevat gluten'
        ? 'Producten met deze term worden voortaan geblokkeerd.'
        : section === 'Twijfel'
          ? 'Producten met deze term worden voortaan gemarkeerd als niet-geverifieerd.'
          : 'Deze term voorkomt dat een bredere regel onterecht aanslaat.',
  };
}

async function handleCommitGlutenRule(
  ctx: AgentContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const proposalId = requireString(input, 'proposalId');
  const proposal = ctx.proposedGlutenRules.get(proposalId);
  if (!proposal) {
    throw new Error(`Unknown proposalId: ${proposalId}. Did the user approve a different one?`);
  }
  await appendRule(ctx.rulebookPath, proposal.section, proposal.term, proposal.note);
  ctx.proposedGlutenRules.delete(proposalId);
  return {
    ok: true,
    section: proposal.section,
    term: proposal.term,
    note: 'De regel geldt direct bij de volgende controle.',
  };
}

function handleSetProductGlutenOverride(
  ctx: AgentContext,
  input: Record<string, unknown>,
): unknown {
  const articleId = requireString(input, 'articleId');
  const verdict = requireString(input, 'verdict');
  const reason = requireString(input, 'reason');
  const articleName = typeof input['articleName'] === 'string' ? input['articleName'] : null;
  if (verdict !== 'blocked' && verdict !== 'allowed') {
    throw new Error(`Unknown verdict: ${verdict}. Use "blocked" or "allowed".`);
  }
  upsertAllergenOverride(ctx.db, {
    articleId,
    allergen: GLUTEN,
    verdict,
    scope: 'standing',
    articleName,
    reason,
  });
  return {
    ok: true,
    articleId,
    verdict,
    note:
      verdict === 'blocked'
        ? 'Dit product wordt vanaf nu altijd geblokkeerd, ongeacht wat Picnic zegt.'
        : 'Dit product wordt vanaf nu altijd toegestaan. Controleer dat dit klopt.',
  };
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

/**
 * Shape a blocked verdict into a tool result. Deliberately explicit about what
 * the model may and may not do next, because this is the one place where a
 * "helpful" workaround would be actively dangerous.
 */
function blockedResult(check: CheckResult, displayName: string): unknown {
  return {
    ok: false,
    blockedByGlutenGuard: true,
    articleId: check.articleId,
    name: displayName,
    verdict: check.verdict,
    reason: check.reason,
    decidedBy: check.decidedBy,
    matchedTerms: check.matchedTerms,
    declaredAllergens: check.allergens,
    note:
      `"${displayName}" is niet toegevoegd: ${check.reason} ` +
      'Zoek een glutenvrij alternatief en stel dat voor. Als de gebruiker dit ' +
      'product bewust tóch wil, ondanks de gluten, kan dat alleen via ' +
      'add_with_gluten_exception — en alleen nadat de gebruiker de gluten ' +
      'expliciet heeft benoemd en bevestigd.',
  };
}

/** Compact verdict summary attached to successful adds. */
function glutenSummary(check: CheckResult): Record<string, unknown> {
  return {
    articleId: check.articleId,
    verdict: check.verdict,
    label: verdictLabel(check.verdict),
    reason: check.reason,
    decidedBy: check.decidedBy,
    matchedTerms: check.matchedTerms,
    ...(check.verdict === 'unverified'
      ? {
          warnUser:
            'Dit product kon NIET op gluten geverifieerd worden. Noem dit expliciet ' +
            'en bij naam in je antwoord — niet als voetnoot.',
        }
      : {}),
  };
}

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
