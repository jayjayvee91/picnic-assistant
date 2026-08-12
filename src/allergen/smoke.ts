/**
 * Fixture-driven checks for the gluten guard.
 *
 * Run with:
 *   npm run smoke:allergen
 *
 * Unlike the other smoke scripts this one needs NO network, NO Picnic session
 * and NO API key — the decision engine is pure, so it can be exercised against
 * canned product data. That is deliberate: the safety-critical logic is the
 * part that must be verifiable offline, on every change, in a second.
 *
 * Exits non-zero on the first failure so it can gate a deploy.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateGluten, applyException } from './guard.js';
import {
  parseRulebook,
  matchRules,
  ensureRulebookSeeded,
  EMPTY_RULEBOOK,
  type GlutenRulebook,
} from './rulebook.js';
import { AllergenChecker } from './check.js';
import { openDatabase } from '../memory/index.js';
import { handleToolUse, type AgentContext } from '../agent/tools.js';
import { loadDraft, emptyDraft } from '../agent/draft.js';
import type { ProductDetails } from '../picnic/index.js';

// ──────────────────────────────────────────────────────────────────────
// Tiny assertion harness (the repo has no test runner by design)
// ──────────────────────────────────────────────────────────────────────

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
// Fixtures
// ──────────────────────────────────────────────────────────────────────

/** Build a ProductDetails fixture with only the fields the guard reads. */
function product(opts: {
  allergens?: string[];
  ingredients?: string | null;
  name?: string;
}): ProductDetails {
  const sections =
    opts.ingredients === null || opts.ingredients === undefined
      ? []
      : [{ title: 'Ingrediënten', content: opts.ingredients }];
  return {
    id: 's1',
    name: opts.name ?? 'Testproduct',
    allergens: opts.allergens ?? [],
    infoSections: sections,
  } as unknown as ProductDetails;
}

const RULES: GlutenRulebook = parseRulebook(`
## Bevat gluten
- tarwe — alle tarwevormen
- gerst
- mout
- orzo

## Twijfel
- gemodificeerd zetmeel
- aroma

## Veilig
- glutenvrij
- maiszetmeel

## Voorbeelden
- Mout komt van gerst.
`);

// ──────────────────────────────────────────────────────────────────────
// Rulebook parsing
// ──────────────────────────────────────────────────────────────────────

console.log('\nRulebook parsing');
check('parses blocking terms', RULES.contains.includes('tarwe'), JSON.stringify(RULES.contains));
check('strips inline comments', !RULES.contains.some((t) => t.includes('alle tarwevormen')));
check('parses doubtful terms', RULES.doubtful.includes('gemodificeerd zetmeel'));
check('parses safe terms', RULES.safe.includes('maiszetmeel'));
check('keeps notes out of rules', RULES.notes.length === 1 && RULES.contains.length === 4);

console.log('\nTerm matching');
check(
  'matches inside Dutch compounds (tarwebloem)',
  matchRules('bevat tarwebloem en water', RULES).some((m) => m.term === 'tarwe'),
);
check(
  'does not match mid-word (contarwe is not tarwe)',
  !matchRules('contarwe', RULES).some((m) => m.term === 'tarwe'),
);
check(
  'is diacritic-insensitive',
  matchRules('maïszetmeel, gerst', RULES).some((m) => m.term === 'gerst'),
);
check(
  'safe terms suppress broader rules',
  matchRules('glutenvrije tarwevervanger', { ...RULES, safe: ['glutenvrije tarwevervanger'] })
    .length === 0,
);

// ──────────────────────────────────────────────────────────────────────
// Layer 1 — Picnic's declared allergens
// ──────────────────────────────────────────────────────────────────────

console.log('\nLayer 1: Picnic allergen declaration');

const declaredGluten = evaluateGluten({
  details: product({ allergens: ['Gluten', 'Melk'], ingredients: 'tarwebloem, water' }),
  rulebook: RULES,
});
check('declared gluten blocks', declaredGluten.verdict === 'blocked', declaredGluten.reason);
check('block is attributed to Picnic', declaredGluten.decidedBy === 'picnic_allergens');

