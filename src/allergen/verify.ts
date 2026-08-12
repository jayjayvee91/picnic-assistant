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

import { PicnicClient, type ProductDetails } from '../picnic/index.js';
import { PicnicRecipeSource } from '../recipe/index.js';
import { ensureRulebookSeeded, loadRulebook } from './rulebook.js';
import { evaluateGluten, type GlutenVerdict } from './guard.js';

interface Row {
  articleId: string;
  name: string;
  hasAllergens: boolean;
  hasIngredients: boolean;
  allergens: string[];
  /** What the guard actually decides for this product. */
  verdict: GlutenVerdict;
  reason: string;
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

  // Run the real guard, not just a data census. Coverage tells us what Picnic
  // publishes; the verdict tells us what the household will actually see on a
  // shopping list, which is the number that decides whether the warnings stay
  // readable.
  const rulebookPath = process.env['GLUTEN_RULES_FILE'] ?? join(dataDir, 'gluten-rules.md');
  if (await ensureRulebookSeeded(rulebookPath)) {
    console.log(`(seeded a fresh rulebook at ${rulebookPath})\n`);
  }
  const rulebook = await loadRulebook(rulebookPath);

  const rows: Row[] = [];
  for (const articleId of articles.keys()) {
    let details: ProductDetails | null = null;
    try {
      details = await client.getProductDetails(articleId);
    } catch (err) {
      console.error(`  fetch failed for ${articleId}: ${err instanceof Error ? err.message : err}`);
    }
    const allergens = Array.isArray(details?.allergens) ? details.allergens : [];
    const ingredients = (Array.isArray(details?.infoSections) ? details.infoSections : []).find(
      (s) => typeof s?.title === 'string' && /ingredi/i.test(s.title),
    );
    const decision = evaluateGluten({ details, rulebook });
    rows.push({
      articleId,
      name: typeof details?.name === 'string' ? details.name : articleId,
      hasAllergens: allergens.length > 0,
      hasIngredients: Boolean(ingredients?.content),
      allergens,
      verdict: decision.verdict,
      reason: decision.reason,
    });
  }

  const mark = (v: GlutenVerdict): string =>
    v === 'blocked' ? 'GEBLOKKEERD' : v === 'unverified' ? 'ONBEVESTIGD ' : 'ok          ';

  for (const r of rows) {
    const data = [
      r.hasAllergens ? `allergenen: ${r.allergens.join(', ')}` : 'geen allergenen',
      r.hasIngredients ? 'ingrediënten' : 'geen ingrediënten',
    ].join(' | ');
    console.log(`  ${mark(r.verdict)} ${r.name.slice(0, 34).padEnd(36)} ${data}`);
  }

  const total = rows.length;
  const withAllergens = rows.filter((r) => r.hasAllergens).length;
  const withIngredients = rows.filter((r) => r.hasIngredients).length;
  const withNeither = rows.filter((r) => !r.hasAllergens && !r.hasIngredients).length;
  const pct = (n: number): string => `${((n / Math.max(1, total)) * 100).toFixed(0)}%`;

  const blocked = rows.filter((r) => r.verdict === 'blocked');
  const unverified = rows.filter((r) => r.verdict === 'unverified');
  const allowed = rows.filter((r) => r.verdict === 'allowed');

  console.log('');
  console.log('='.repeat(60));
  console.log('WHAT PICNIC PUBLISHES');
  console.log(`  Articles checked:          ${total}`);
  console.log(`  With an allergen list:     ${withAllergens}  (${pct(withAllergens)})`);
  console.log(`  With an ingredient list:   ${withIngredients}  (${pct(withIngredients)})`);
  console.log(`  With NEITHER:              ${withNeither}  (${pct(withNeither)})`);
  console.log('');
  console.log('WHAT THE GUARD DECIDES  (this is what you would see on a list)');
  console.log(`  Allowed:                   ${allowed.length}  (${pct(allowed.length)})`);
  console.log(`  Blocked (gluten):          ${blocked.length}  (${pct(blocked.length)})`);
  console.log(`  Unverified (warnings):     ${unverified.length}  (${pct(unverified.length)})`);
  console.log('='.repeat(60));
  console.log('');

  if (blocked.length > 0) {
    console.log('Blocked:');
    for (const r of blocked) console.log(`  - ${r.name}: ${r.reason}`);
    console.log('');
  }
  if (unverified.length > 0) {
    console.log('Unverified — these are the warnings you would have to read:');
    for (const r of unverified) console.log(`  - ${r.name}: ${r.reason}`);
    console.log('');
  }

  // Warning volume is the thing that decides whether this guard survives
  // contact with a real weekly shop, so judge it explicitly.
  const unvPct = (unverified.length / Math.max(1, total)) * 100;
  if (unvPct > 40) {
    console.log('WARNING VOLUME: too high. At this rate the warnings stop being read,');
    console.log('which is more dangerous than fewer, better-targeted ones. Worth tuning.');
  } else if (unvPct > 20) {
    console.log('WARNING VOLUME: workable but not comfortable. Consider standing');
    console.log('overrides for staples that keep reappearing here.');
  } else {
    console.log('WARNING VOLUME: low enough that each warning still means something.');
  }
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
