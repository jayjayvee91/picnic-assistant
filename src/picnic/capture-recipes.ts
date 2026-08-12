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

  // Ids are grouped by where they came from. A Fusion page is full of
  // 24-hex-looking identifiers that are NOT recipes (analytics entity ids,
  // template variant ids, image ids), so provenance is what separates a real
  // recipe id from a decoy.
  const bySource = collectRecipeIds(page);
  const totalIds = [...bySource.values()].reduce((n, s) => n + s.size, 0);
  say(`Candidate ids found: ${totalIds}, grouped by where they appeared:`);
  for (const [source, set] of [...bySource.entries()].sort((a, b) => b[1].size - a[1].size)) {
    const sample = [...set].slice(0, 5).join(', ');
    say(`  ${source} (${set.size}): ${sample}${set.size > 5 ? ', …' : ''}`);
  }
  say();

  const ids = rankedIds(bySource);

  // ── 3. Recipe detail pages ──────────────────────────────────────────
  const picked = ids.slice(0, wantDetails);
  if (picked.length === 0) {
    say('No recipe ids detected automatically. Open recipes-page.json and pick an id by hand,');
    say('then re-run with:  npm run capture:recipes -- --id=<recipeId>');
  }
  const manualId = process.argv.find((a) => a.startsWith('--id='))?.split('=')[1];
  if (manualId) picked.unshift(manualId);

  let detailsWritten = 0;
  for (const id of unique(picked)) {
    try {
      const detail = await client.getRecipeDetailsPage(id);
      const detailPath = join(outDir, `recipe-detail-${sanitise(id)}.json`);
      await writeFile(detailPath, JSON.stringify(detail, null, 2), { mode: 0o600 });
      say(`Wrote ${detailPath}`);
      detailsWritten++;
    } catch (err) {
      // Print the UNDERLYING cause, not just our wrapper. The wrapper message
      // ("Picnic call ... failed") says nothing about whether this was a 404,
      // a bad id format, or an auth problem.
      say(`  could not fetch detail for ${id}: ${describeError(err)}`);
    }
  }
  if (detailsWritten === 0 && picked.length > 0) {
    say();
    say('No detail page could be fetched. The ids above are probably not recipe ids —');
    say('a Fusion page carries plenty of other 24-hex identifiers. The overview dump');
    say('still contains everything needed to find the right ones.');
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
 * Walk the tree collecting identifier-looking values, TAGGED BY PROVENANCE.
 *
 * The first pass of this script collected everything that looked like an id and
 * fed it straight to the detail endpoint; every call failed, because a Fusion
 * page is full of 24-hex identifiers that are not recipes (analytics entity
 * ids, template variant ids, image ids). Keeping the source of each id is what
 * lets us tell them apart — and lets a failing run still be informative.
 */
function collectRecipeIds(
  value: unknown,
  out: Map<string, Set<string>> = new Map(),
  depth = 0,
): Map<string, Set<string>> {
  if (depth > 40) return out;

  const add = (source: string, id: unknown): void => {
    if (typeof id !== 'string' || id.length === 0) return;
    let set = out.get(source);
    if (!set) {
      set = new Set();
      out.set(source, set);
    }
    set.add(id);
  };

  if (Array.isArray(value)) {
    for (const item of value) collectRecipeIds(item, out, depth + 1);
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  const obj = value as Record<string, unknown>;

  // Explicit recipe-ish keys are the strongest signal.
  for (const key of ['recipe_id', 'recipeId', 'selling_group_id', 'sellingGroupId']) {
    add(`key:${key}`, obj[key]);
  }

  // An `id` on a node whose `type` mentions a recipe. Tag with the type so we
  // can see which component types actually carry recipe ids.
  const type = typeof obj['type'] === 'string' ? obj['type'] : '';
  if (type && typeof obj['id'] === 'string' && /recipe|meal|cookbook|selling/i.test(type)) {
    add(`type:${type}`, obj['id']);
  }

  // Analytics payloads often carry the id of the thing being rendered, which is
  // frequently the real recipe id even when the surrounding node hides it.
  const analytics = obj['analytics'];
  if (analytics && typeof analytics === 'object') {
    const entityIds = (analytics as Record<string, unknown>)['entity_ids'];
    if (Array.isArray(entityIds)) {
      for (const e of entityIds) add('analytics:entity_ids', e);
    }
  }

  // Deep links are the most reliable source of all: the app's own navigation
  // targets. A link like ".../recipe-details?recipe_id=X" names X definitively.
  for (const key of ['link', 'url', 'deeplink', 'target', 'action']) {
    const v = obj[key];
    if (typeof v === 'string' && /recipe/i.test(v)) {
      const m = /recipe[_-]?id=([A-Za-z0-9_-]+)/i.exec(v);
      if (m?.[1]) add('deeplink', m[1]);
    }
  }

  for (const v of Object.values(obj)) collectRecipeIds(v, out, depth + 1);
  return out;
}

/**
 * Order candidate ids by how likely they are to be real recipe ids: explicit
 * keys and deep links first, analytics last.
 */
function rankedIds(bySource: Map<string, Set<string>>): string[] {
  const rank = (source: string): number => {
    if (source.startsWith('key:recipe')) return 0;
    if (source === 'deeplink') return 1;
    if (source.startsWith('key:')) return 2;
    if (source.startsWith('type:')) return 3;
    return 4;
  };
  return unique(
    [...bySource.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).flatMap(([, set]) => [...set]),
  );
}

/** Unwrap our PicnicCallError so the real HTTP failure is visible. */
function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < 4 && current; i++) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' → ');
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