const declaredGrain = evaluateGluten({
  details: product({ allergens: ['Tarwe'], ingredients: 'meel' }),
  rulebook: RULES,
});
check('a gluten-bearing grain in the allergen list blocks', declaredGrain.verdict === 'blocked');

// Traces are flattened into the same list upstream; both must block.
const traces = evaluateGluten({
  details: product({ allergens: ['Melk', 'Gluten'], ingredients: 'rijst' }),
  rulebook: RULES,
});
check('"may contain" gluten also blocks', traces.verdict === 'blocked', traces.reason);

const cleanDeclaration = evaluateGluten({
  details: product({ allergens: ['Melk', 'Soja'], ingredients: 'water, rijstmeel, zout' }),
  rulebook: RULES,
});
check(
  'allergens declared without gluten is allowed',
  cleanDeclaration.verdict === 'allowed',
  cleanDeclaration.reason,
);

check(
  '"glutenvrij" in the allergen block is not read as containing gluten',
  evaluateGluten({
    details: product({ allergens: ['Glutenvrij', 'Melk'], ingredients: 'rijst' }),
    rulebook: RULES,
  }).verdict === 'allowed',
);

// ──────────────────────────────────────────────────────────────────────
// Layer 1b — explicit gluten-free claims
// ──────────────────────────────────────────────────────────────────────
//
// A live run reported "De Cecco gnocchi glutenvrij" as unverified. An absurd
// warning teaches the household to ignore warnings, so a regulated
// gluten-free claim now counts as evidence.

console.log('\nLayer 1b: gluten-free claims');

const claimed = evaluateGluten({
  details: product({ allergens: [], ingredients: null, name: 'De Cecco gnocchi glutenvrij' }),
  rulebook: RULES,
});
check('a "glutenvrij" product name is allowed', claimed.verdict === 'allowed', claimed.reason);
check('the claim is attributed as such', claimed.decidedBy === 'gluten_free_claim');

check(
  'an English "gluten free" claim also counts',
  evaluateGluten({
    details: product({ allergens: [], ingredients: null, name: 'Schar bread gluten free' }),
    rulebook: RULES,
  }).verdict === 'allowed',
);

// The safety-critical half: a claim may promote unknown to allowed, but must
// never overturn a declaration that gluten IS present.
const contradictory = evaluateGluten({
  details: product({
    allergens: ['Gluten'],
    ingredients: 'tarwebloem',
    name: 'Nepmerk glutenvrij brood',
  }),
  rulebook: RULES,
});
check(
  'a declared allergen still beats a gluten-free claim',
  contradictory.verdict === 'blocked',
  contradictory.reason,
);

check(
  'a rulebook block still beats a gluten-free claim',
  evaluateGluten({
    details: product({ allergens: ['Melk'], ingredients: 'gerstemout' }),
    rulebook: RULES,
  }).verdict === 'blocked',
);

check(
  '"bevat gluten" is not misread as a gluten-free claim',
  evaluateGluten({
    details: product({ allergens: [], ingredients: 'bevat gluten', name: 'Gewoon brood' }),
    rulebook: RULES,
  }).verdict !== 'allowed',
);

// ──────────────────────────────────────────────────────────────────────
// Rulebook comments
// ──────────────────────────────────────────────────────────────────────

console.log('\nRulebook comments');
const commented = parseRulebook(`
## Bevat gluten
- tarwe

<!--
Deliberately disabled:
- aroma
- zetmeel
-->
`);
check('HTML-commented bullets are not read as rules', commented.contains.length === 1);
check(
  'a disabled term does not silently come back',
  !commented.contains.includes('aroma') && !commented.doubtful.includes('aroma'),
  JSON.stringify(commented),
);

// ──────────────────────────────────────────────────────────────────────
// Layer 2 — the rulebook
// ──────────────────────────────────────────────────────────────────────

console.log('\nLayer 2: rulebook against the ingredient text');

