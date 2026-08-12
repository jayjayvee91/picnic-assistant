/**
 * Measure how much allergen data Picnic actually gives us.
 *
 * Run with:
 *   npm run verify:allergen
 *   npm run verify:allergen -- --recipes=3
 *
 * Why this exists
 * ---------------
 * A live test produced a draft where 5 of 6 products came back "not verified".
 * A guard that flags almost everything is worse than useless: the household
 * stops reading the warnings, and the one that matters gets lost with the rest.
 *
 * But "no allergen data" has two very different causes, and they need opposite
 * responses:
 *
 *   1. Picnic genuinely publishes nothing for that product — nothing we can do
 *      in code; the answer is per-product overrides and tuning.
 *   2. The upstream product-page parser is failing — very fixable, and it
 *      would mean the guard is far weaker than it looks.
 *
 * Guessing between those would be irresponsible for a safety feature, so this
 * samples real articles from real recipes and reports the split.
 */

import 'dotenv/config';
import { join } from 'node:path';

import { PicnicClient } from '../picnic/index.js';
import { PicnicRecipeSource } from '../recipe/index.js';

interface Row {
  articleId: string;
  name: string;
  hasAllergens: boolean;
  hasIngredients: boolean;
  allergens: string[];
}

async function main(): Promise<void> {
  const dataDir = process.env['DATA_DIR'] ?? './data';
  const recipeCount = Number(
    process.argv.find((a) => a.startsWith('--recipes='))?.split('=')[1] ?? '3',
  );

  const client = new PicnicClient({
    username: requireEnv('PICNIC_USERNAME'),
    password: requireEnv('PICNIC_PASSWORD'),
    countryCode: (process.env['PICNIC_COUNTRY_CODE'] ?? 'NL') as 'NL' | 'DE' | 'FR',
    sessionFile: process.env['PICNIC_SESSION_FILE'] ?? join(dataDir, 'picnic-session.json'),
    dryRun: true,
  });
  if (!(await client.restoreSession())) {
    console.error('No Picnic session on disk. Run `npm run smoke:picnic` first.');
    process.exit(2);
  }

  const source = new PicnicRecipeSource({ picnic: client });
  console.log('Fetching saved recipes…');
  const saved = await source.listRecipes();
  const sample = saved.slice(0, Math.max(1, recipeCount));

  // Collect the articles those recipes actually shop for.
  const articles = new Map<string, string>();
  for (const recipe of sample) {
    const details = await source.getRecipeDetails(recipe.id);
    if (!details) continue;
    for (const ing of details.ingredients) {
      if (ing.articleId && ing.selected) articles.set(ing.articleId, recipe.name);
    }
  }

  console.log(
    `Checking allergen data for ${articles.size} articles from ${sample.length} recipe(s)…\n`,
  );

  const rows: Row[] = [];
  for (const articleId of articles.keys()) {
    try {
      const d = await client.getProductDetails(articleId);
      const allergens = Array.isArray(d.allergens) ? d.allergens : [];
      const ingredients = (Array.isArray(d.infoSections) ? d.infoSections : []).find(
        (s) => typeof s?.title === 'string' && /ingredi/i.test(s.title),
      );
      rows.push({
        articleId,
        name: typeof d.name === 'string' ? d.name : articleId,
        hasAllergens: allergens.length > 0,
        hasIngredients: Boolean(ingredients?.content),
        allergens,
      });
    } catch (err) {
      console.error(`  fetch failed for ${articleId}: ${err instanceof Error ? err.message : err}`);
      rows.push({
        articleId,
        name: articleId,
        hasAllergens: false,
        hasIngredients: false,
        allergens: [],
      });
    }
  }

  for (const r of rows) {
    const marks = [
      r.hasAllergens ? `allergenen: ${r.allergens.join(', ')}` : 'GEEN allergenen',
      r.hasIngredients ? 'ingrediënten aanwezig' : 'GEEN ingrediënten',
    ].join('  |  ');
    console.log(`  ${r.articleId.padEnd(11)} ${r.name.slice(0, 40).padEnd(42)} ${marks}`);
  }

  const total = rows.length;
  const withAllergens = rows.filter((r) => r.hasAllergens).length;
  const withIngredients = rows.filter((r) => r.hasIngredients).length;
  const withNeither = rows.filter((r) => !r.hasAllergens && !r.hasIngredients).length;
  const pct = (n: number): string => `${((n / Math.max(1, total)) * 100).toFixed(0)}%`;

  console.log('');
  console.log('='.repeat(60));
  console.log(`Articles checked:            ${total}`);
  console.log(`With an allergen list:       ${withAllergens}  (${pct(withAllergens)})`);
  console.log(`With an ingredient list:     ${withIngredients}  (${pct(withIngredients)})`);
  console.log(`With NEITHER:                ${withNeither}  (${pct(withNeither)})`);
  console.log('='.repeat(60));
  console.log('');

  // The interpretation is the point of the script, so state it rather than
  // leaving a pile of numbers for someone to squint at.
  if (withAllergens === 0 && withIngredients === 0) {
    console.log('DIAGNOSIS: no product returned ANY allergen or ingredient data.');
    console.log('That points at the upstream product-page parser being broken, not at');
    console.log('Picnic lacking data — a fixable problem, and one that currently makes');
    console.log('the gluten guard far weaker than it appears.');
  } else if (withNeither > total / 2) {
    console.log('DIAGNOSIS: most products carry no allergen or ingredient data at all,');
    console.log('but some do — so the parser works and Picnic simply publishes little.');
    console.log('Code cannot fix this. The realistic levers are per-product overrides');
    console.log('for repeat staples, and grouping the warnings so they stay readable.');
  } else if (withAllergens < total / 2) {
    console.log('DIAGNOSIS: ingredient text is usually present but a declared allergen');
    console.log('list often is not. The rulebook is therefore doing most of the work,');
    console.log('which makes tuning the terms in gluten-rules.md the highest-value fix.');
  } else {
    console.log('DIAGNOSIS: allergen coverage is good. Products still flagged as');
    console.log('unverified are likely rulebook tuning rather than missing data.');
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

main().catch((err) => {
  console.error('Allergen verification failed:');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
