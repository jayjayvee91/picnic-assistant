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

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) FAILED, ${passed} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`All ${passed} recipe checks passed.`);