const rulebookBlock = evaluateGluten({
  details: product({ allergens: ['Melk'], ingredients: 'water, gerstemout, suiker' }),
  rulebook: RULES,
});
check('a blocking term in the ingredients blocks', rulebookBlock.verdict === 'blocked');
check('block names the matched term', rulebookBlock.matchedTerms.includes('gerst'));
check('block is attributed to the rulebook', rulebookBlock.decidedBy === 'rulebook');

const doubtful = evaluateGluten({
  details: product({ allergens: ['Melk'], ingredients: 'water, gemodificeerd zetmeel' }),
  rulebook: RULES,
});
check('a doubtful term yields unverified, not blocked', doubtful.verdict === 'unverified');
check('doubtful is not silently allowed', doubtful.verdict !== 'allowed');

check(
  'rulebook catches gluten Picnic did not declare',
  evaluateGluten({
    details: product({ allergens: ['Melk'], ingredients: 'orzo, tomaat' }),
    rulebook: RULES,
  }).verdict === 'blocked',
);

// ──────────────────────────────────────────────────────────────────────
// Fail-safe behaviour — the heart of the design
// ──────────────────────────────────────────────────────────────────────

console.log('\nFail-safe: unknown is never treated as safe');

const noDetails = evaluateGluten({ details: null, rulebook: RULES });
check('a failed fetch is unverified', noDetails.verdict === 'unverified', noDetails.reason);
check('a failed fetch is never allowed', noDetails.verdict !== 'allowed');

// A COMPLETE ingredient list with no gluten source is proof, not a gap: EU
// labelling law requires gluten cereals to be named in it. This was once
// `unverified`, but real data showed that caution flagged ordinary products
// like "Bio quinoa" and "Ras el hanout", pushing the flag rate high enough
// that the warnings would stop being read at all.
const cleanIngredientsNoAllergens = evaluateGluten({
  details: product({ allergens: [], ingredients: 'water, rijst, zout' }),
  rulebook: RULES,
});
check(
  'a clean full ingredient list is allowed even without an allergen block',
  cleanIngredientsNoAllergens.verdict === 'allowed',
  cleanIngredientsNoAllergens.reason,
);

const nothingAtAll = evaluateGluten({
  details: product({ allergens: [], ingredients: null }),
  rulebook: RULES,
});
check('no data at all is unverified', nothingAtAll.verdict === 'unverified');

check(
  'an empty rulebook still blocks on declared gluten',
  evaluateGluten({
    details: product({ allergens: ['Gluten'], ingredients: 'tarwe' }),
    rulebook: EMPTY_RULEBOOK,
  }).verdict === 'blocked',
);

// The rulebook is for tuning, not for supplying the basics. Even with NO
// rules at all, a gluten grain in the ingredient text must still block —
// otherwise the "clean list means allowed" conclusion above would be unsafe
// for any household that edited or emptied their rulebook.
check(
  'an empty rulebook still blocks a gluten grain in the ingredients',
  evaluateGluten({
    details: product({ allergens: [], ingredients: 'tarwebloem, water' }),
    rulebook: EMPTY_RULEBOOK,
  }).verdict === 'blocked',
);
check(
  'the built-in floor catches "bevat gluten" with no matching rule',
  evaluateGluten({
    details: product({ allergens: [], ingredients: 'bevat gluten', name: 'Gewoon brood' }),
    rulebook: EMPTY_RULEBOOK,
  }).verdict === 'blocked',
);
check(
  'the built-in floor does not fire on "glutenvrije bloem"',
  evaluateGluten({
    details: product({ allergens: ['Melk'], ingredients: 'glutenvrije bloem, rijstmeel' }),
    rulebook: EMPTY_RULEBOOK,
  }).verdict === 'allowed',
);
check(
  'a product with no label at all stays unverified',
  evaluateGluten({
    details: product({ allergens: [], ingredients: null, name: 'Broccoli' }),
    rulebook: RULES,
  }).verdict === 'unverified',
);

// ──────────────────────────────────────────────────────────────────────
// Layer 0 — human overrides and deliberate exceptions
// ──────────────────────────────────────────────────────────────────────

console.log('\nLayer 0: overrides and deliberate exceptions');

