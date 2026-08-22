/**
 * Offline checks for recipe rotation, end to end through the real SQLite
 * schema.
 *
 * Run with:
 *   npm run smoke:rotation
 *
 * No network, no Picnic session, no API key — the database is `:memory:`, so
 * this runs in CI alongside the parser and gluten checks.
 *
 * `src/recipe/smoke.ts` covers the ranking arithmetic in isolation. What is
 * checked here is the wiring around it, which is where this feature can fail
 * silently: a recipe id that is dropped somewhere between `add_recipe_to_draft`
 * and the commit produces no error and no wrong answer — it produces a
 * `recipe_usage` table that stays empty, and a menu that quietly goes on
 * repeating itself. That is precisely the bug this feature exists to fix, so
 * it is worth an assertion rather than trust.
 *
 * This lives in the agent layer because it spans both the memory layer and the
 * draft, and the agent is the layer allowed to depend on both.
 */

import { openDatabase } from '../memory/index.js';
import {
  recordRecipeUsage,
  getRecipeUsageStats,
  getRecentRecipeUsage,
} from '../memory/repository.js';
import { addToDraft, loadDraft, recipesInDraft, emptyDraft } from './draft.js';

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

const db = openDatabase(':memory:');
const CONV = 'test-chat';

const RISOTTO = { id: 'picnic:r1', name: 'Chorizorisotto', source: 'picnic' };
const CURRY = { id: 'picnic:c1', name: 'Bloemkoolcurry', source: 'picnic' };

// ──────────────────────────────────────────────────────────────────────
// Draft tagging — the hop where the recipe identity used to be lost
// ──────────────────────────────────────────────────────────────────────

addToDraft(db, CONV, 's100', 'Chorizo', 1, { status: 'allowed', note: '' }, RISOTTO);
addToDraft(db, CONV, 's101', 'Risottorijst', 1, { status: 'allowed', note: '' }, RISOTTO);
addToDraft(db, CONV, 's102', 'Bloemkool', 1, { status: 'allowed', note: '' }, CURRY);
// An ad-hoc add, with no recipe behind it.
addToDraft(db, CONV, 's103', 'Melk', 2, { status: 'allowed', note: '' });

const draft = loadDraft(db, CONV);
check('the recipe tag survives a round-trip through SQLite', draft[0]?.recipeId === 'picnic:r1');
check('an ad-hoc add carries no recipe', draft[3]?.recipeId === undefined);
check(
  'distinct recipes are derived from the items',
  recipesInDraft(draft)
    .map((r) => r.id)
    .join(',') === 'picnic:r1,picnic:c1',
  recipesInDraft(draft)
    .map((r) => r.id)
    .join(','),
);
check('an untagged item contributes no recipe', recipesInDraft(draft).length === 2);

// A shared ingredient keeps its first claimant rather than being reassigned,
// so two recipes using onion do not fight over it.
addToDraft(db, CONV, 's100', 'Chorizo', 1, { status: 'allowed', note: '' }, CURRY);
check(
  'a shared ingredient keeps the recipe that claimed it first',
  loadDraft(db, CONV).find((i) => i.articleId === 's100')?.recipeId === 'picnic:r1',
);
check(
  'and the sharing recipe is still counted via its own ingredients',
  recipesInDraft(loadDraft(db, CONV)).some((r) => r.id === 'picnic:c1'),
);

// Striking a recipe out during review must take it off the record entirely —
// a rejected suggestion was never a meal, and must not suppress itself from
// next week.
const withoutCurry = loadDraft(db, CONV).filter((i) => i.articleId !== 's102');
check(
  'removing a recipe’s only remaining item removes the recipe',
  !recipesInDraft(withoutCurry).some((r) => r.id === 'picnic:c1'),
  recipesInDraft(withoutCurry)
    .map((r) => r.id)
    .join(','),
);

// ──────────────────────────────────────────────────────────────────────
// Persistence
// ──────────────────────────────────────────────────────────────────────

const written = recordRecipeUsage(
  db,
  recipesInDraft(loadDraft(db, CONV)).map((r) => ({
    recipeId: r.id,
    recipeName: r.name,
    source: r.source,
  })),
  { suggestionId: 42, usedAt: '2026-08-01T18:00:00Z' },
);
check('committing writes one row per recipe', written === 2, String(written));

const stats = getRecipeUsageStats(db);
check('usage is keyed by qualified recipe id', stats.has('picnic:r1') && stats.has('picnic:c1'));
check('a first use counts once', stats.get('picnic:r1')?.timesUsed === 1);
check('the source is preserved', stats.get('picnic:r1')?.source === 'picnic');

// The same recipe cooked again is a second occasion, not an overwrite: the
// count is what tells a favourite apart from a one-off.
recordRecipeUsage(db, [{ recipeId: RISOTTO.id, recipeName: RISOTTO.name, source: 'picnic' }], {
  usedAt: '2026-08-15T18:00:00Z',
});
const afterSecond = getRecipeUsageStats(db);
check('cooking it again adds an occasion', afterSecond.get('picnic:r1')?.timesUsed === 2);
check(
  'the most recent use wins',
  afterSecond.get('picnic:r1')?.lastUsedAt === '2026-08-15T18:00:00Z',
  afterSecond.get('picnic:r1')?.lastUsedAt,
);

// A double-click on "commit" is one meal, not two.
const duplicate = recordRecipeUsage(
  db,
  [{ recipeId: RISOTTO.id, recipeName: RISOTTO.name, source: 'picnic' }],
  { usedAt: '2026-08-15T18:00:00Z' },
);
check('the same recipe at the same instant is not double-counted', duplicate === 0);
check('and the count is unchanged', getRecipeUsageStats(db).get('picnic:r1')?.timesUsed === 2);

// A renamed recipe reads back under its newest title — Picnic edits these.
recordRecipeUsage(
  db,
  [{ recipeId: RISOTTO.id, recipeName: 'Chorizorisotto met spinazie', source: 'picnic' }],
  { usedAt: '2026-08-20T18:00:00Z' },
);
check(
  'the newest name is the one reported',
  getRecipeUsageStats(db).get('picnic:r1')?.recipeName === 'Chorizorisotto met spinazie',
  getRecipeUsageStats(db).get('picnic:r1')?.recipeName,
);

const recent = getRecentRecipeUsage(db, 10);
check('recent usage is newest first', recent[0]?.usedAt === '2026-08-20T18:00:00Z');
check('recent usage is capped by the limit', getRecentRecipeUsage(db, 2).length === 2);

check('recording nothing is not an error', recordRecipeUsage(db, []) === 0);

// An empty draft is the normal state after a commit, and must not throw.
emptyDraft(db, CONV);
check('an emptied draft yields no recipes', recipesInDraft(loadDraft(db, CONV)).length === 0);

// ──────────────────────────────────────────────────────────────────────

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) FAILED, ${passed} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`All ${passed} rotation checks passed.`);
