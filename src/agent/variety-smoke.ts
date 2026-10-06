/**
 * Checks for the menu-variety rule.
 *
 * Run with:
 *   npm run smoke:variety
 *
 * No network, no session, no API key: an in-memory database and hand-written
 * menus. The menus mirror the real case that prompted the rule — three
 * spinach dishes in one five-recipe order, one of which never says "spinazie"
 * in its name.
 */

import {
  openDatabase,
  getRecipeStars,
  listStarVocabulary,
  upsertRecipeStars,
} from '../memory/index.js';
import { addToDraft } from './draft.js';
import { draftVarietyWarning } from './tools.js';
import { findStarClashes, type MenuRecipe } from './variety.js';

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

const recipe = (id: string, name: string, stars: string[]): MenuRecipe => ({
  recipeId: id,
  name,
  stars,
});

// ── Counting ─────────────────────────────────────────────────────────

const spinachWeek = [
  recipe('a', 'Gnocchi met merguez en spinazie', ['spinazie', 'gnocchi', 'merguez']),
  recipe('b', 'Romige casarecce-pasta', ['Spinazie ', 'pasta']),
  recipe('c', 'Shakshuka', ['ei', 'spinazie']),
  recipe('d', 'Frisse venkelstamppot met zalm', ['zalm', 'venkel']),
  recipe('e', 'Sticky honing-sesamkip', ['kip', 'noedels']),
];
const clashes = findStarClashes(spinachWeek);
check('three spinach dishes is a clash', clashes.length === 1 && clashes[0]?.star === 'spinazie');
check('the clash names all three recipes', clashes[0]?.recipes.length === 3);

check('twice is allowed', findStarClashes(spinachWeek.slice(1)).length === 0);
check(
  'case, spacing and accents do not split a star',
  findStarClashes([
    recipe('a', 'A', ['crème fraîche']),
    recipe('b', 'B', ['Creme  Fraiche']),
    recipe('c', 'C', ['creme fraiche']),
  ]).length === 1,
);
check(
  'a star listed twice in one recipe counts once',
  findStarClashes([recipe('a', 'A', ['kip', 'kip']), recipe('b', 'B', ['kip'])]).length === 0,
);
check('a different limit is honoured', findStarClashes(spinachWeek, 3).length === 0);

// ── Storage: the household's correction wins ─────────────────────────

const db = openDatabase(':memory:');
upsertRecipeStars(db, { recipeId: 'picnic:a', recipeName: 'A', stars: ['feta'], setBy: 'agent' });
check(
  'agent may refine its own judgement',
  upsertRecipeStars(db, { recipeId: 'picnic:a', recipeName: null, stars: ['kip'], setBy: 'agent' }),
);
check(
  'name survives an update without one',
  getRecipeStars(db, ['picnic:a']).get('picnic:a')?.recipeName === 'A',
);
upsertRecipeStars(db, {
  recipeId: 'picnic:a',
  recipeName: 'A',
  stars: ['couscous'],
  setBy: 'household',
});
check(
  'agent cannot overwrite a household correction',
  !upsertRecipeStars(db, { recipeId: 'picnic:a', recipeName: 'A', stars: ['kip'], setBy: 'agent' }),
);
check(
  'the household version is what is stored',
  getRecipeStars(db, ['picnic:a']).get('picnic:a')?.stars[0] === 'couscous',
);
check('unjudged recipes are absent', !getRecipeStars(db, ['picnic:zzz']).has('picnic:zzz'));

upsertRecipeStars(db, {
  recipeId: 'picnic:b',
  recipeName: 'B',
  stars: ['spinazie'],
  setBy: 'agent',
});
upsertRecipeStars(db, {
  recipeId: 'picnic:c',
  recipeName: 'C',
  stars: ['spinazie', 'ei'],
  setBy: 'agent',
});
check('vocabulary lists the most used star first', listStarVocabulary(db)[0] === 'spinazie');

// ── Safety net: re-count what is actually in the draft ───────────────

const CONV = 'test-chat';
const ok = { status: 'allowed' as const, note: '' };
const ref = (id: string, name: string) => ({ id, name, source: 'picnic' });

addToDraft(db, CONV, 's1', 'Spinazie', 1, ok, ref('picnic:b', 'B'));
check('a single recipe never warns', Object.keys(draftVarietyWarning(db, CONV)).length === 0);

addToDraft(db, CONV, 's2', 'Eieren', 1, ok, ref('picnic:c', 'C'));
check(
  'two spinach recipes do not warn',
  draftVarietyWarning(db, CONV)['varietyClashes'] === undefined,
);

upsertRecipeStars(db, {
  recipeId: 'picnic:d',
  recipeName: 'D',
  stars: ['spinazie'],
  setBy: 'agent',
});
addToDraft(db, CONV, 's3', 'Babyspinazie', 1, ok, ref('picnic:d', 'D'));
const warning = draftVarietyWarning(db, CONV);
check(
  'a third spinach recipe in the draft warns',
  Array.isArray(warning['varietyClashes']) && (warning['varietyClashes'] as unknown[]).length === 1,
);

addToDraft(db, CONV, 's4', 'Rijst', 1, ok, ref('picnic:never-judged', 'E'));
check(
  'an unjudged recipe in the draft is reported as unchecked',
  JSON.stringify(draftVarietyWarning(db, CONV)['varietyUnchecked']) === '["E"]',
);

// ─────────────────────────────────────────────────────────────────────

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) FAILED, ${passed} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`All ${passed} variety checks passed.`);