const forcedBlock = evaluateGluten({
  details: product({ allergens: ['Melk'], ingredients: 'rijst' }),
  rulebook: RULES,
  override: { verdict: 'blocked', reason: 'Zelf gecontroleerd: bevat wel degelijk gluten.' },
});
check(
  'an override can block a product Picnic calls clean',
  forcedBlock.verdict === 'blocked',
  forcedBlock.reason,
);
check('override is attributed as such', forcedBlock.decidedBy === 'override');

const forcedAllow = evaluateGluten({
  details: product({ allergens: ['Gluten'], ingredients: 'tarwebloem' }),
  rulebook: RULES,
  override: { verdict: 'allowed', reason: 'Bewust: brood voor huisgenoot zonder coeliakie.' },
});
check('an override can allow a gluten product deliberately', forcedAllow.verdict === 'allowed');

const exception = applyException(declaredGluten, 'ja, ik weet dat hier gluten in zit');
check('applyException flips a block to allowed', exception.verdict === 'allowed');
check('applyException marks it as an exception', exception.decidedBy === 'exception');
check(
  'applyException preserves the original reason for the audit trail',
  exception.reason.includes(declaredGluten.reason),
);

// ──────────────────────────────────────────────────────────────────────
// Invariant: nothing downgrades a block except an explicit human act
// ──────────────────────────────────────────────────────────────────────

console.log('\nInvariant: blocks only fall to a deliberate human decision');

const blockingScenarios: Array<[string, ReturnType<typeof evaluateGluten>]> = [
  ['declared gluten', declaredGluten],
  ['grain in allergen list', declaredGrain],
  ['rulebook term', rulebookBlock],
];
for (const [label, decision] of blockingScenarios) {
  check(`${label} stays blocked without an override`, decision.verdict === 'blocked');
}

// ──────────────────────────────────────────────────────────────────────
// Wiring: the tools must actually CALL the guard
// ──────────────────────────────────────────────────────────────────────
//
// The pure checks above prove the engine decides correctly. They say nothing
// about whether the cart-entry paths invoke it — and a guard that is never
// called is the failure mode that matters most here. These run the real tool
// handlers against a fake Picnic client and an in-memory database.

console.log('\nWiring: cart-entry paths run the guard');

