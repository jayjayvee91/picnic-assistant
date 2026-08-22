/**
 * Fixture-driven checks for the recipe parsers.
 *
 * Run with:
 *   npm run smoke:recipe
 *
 * No network, no session, no API key. The fixtures below mirror the shapes
 * observed in real captured responses from a live account — including the
 * exact field names, which are load-bearing and easy to get wrong.
 */

import { parseRecipeList, parseRecipeDetails } from './fusion-parse.js';
import { matchesRecipeQuery, significantWords } from './match.js';
import { rankByRotation, splitByRotationWindow, type RecipeUsageInfo } from './rotation.js';
import { RecipeRegistry } from './registry.js';
import type { RecipeDetails, RecipeSource, RecipeSummary } from './types.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(detail ? `${name} — ${detail}` : name);
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Fixtures — shaped after real responses
// ──────────────────────────────────────────────────────────────────────

const deepLink = (id: string, image: string, name: string): string =>
  `app.picnic://store/page;id=action-bottom-sheet,presentation-mode=MODAL_OVER_CONTEXT,` +
  `id=${id}&image=recipes%2F${image}&name=${encodeURIComponent(name)}&source=SELLING_GROUP_TILE`;

/** Mirrors saved-deep-dive-page-content: tiles whose names live in deep links. */
const savedListPage = {
  script: {},
  layout: {
    child: {
      child: {
        children: [
          {
            children: [
              {
                pml: {
                  component: {
                    onPress: {
                      url: deepLink(
                        '67505f191bd71d2a087b058e',
                        'aaa',
                        'Quinoabowl met bloemkool en pompoen',
                      ),
                    },
                  },
                },
              },
              {
                pml: {
                  component: {
                    onPress: {
                      url: deepLink('69d90b51e11f1e663bc15d2b', 'bbb', 'Sticky honing-sesamkip'),
                    },
                  },
                },
              },
              // Same tile rendered twice — must not duplicate.
              {
                pml: {
                  component: {
                    onPress: {
                      url: deepLink('69d90b51e11f1e663bc15d2b', 'bbb', 'Sticky honing-sesamkip'),
                    },
                  },
                },
              },
              {
                pml: {
                  component: {
                    onPress: {
                      url: deepLink(
                        '69faf58a534bad06255a9c11',
                        'ccc',
                        'Griekse stijl orzo met harissa',
                      ),
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
};

/** Mirrors selling-group-details-page: state object + analytics context. */
const detailsPage = {
  id: 'selling-group-details-page',
  body: {
    child: {
      child: {
        analytics: {
          contexts: [
            {
              data: {
                image_type: 'CUSTOM',
                portions: 4,
                recipe_id: '6335ac14ce42386977937080',
                recipe_name: 'Tomatenrisotto met spinazie en chorizo',
                selling_units: [
                  {
                    checked: true,
                    ingredient_id: '60095cf0-022e-47a9-88a7-ca02b6227f02',
                    quantity: 1,
                    selling_unit_id: 's1012860',
                    status: 'ACTIVE',
                    swap_type: null,
                  },
                  {
                    checked: true,
                    ingredient_id: 'd56bfb1a-ac5b-4816-acaa-dd3dc43e2a0c',
                    quantity: 1,
                    selling_unit_id: 's1011130',
                    status: 'ACTIVE',
                    swap_type: null,
                  },
                ],
              },
            },
          ],
        },
        state: {
          basketModificationOngoing: false,
          portions: 4,
          sellableId: '6335ac14ce42386977937080',
          sellingUnitIds: ['s1012860', 's1011130', 's1115349'],
          // Only the first two are ticked when the recipe opens; the third is
          // an offered pantry extra. Mirrors the real page, where 6 of 15
          // ingredients were pre-selected.
          defaultSelectedIngredientIds: [
            '60095cf0-022e-47a9-88a7-ca02b6227f02',
            'd56bfb1a-ac5b-4816-acaa-dd3dc43e2a0c',
          ],
          ingredientsState: [
            {
              ingredientId: '60095cf0-022e-47a9-88a7-ca02b6227f02',
              ingredientType: 'CORE',
              isAvailable: true,
              isExcluded: false,
              sellingUnits: {
                s1012860: {
                  price: 179,
                  quantityInBasket: 0,
                  referencePrice: 179,
                  requiredAmount: 1,
                  sellingUnitId: 's1012860',
                },
              },
            },
            {
              ingredientId: 'd56bfb1a-ac5b-4816-acaa-dd3dc43e2a0c',
              ingredientType: 'CORE',
              isAvailable: true,
              isExcluded: false,
              sellingUnits: {
                s1011130: {
                  price: 259,
                  quantityInBasket: 0,
                  referencePrice: 259,
                  requiredAmount: 2,
                  sellingUnitId: 's1011130',
                },
              },
            },
            // Unavailable ingredient — kept, but flagged.
            {
              ingredientId: '5ef7bb57-6d37-4c6b-a495-f06ed1bdb298',
              ingredientType: 'NON_CORE',
              isAvailable: false,
              isExcluded: false,
              sellingUnits: {
                s1115349: {
                  price: 99,
                  quantityInBasket: 0,
                  referencePrice: 99,
                  requiredAmount: 1,
                  sellingUnitId: 's1115349',
                },
              },
            },
            // De-selected in the app — must NOT reach a shopping list.
            {
              ingredientId: 'ffffffff-0000-0000-0000-000000000000',
              ingredientType: 'NON_CORE',
              isAvailable: true,
              isExcluded: true,
              sellingUnits: {
                s999999: { price: 100, requiredAmount: 1, sellingUnitId: 's999999' },
              },
            },
          ],
        },
      },
    },
  },
};

// ──────────────────────────────────────────────────────────────────────
// Listing
// ──────────────────────────────────────────────────────────────────────

console.log('\nSaved-recipe listing');
const listed = parseRecipeList(savedListPage, { saved: true });
check('finds recipes via deep links', listed.length === 3, `got ${listed.length}`);
check('deduplicates a tile rendered twice', new Set(listed.map((r) => r.id)).size === 3);
check(
  'decodes names',
  listed.some((r) => r.name === 'Griekse stijl orzo met harissa'),
  JSON.stringify(listed.map((r) => r.name)),
);
check(
  'marks them saved',
  listed.every((r) => r.saved),
);
check(
  'tags the source',
  listed.every((r) => r.source === 'picnic'),
);
check('keeps the image reference', listed[0]?.image === 'recipes/aaa');
check(
  'finds nothing in an unrelated page',
  parseRecipeList({ a: 1 }, { saved: true }).length === 0,
);

// ──────────────────────────────────────────────────────────────────────
// Details
// ──────────────────────────────────────────────────────────────────────

console.log('\nRecipe details');
const details = parseRecipeDetails(detailsPage, '6335ac14ce42386977937080');
check('parses the page', details !== null);
check('reads the recipe name', details?.name === 'Tomatenrisotto met spinazie en chorizo');
check('reads portions', details?.portions === 4);

const ing = details?.ingredients ?? [];
check('excluded ingredients are dropped', !ing.some((i) => i.ingredientId.startsWith('ffffffff')));
check('keeps the remaining ingredients', ing.length === 3, `got ${ing.length}`);
check(
  'maps each ingredient to a Picnic article id',
  ing.every((i) => i.articleId !== null),
  JSON.stringify(ing.map((i) => i.articleId)),
);
check('reads required amount', ing.find((i) => i.articleId === 's1011130')?.requiredAmount === 2);
check('reads price', ing.find((i) => i.articleId === 's1012860')?.priceCents === 179);
check(
  'flags an unavailable ingredient',
  ing.find((i) => i.articleId === 's1115349')?.available === false,
);
check(
  'distinguishes CORE from non-core',
  ing.find((i) => i.articleId === 's1012860')?.core === true,
);

// The selected/optional split decides what a shopping list contains. On the
// real page 15 ingredients totalled €48.33 but only the 6 pre-selected ones
// (€11.80) were actually needed, so getting this wrong would quadruple a
// week's grocery bill.
check(
  'marks pre-selected ingredients as selected',
  ing.find((i) => i.articleId === 's1012860')?.selected === true,
);
check(
  'marks offered extras as NOT selected',
  ing.find((i) => i.articleId === 's1115349')?.selected === false,
  JSON.stringify(ing.map((i) => [i.articleId, i.selected])),
);
check('only the pre-selected count toward a list', ing.filter((i) => i.selected).length === 2);
check('non-core is marked as such', ing.find((i) => i.articleId === 's1115349')?.core === false);

// The analytics context alone must still work — it is the fallback path when
// Picnic changes the state object.
console.log('\nAnalytics fallback (state object absent)');
const analyticsOnly = {
  body: {
    analytics: {
      contexts: [
        {
          data: {
            portions: 2,
            recipe_id: '6335ac14ce42386977937080',
            recipe_name: 'Tomatenrisotto',
            selling_units: [
              {
                checked: true,
                ingredient_id: 'a',
                quantity: 3,
                selling_unit_id: 's1',
                status: 'ACTIVE',
              },
              {
                checked: false,
                ingredient_id: 'b',
                quantity: 1,
                selling_unit_id: 's2',
                status: 'ACTIVE',
              },
            ],
          },
        },
      ],
    },
  },
};
const fallback = parseRecipeDetails(analyticsOnly, '6335ac14ce42386977937080');
check('falls back to analytics', fallback !== null);
check('fallback reads article ids', fallback?.ingredients[0]?.articleId === 's1');
check('fallback reads quantity', fallback?.ingredients[0]?.requiredAmount === 3);
check('fallback keeps both ingredients', fallback?.ingredients.length === 2);
check(
  'fallback marks the unchecked one as not selected',
  fallback?.ingredients.find((i) => i.articleId === 's2')?.selected === false,
);
check(
  'fallback marks the checked one as selected',
  fallback?.ingredients.find((i) => i.articleId === 's1')?.selected === true,
);

// Without an explicit selection list the parser must not mark pantry extras as
// "buy this" — it falls back to the CORE flag rather than defaulting to true.
console.log('\nNo selection list present');
const noSelection = parseRecipeDetails(
  {
    body: {
      state: {
        ingredientsState: [
          {
            ingredientId: 'a',
            ingredientType: 'CORE',
            isAvailable: true,
            sellingUnits: { s1: { price: 1, requiredAmount: 1, sellingUnitId: 's1' } },
          },
          {
            ingredientId: 'b',
            ingredientType: 'NON_CORE',
            isAvailable: true,
            sellingUnits: { s2: { price: 1, requiredAmount: 1, sellingUnitId: 's2' } },
          },
        ],
      },
    },
  },
  'x',
);
check(
  'falls back to CORE when no selection list exists',
  noSelection?.ingredients.find((i) => i.articleId === 's1')?.selected === true &&
    noSelection?.ingredients.find((i) => i.articleId === 's2')?.selected === false,
);

console.log('\nUnparseable input');
check(
  'returns null rather than an empty recipe',
  parseRecipeDetails({ nothing: true }, 'x') === null,
);

// ──────────────────────────────────────────────────────────────────────
// Registry — the seam for a future personal recipe database
// ──────────────────────────────────────────────────────────────────────

console.log('\nRegistry across multiple sources');

class FakeSource implements RecipeSource {
  constructor(
    readonly name: string,
    private readonly recipes: RecipeSummary[],
    private readonly fail = false,
  ) {}
  async listRecipes(): Promise<RecipeSummary[]> {
    if (this.fail) throw new Error('source unavailable');
    return this.recipes;
  }
  async getRecipeDetails(id: string): Promise<RecipeDetails | null> {
    const hit = this.recipes.find((r) => r.id === id);
    return hit
      ? { id: hit.id, name: hit.name, source: this.name, portions: 2, ingredients: [] }
      : null;
  }
}

const registry = new RecipeRegistry([
  new FakeSource('picnic', [{ id: 'p1', name: 'Risotto', source: 'picnic', saved: true }]),
  new FakeSource('personal', [{ id: 'x1', name: 'Oma se soep', source: 'personal', saved: true }]),
]);

const combined = await registry.listRecipes();
check('merges sources', combined.recipes.length === 2);
check(
  'namespaces ids by source',
  combined.recipes.some((r) => r.id === 'picnic:p1') &&
    combined.recipes.some((r) => r.id === 'personal:x1'),
  JSON.stringify(combined.recipes.map((r) => r.id)),
);
check(
  'routes a qualified id',
  (await registry.getRecipeDetails('personal:x1'))?.name === 'Oma se soep',
);
check('resolves an unqualified id', (await registry.getRecipeDetails('p1'))?.name === 'Risotto');
check('unknown id returns null', (await registry.getRecipeDetails('picnic:nope')) === null);

const degraded = new RecipeRegistry([
  new FakeSource('picnic', [{ id: 'p1', name: 'Risotto', source: 'picnic', saved: true }]),
  new FakeSource('broken', [], true),
]);
const partial = await degraded.listRecipes();
check('one failing source does not lose the others', partial.recipes.length === 1);
check('the failure is reported, not swallowed', partial.failures[0]?.source === 'broken');

// ──────────────────────────────────────────────────────────────────────
// Recipe name matching
//
// This is the one piece of recipe logic that has already shipped a defect in
// front of the household: a substring match meant a query for their own saved
// recipe returned nothing, and the assistant stated the recipe was not saved.
// Being confidently wrong in that direction is the failure mode these checks
// exist to prevent, so most of them assert that a reasonable query still finds
// a recipe rather than that a bad one is excluded.
// ──────────────────────────────────────────────────────────────────────

const QUINOA = 'Quinoabowl met bloemkool en pompoen';

check('exact name matches', matchesRecipeQuery(QUINOA, QUINOA));
check('a single distinctive word matches', matchesRecipeQuery(QUINOA, 'quinoabowl'));
check('word order does not matter', matchesRecipeQuery(QUINOA, 'pompoen bloemkool'));
check('matching ignores case', matchesRecipeQuery(QUINOA, 'QUINOABOWL'));
check(
  'a word the name does not contain excludes it',
  !matchesRecipeQuery(QUINOA, 'quinoabowl kip'),
);

// The regression that prompted all of this. Filler words must not be able to
// veto a match: every significant word is mandatory, so leaving "met" and "en"
// in the query would require them to appear in the title as well.
check('filler words do not veto a match', matchesRecipeQuery(QUINOA, 'recept met pompoen'));
check(
  'filler words are dropped before matching',
  JSON.stringify(significantWords('recept met pompoen')) === JSON.stringify(['pompoen']),
  JSON.stringify(significantWords('recept met pompoen')),
);
check(
  'a title word that is also filler is still findable',
  matchesRecipeQuery('Soep van de dag', 'soep dag'),
);

// Diacritics: the household's recipes are Dutch, but Picnic titles carry
// French and Italian loan words with accents that nobody types into a chat.
check('diacritics in the name are ignored', matchesRecipeQuery('Kaassoufflé', 'kaassouffle'));
check('diacritics in the query are ignored', matchesRecipeQuery('Kaassouffle', 'kaassoufflé'));

// Degenerate queries resolve towards showing everything, never towards an
// empty result that reads as "you have no such recipe".
check('an empty query matches', matchesRecipeQuery(QUINOA, ''));
check('a punctuation-only query matches', matchesRecipeQuery(QUINOA, '???'));
check('a query of nothing but filler matches', matchesRecipeQuery(QUINOA, 'het recept van de'));
check('single characters cannot decide a match', matchesRecipeQuery(QUINOA, 'a'));

// ──────────────────────────────────────────────────────────────────────
// Recipe rotation
//
// The defect this replaces: the weekly menu proposed what the household had
// eaten days earlier. Nothing recorded which recipes were cooked, and the
// listing carried no time dimension, so the model had nothing to avoid. These
// checks pin both halves of the fix — that history sorts a listing, and that
// a missing history never reads as a recent meal.
// ──────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-08-22T12:00:00Z');

const library: RecipeSummary[] = [
  { id: 'picnic:a', name: 'Aardappelgratin', source: 'picnic', saved: true },
  { id: 'picnic:b', name: 'Bloemkoolcurry', source: 'picnic', saved: true },
  { id: 'picnic:c', name: 'Chorizorisotto', source: 'picnic', saved: true },
  { id: 'picnic:d', name: 'Dahl met spinazie', source: 'picnic', saved: true },
];

const usage = new Map<string, RecipeUsageInfo>([
  // Cooked three days ago — the thing they just ate.
  ['picnic:c', { lastUsedAt: '2026-08-19T18:00:00Z', timesUsed: 4 }],
  // Cooked two months ago — fair game again.
  ['picnic:a', { lastUsedAt: '2026-06-22T18:00:00Z', timesUsed: 1 }],
  // Yesterday.
  ['picnic:b', { lastUsedAt: '2026-08-21T18:00:00Z', timesUsed: 2 }],
]);

const ranked = rankByRotation(library, usage, NOW);

check(
  'never-cooked recipes rank first',
  ranked[0]?.id === 'picnic:d',
  ranked.map((r) => r.id).join(','),
);
check(
  'the rest rank longest-ago first',
  ranked.map((r) => r.id).join(',') === 'picnic:d,picnic:a,picnic:c,picnic:b',
  ranked.map((r) => `${r.id}:${String(r.daysSinceUsed)}`).join(','),
);
// 19 Aug 18:00 → 22 Aug 12:00 is 2 days and 18 hours. Floored, not rounded:
// a recipe is "2 days ago" until the third day has fully passed, which is the
// conservative direction for a rotation window.
check(
  'day counts floor to whole days',
  ranked.find((r) => r.id === 'picnic:c')?.daysSinceUsed === 2,
);
check(
  'a never-cooked recipe reports null, not zero',
  ranked.find((r) => r.id === 'picnic:d')?.daysSinceUsed === null &&
    ranked.find((r) => r.id === 'picnic:d')?.lastUsedAt === null,
);
check('use counts come through', ranked.find((r) => r.id === 'picnic:c')?.timesUsed === 4);
check(
  'lastUsedAt is a plain date',
  ranked.find((r) => r.id === 'picnic:a')?.lastUsedAt === '2026-06-22',
);

// Ranking must not depend on the order the library arrives in — Picnic's page
// order is arbitrary and changes, and an unstable listing would return
// different recipes on a retry of the same request.
const shuffled = rankByRotation([...library].reverse(), usage, NOW);
check(
  'ranking is independent of input order',
  shuffled.map((r) => r.id).join(',') === ranked.map((r) => r.id).join(','),
);

const { eligible, tooRecent } = splitByRotationWindow(ranked, 14);
check(
  'recipes inside the window are held back',
  tooRecent
    .map((r) => r.id)
    .sort()
    .join(',') === 'picnic:b,picnic:c',
  tooRecent.map((r) => r.id).join(','),
);
check(
  'recipes outside the window stay',
  eligible
    .map((r) => r.id)
    .sort()
    .join(',') === 'picnic:a,picnic:d',
  eligible.map((r) => r.id).join(','),
);

// The load-bearing one. No usage record means the tracking has not seen it,
// which is not evidence of a recent meal — dropping those would hide most of
// the library in the first weeks after this shipped, when the table is empty.
check(
  'no usage record is never treated as recently cooked',
  splitByRotationWindow(rankByRotation(library, new Map(), NOW), 365).tooRecent.length === 0,
);

// A recipe cooked exactly `withinDays` ago is out of the window, not in it —
// otherwise a 14-day rotation silently becomes 15.
const boundary = rankByRotation(
  [{ id: 'picnic:e', name: 'Erwtensoep', source: 'picnic', saved: true }],
  new Map([['picnic:e', { lastUsedAt: '2026-08-08T12:00:00Z', timesUsed: 1 }]]),
  NOW,
);
check('the rotation window boundary is exclusive', boundary[0]?.daysSinceUsed === 14);
check(
  'a recipe exactly one window old is eligible again',
  splitByRotationWindow(boundary, 14).eligible.length === 1,
);

// Clock skew, or a same-day re-commit, must not sort a just-cooked recipe to
// the top of a stalest-first list — the exact inverse of the intent.
const future = rankByRotation(
  [{ id: 'picnic:f', name: 'Forel', source: 'picnic', saved: true }],
  new Map([['picnic:f', { lastUsedAt: '2026-08-23T12:00:00Z', timesUsed: 1 }]]),
  NOW,
);
check('a future timestamp clamps to zero days', future[0]?.daysSinceUsed === 0);
check('and is held back by the window', splitByRotationWindow(future, 14).tooRecent.length === 1);

// ──────────────────────────────────────────────────────────────────────

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) FAILED, ${passed} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`All ${passed} recipe checks passed.`);
