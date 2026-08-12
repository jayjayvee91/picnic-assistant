/**
 * End-to-end verification of the recipe parsers against REAL data.
 *
 * Run with:
 *   npm run verify:recipe            # against already-captured files (no network)
 *   npm run verify:recipe -- --live  # fetch fresh from Picnic
 *
 * Why this is separate from `smoke:recipe`
 * ----------------------------------------
 * The smoke test proves the parsers behave correctly on fixtures I wrote. That
 * is necessary but not sufficient: fixtures encode my *understanding* of the
 * shapes, so a misunderstanding would be faithfully reproduced in both the
 * parser and its test, and they would agree with each other while both being
 * wrong. Only real payloads can catch that.
 *
 * It also prints every saved recipe by name, so the household can compare the
 * list against what the Picnic app shows — the one check no amount of code can
 * perform, and the check that caught an earlier version reporting 12 saved
 * recipes when there were really 96.
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PicnicClient } from '../picnic/index.js';
import { parseRecipeDetails, parseRecipeList } from './fusion-parse.js';
import type { RecipeDetails, RecipeSummary } from './types.js';

const SAVED_CAPTURE = 'probe-saved-deep-dive-page-content.json';
const DETAILS_CAPTURE = 'probe-selling-group-details-page-selling-group-id.json';

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const dataDir = process.env['DATA_DIR'] ?? './data';
  const outDir = join(dataDir, 'capture');
  const detailLimit = Number(
    process.argv.find((a) => a.startsWith('--details='))?.split('=')[1] ?? '3',
  );

  let saved: RecipeSummary[];
  let details: RecipeDetails | null;
  let problems = 0;

  if (live) {
    console.log('Mode: LIVE (fetching from Picnic)\n');
    const client = await connect(dataDir);

    console.log('Fetching saved recipes…');
    const savedPage = await client.getSavedRecipesPage();
    saved = parseRecipeList(savedPage, { saved: true });

    if (saved.length === 0) {
      console.error('No saved recipes parsed — nothing to check details against.');
      process.exit(1);
    }

    // Sample several recipes rather than one: a parser that works on the first
    // recipe but not the fourth is the failure mode fixtures cannot catch.
    // Each detail page is ~3 MB, so keep the sample small by default.
    const sample = saved.slice(0, Math.max(1, detailLimit));
    console.log(`Fetching details for ${sample.length} recipe(s) (~3 MB each)…\n`);
    details = null;

    for (const recipe of sample) {
      const d = parseRecipeDetails(await client.getRecipeDetailsPage(recipe.id), recipe.id);
      if (!d) {
        console.error(`  PARSE FAILED for "${recipe.name}" (${recipe.id})`);
        problems++;
        continue;
      }
      // Keep the first successful parse for the detailed printout below.
      details ??= d;

      const missing = d.ingredients.filter((i) => i.articleId === null).length;
      const selected = d.ingredients.filter((i) => i.selected).length;
      console.log(
        `  ok  ${recipe.name} — ${d.ingredients.length} ingredients ` +
          `(${selected} pre-selected), ${d.portions ?? '?'} portions` +
          `${missing > 0 ? `, ${missing} WITHOUT an article id` : ''}`,
      );
      if (missing > 0) problems++;
      if (selected === 0) {
        console.error(`      no ingredient pre-selected — the selection signal may have moved`);
        problems++;
      }
    }
    console.log('');
  } else {
    console.log('Mode: CAPTURED FILES (no network)\n');
    saved = parseRecipeList(await readJson(join(outDir, SAVED_CAPTURE)), { saved: true });
    details = parseRecipeDetails(await readJson(join(outDir, DETAILS_CAPTURE)), '(from capture)');
  }

  // ── 1. The saved list ───────────────────────────────────────────────
  console.log('='.repeat(60));
  console.log(`SAVED RECIPES: ${saved.length}`);
  console.log('='.repeat(60));
  console.log('Compare this against "Bewaard" in the Picnic app.\n');
  saved.forEach((r, i) => {
    console.log(`${(i + 1).toString().padStart(3)}. ${r.name}`);
  });
  console.log('');

  const unnamed = saved.filter((r) => !r.name || r.name.length === 0);
  if (unnamed.length > 0) {
    console.error(`WARNING: ${unnamed.length} recipe(s) parsed without a name.`);
    problems++;
  }
  const duplicates = saved.length - new Set(saved.map((r) => r.id)).size;
  if (duplicates > 0) {
    console.error(`WARNING: ${duplicates} duplicate id(s) survived deduplication.`);
    problems++;
  }

  // ── 2. Ingredient parsing ───────────────────────────────────────────
  console.log('='.repeat(60));
  console.log('INGREDIENTS (one recipe, in full)');
  console.log('='.repeat(60));
  if (!details) {
    console.error('Could not parse the recipe detail page at all.');
    problems++;
  } else {
    console.log(`Recipe:   ${details.name ?? '(no name parsed)'}`);
    console.log(`Portions: ${details.portions ?? '(none parsed)'}`);
    console.log(`Ingredients: ${details.ingredients.length}\n`);
    for (const ing of details.ingredients) {
      const flags = [
        ing.selected ? 'SELECTED' : 'optional extra',
        ing.core ? 'core' : '',
        ing.available ? '' : 'UNAVAILABLE',
        ing.articleId ? '' : 'NO ARTICLE ID',
      ]
        .filter(Boolean)
        .join(', ');
      const price = ing.priceCents === null ? '—' : `€${(ing.priceCents / 100).toFixed(2)}`;
      console.log(
        `  ${(ing.articleId ?? '(none)').padEnd(12)} ×${ing.requiredAmount}  ${price.padStart(7)}  [${flags}]`,
      );
    }
    console.log('');

    // The selected/optional split is what keeps a shopping list honest: Picnic
    // offers pantry staples alongside the real ingredients, and buying all of
    // them multiplies the cost of a week's menu several times over.
    const sum = (list: typeof details.ingredients): number =>
      list.reduce((n, i) => n + (i.priceCents ?? 0) * i.requiredAmount, 0);
    const selected = details.ingredients.filter((i) => i.selected);
    const optional = details.ingredients.filter((i) => !i.selected);
    const eur = (cents: number): string => `€${(cents / 100).toFixed(2)}`;

    console.log(`  Pre-selected by Picnic: ${selected.length} items, ${eur(sum(selected))}`);
    console.log(`  Offered extras:         ${optional.length} items, ${eur(sum(optional))}`);
    console.log(
      `  Everything:             ${details.ingredients.length} items, ${eur(sum(details.ingredients))}`,
    );
    console.log('');
    console.log('  A shopping list should use the pre-selected set. The extras are');
    console.log('  pantry staples (oil, cheese, stock) the household likely already has.');
    console.log('');

    if (selected.length === 0) {
      console.error('WARNING: no ingredient is marked as pre-selected — the selection');
      console.error('signal may have moved, which would make shopping lists wrong.');
      problems++;
    }

    // The whole design rests on ingredients resolving to real article ids —
    // that is what lets the gluten guard and brand rules act exactly rather
    // than by fuzzy name match. Missing ids are a genuine defect, not a
    // cosmetic gap.
    const missing = details.ingredients.filter((i) => i.articleId === null);
    if (missing.length > 0) {
      console.error(
        `WARNING: ${missing.length} of ${details.ingredients.length} ingredients have no ` +
          'article id. Those cannot be gluten-checked or price-matched directly.',
      );
      problems++;
    } else {
      console.log('All ingredients resolved to Picnic article ids.');
    }
  }

  console.log('');
  if (problems > 0) {
    console.error(`${problems} problem(s) found. See warnings above.`);
    process.exit(1);
  }
  console.log('Verification passed. Check the recipe names above against the app.');
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${path}`);
    console.error('Run the capture first, or pass --live to fetch from Picnic.');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function connect(dataDir: string): Promise<PicnicClient> {
  const username = process.env['PICNIC_USERNAME'];
  const password = process.env['PICNIC_PASSWORD'];
  if (!username || !password) {
    console.error('Missing PICNIC_USERNAME / PICNIC_PASSWORD for --live.');
    process.exit(1);
  }
  const client = new PicnicClient({
    username,
    password,
    countryCode: (process.env['PICNIC_COUNTRY_CODE'] ?? 'NL') as 'NL' | 'DE' | 'FR',
    sessionFile: process.env['PICNIC_SESSION_FILE'] ?? join(dataDir, 'picnic-session.json'),
    dryRun: true,
  });
  if (!(await client.restoreSession())) {
    console.error('No Picnic session on disk. Run `npm run smoke:picnic` first.');
    process.exit(2);
  }
  return client;
}

main().catch((err) => {
  console.error('Verification failed:');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