await (async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'gluten-'));
  const rulebookPath = join(dir, 'gluten-rules.md');
  await ensureRulebookSeeded(rulebookPath);

  const db = openDatabase(join(dir, 'test.db'));

  // Fake Picnic: article "glutenbrood" declares gluten, "rijst" is clean.
  let addedToCart = 0;
  const picnic = {
    async getProductDetails(id: string) {
      if (id === 'glutenbrood') {
        return product({ allergens: ['Gluten'], ingredients: 'tarwebloem, water', name: 'Brood' });
      }
      return product({ allergens: ['Melk'], ingredients: 'rijst, water', name: 'Rijstwafel' });
    },
    async addProductToCart() {
      addedToCart++;
    },
  };

  const ctx = {
    db,
    picnic,
    profilePath: join(dir, 'profile.md'),
    rulebookPath,
    allergen: new AllergenChecker({
      db,
      picnic: picnic as never,
      rulebookPath,
      cacheTtlMs: 0,
    }),
    conversationKey: 'smoke',
    proposedProfileAdditions: new Map(),
    proposedGlutenRules: new Map(),
  } as unknown as AgentContext;

  const call = async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const result = await handleToolUse(ctx, {
      type: 'tool_use',
      id: 'x',
      name,
      input,
    } as Parameters<typeof handleToolUse>[1]);
    return JSON.parse(result.content) as Record<string, unknown>;
  };

  // add_to_draft must refuse a gluten product and leave the draft empty.
  const draftBlocked = await call('add_to_draft', {
    articleId: 'glutenbrood',
    articleName: 'Brood',
  });
  check('add_to_draft refuses a gluten product', draftBlocked['blockedByGlutenGuard'] === true);
  check('refused product does not enter the draft', loadDraft(db, 'smoke').length === 0);

  // A clean product goes through.
  const draftOk = await call('add_to_draft', { articleId: 'rijst', articleName: 'Rijstwafel' });
  check('add_to_draft accepts a clean product', draftOk['ok'] === true);
  check('accepted product enters the draft', loadDraft(db, 'smoke').length === 1);

  // add_to_cart_now must be gated identically — this is the ad-hoc path.
  const cartBlocked = await call('add_to_cart_now', {
    articleId: 'glutenbrood',
    articleName: 'Brood',
  });
  check('add_to_cart_now refuses a gluten product', cartBlocked['blockedByGlutenGuard'] === true);
  check('refused product never reaches Picnic', addedToCart === 0);

  // The deliberate exception is the ONLY way through.
  const exception = await call('add_with_gluten_exception', {
    articleId: 'glutenbrood',
    articleName: 'Brood',
    scope: 'once',
    target: 'cart',
    acknowledgement: 'ja, ik weet dat hier gluten in zit',
  });
  check('add_with_gluten_exception lets a gluten product through', exception['ok'] === true);
  check('the exception actually reached Picnic', addedToCart === 1);

  // …and a "once" exception must not persist.
  const afterOnce = await call('add_to_cart_now', {
    articleId: 'glutenbrood',
    articleName: 'Brood',
  });
  check(
    'a one-off exception is consumed, not permanent',
    afterOnce['blockedByGlutenGuard'] === true,
  );

  // ── The recipe path must be gated exactly like the others ──────────
  // A recipe can pull a dozen articles into the draft in one call, so this is
  // the highest-leverage place for the guard to be missing.
  const { RecipeRegistry } = await import('../recipe/index.js');
  const recipeCtx = ctx as unknown as { recipes: unknown };
  recipeCtx.recipes = new RecipeRegistry([
    {
      name: 'picnic',
      async listRecipes() {
        return [{ id: 'r1', name: 'Testrecept', source: 'picnic', saved: true }];
      },
      async getRecipeDetails() {
        return {
          id: 'r1',
          name: 'Testrecept',
          source: 'picnic',
          portions: 4,
          ingredients: [
            {
              ingredientId: 'i1',
              name: null,
              articleId: 'rijst',
              requiredAmount: 1,
              priceCents: 100,
              available: true,
              core: true,
              selected: true,
            },
            {
              ingredientId: 'i2',
              name: null,
              articleId: 'glutenbrood',
              requiredAmount: 1,
              priceCents: 200,
              available: true,
              core: true,
              selected: true,
            },
            {
              ingredientId: 'i3',
              name: null,
              articleId: 'rijst',
              requiredAmount: 1,
              priceCents: 999,
              available: true,
              core: false,
              selected: false,
            },
          ],
        };
      },
    },
  ]);

  emptyDraft(db, 'smoke');
  const recipeAdd = await call('add_recipe_to_draft', { recipeId: 'picnic:r1' });
  const draftAfterRecipe = loadDraft(db, 'smoke');
  check(
    'add_recipe_to_draft refuses the gluten ingredient',
    Array.isArray(recipeAdd['blockedByGlutenGuard']) &&
      (recipeAdd['blockedByGlutenGuard'] as unknown[]).length === 1,
  );
  check(
    'the gluten ingredient never enters the draft',
    !draftAfterRecipe.some((i) => i.articleId === 'glutenbrood'),
  );
  check(
    'the safe ingredient is added',
    draftAfterRecipe.some((i) => i.articleId === 'rijst'),
  );
  check(
    'optional pantry extras are excluded by default',
    draftAfterRecipe.length === 1,
    `draft had ${draftAfterRecipe.length} items`,
  );

  // A commit must refuse outright if any item is blocked. Seed the draft with a
  // gluten item directly, simulating a rule added after the item was drafted.
  await writeFile(rulebookPath, '## Bevat gluten\n- rijst — testregel\n', 'utf8');
  const commit = await call('commit_draft_to_cart', {});
  check(
    'commit refuses when a draft item is now blocked',
    commit['ok'] === false && Array.isArray(commit['blockedByGlutenGuard']),
  );
  check('nothing extra was pushed on a refused commit', addedToCart === 1);

  db.close();
})();

// ──────────────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────────────

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) FAILED, ${passed} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`All ${passed} gluten-guard checks passed.`);
