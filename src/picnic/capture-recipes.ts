/**
 * One-off capture script for Phase 2 (Picnic recipes as a menu source).
 *
 * Run with:
 *   npm run capture:recipes
 *
 * Why this exists
 * ---------------
 * Picnic returns the recipes overview and each recipe's detail page as "Fusion"
 * pages: a deeply nested PML (Picnic Markup Language) component tree describing
 * a UI, not a clean recipe JSON document. Your saved/favourite recipes are one
 * section somewhere inside that tree. There is no documented schema, and the
 * shape differs between accounts and app versions — so a parser written against
 * a guess would be unreliable in exactly the way that matters.
 *
 * This script dumps the real responses so the parser can be built against real
 * data, and prints a structural summary to speed that up.
 *
 * What it writes (all under DATA_DIR/capture/, which is gitignored):
 *   recipes-page.json          the overview page, verbatim
 *   recipe-detail-<id>.json    up to `--details=N` recipe detail pages
 *   summary.txt                the same structural summary printed to stdout
 *
 * PRIVACY: these files describe YOUR account's recipe page and may include
 * personal details. They are gitignored, but skim them before sharing — the
 * script prints a warning listing anything that looks like a name, address or
 * token so you know what to look at.
 *
 * Read-only: no writes to your cart or account.
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PicnicClient } from './client.js';
import { AuthRequiredError } from './errors.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function argValue(flag: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function main(): Promise<void> {
  const username = requireEnv('PICNIC_USERNAME');
  const password = requireEnv('PICNIC_PASSWORD');
  const dataDir = process.env['DATA_DIR'] ?? './data';
  const sessionFile = process.env['PICNIC_SESSION_FILE'] ?? join(dataDir, 'picnic-session.json');
  const outDir = join(dataDir, 'capture');
  const wantDetails = argValue('details', 3);

  const client = new PicnicClient({
    username,
    password,
    countryCode: (process.env['PICNIC_COUNTRY_CODE'] ?? 'NL') as 'NL' | 'DE' | 'FR',
    sessionFile,
    dryRun: true, // read-only capture; belt and braces
  });

  if (!(await client.restoreSession())) {
    console.error('No Picnic session on disk. Run `npm run smoke:picnic` first to authenticate.');
    process.exit(2);
  }

  await mkdir(outDir, { recursive: true });
  const report: string[] = [];
  const say = (line = ''): void => {
    console.log(line);
    report.push(line);
  };

  // ── 1. The overview page ────────────────────────────────────────────
  let page: unknown;
  try {
    page = await client.getRecipesPage();
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      console.error('Session expired. Delete the session file and re-run `npm run smoke:picnic`.');
      process.exit(2);
    }
    throw err;
  }

  const overviewPath = join(outDir, 'recipes-page.json');
  await writeFile(overviewPath, JSON.stringify(page, null, 2), { mode: 0o600 });
  say(`Wrote ${overviewPath}`);
  say();

  // ── 2. Structural summary ───────────────────────────────────────────
  say('=== Structure ===');
  say(`Top-level keys: ${Object.keys(page as object).join(', ')}`);
  say();

  const texts = collectStrings(page);
  const savedHints = texts.filter((t) => SAVED_SECTION_HINT.test(t));
  say('Section-ish texts that may name your saved/favourite recipes:');
  if (savedHints.length === 0) {
    say('  (none matched the usual Dutch wording — the full dump will still show it)');
  }
  for (const hint of unique(savedHints).slice(0, 20)) say(`  - ${hint}`);
  say();

  const ids = collectRecipeIds(page);
  say(`Candidate recipe ids found: ${ids.length}`);
  for (const id of ids.slice(0, 15)) say(`  - ${id}`);
  say();

  // ── 3. Recipe detail pages ──────────────────────────────────────────
  const picked = ids.slice(0, wantDetails);
  if (picked.length === 0) {
    say('No recipe ids detected automatically. Open recipes-page.json and pick an id by hand,');
    say('then re-run with:  npm run capture:recipes -- --id=<recipeId>');
  }
  const manualId = process.argv.find((a) => a.startsWith('--id='))?.split('=')[1];
  if (manualId) picked.unshift(manualId);

  for (const id of unique(picked)) {
    try {
      const detail = await client.getRecipeDetailsPage(id);
      const detailPath = join(outDir, `recipe-detail-${sanitise(id)}.json`);
      await writeFile(detailPath, JSON.stringify(detail, null, 2), { mode: 0o600 });
      say(`Wrote ${detailPath}`);
    } catch (err) {
      say(
        `  could not fetch detail for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  say();

  // ── 4. Privacy skim ─────────────────────────────────────────────────
  const sensitive = unique(texts.filter((t) => SENSITIVE_HINT.test(t))).slice(0, 15);
  say('=== Privacy check ===');
  if (sensitive.length === 0) {
    say('Nothing obviously personal spotted, but skim the files before sharing.');
  } else {
    say('These strings look personal — check them before sharing the dump:');
    for (const s of sensitive) say(`  - ${truncate(s, 100)}`);
  }
  say();
  say(`All files are under ${outDir} (gitignored).`);

  await writeFile(join(outDir, 'summary.txt'), report.join('\n'), { mode: 0o600 });
}

// ──────────────────────────────────────────────────────────────────────
// Helpers — deliberately shape-agnostic, since the schema is what we are
// trying to discover.
// ──────────────────────────────────────────────────────────────────────

/** Dutch wording Picnic plausibly uses for a saved-recipes section. */
const SAVED_SECTION_HINT = /bewaard|opgeslagen|favoriet|mijn recept|jouw recept|bewaren/i;

/** Very rough personal-data sniff for the pre-share skim. */
const SENSITIVE_HINT = /\b\d{4}\s?[A-Z]{2}\b|@|\bstraat\b|\btelefoon\b|token|bearer/i;

function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 40 || out.length > 20000) return out;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.length > 1 && t.length < 200) out.push(t);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
  }
  return out;
}

/**
 * Walk the tree for things that look like recipe identifiers. We cast a wide
 * net on purpose: any `recipe_id`/`recipeId` field, plus `id` fields on nodes
 * whose sibling `type` mentions a recipe or selling group.
 */
function collectRecipeIds(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 40) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectRecipeIds(item, out, depth + 1);
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  const obj = value as Record<string, unknown>;
  for (const key of ['recipe_id', 'recipeId', 'selling_group_id', 'sellingGroupId']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  const type = typeof obj['type'] === 'string' ? (obj['type'] as string) : '';
  if (/recipe|meal|cookbook|selling_group/i.test(type) && typeof obj['id'] === 'string') {
    out.push(obj['id'] as string);
  }

  for (const v of Object.values(obj)) collectRecipeIds(v, out, depth + 1);
  return unique(out);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function sanitise(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

main().catch((err) => {
  console.error('Recipe capture failed:');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
