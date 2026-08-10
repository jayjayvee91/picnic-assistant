/**
 * Offline inspector for a captured Fusion page.
 *
 * Run with:
 *   npm run capture:inspect
 *
 * Why this exists
 * ---------------
 * `capture:recipes` dumps the recipes overview verbatim, and that dump is
 * ~16 MB of nested UI description — far too large to move around or read by
 * hand. Almost all of it is layout noise; the parts that matter for Phase 2
 * are a few hundred bytes: where the saved/"Bewaard" recipes live, what a
 * recipe tile looks like, and which field holds the real recipe id.
 *
 * So rather than shipping the file somewhere to be analysed, this analyses it
 * in place and emits two small artefacts:
 *
 *   - a compact report on stdout (and `inspect-report.txt`), short enough to
 *     paste into a chat
 *   - `favourites-slice.json`, a bounded extract of the interesting subtrees
 *
 * No network, no Picnic session, no credentials. It only reads the file that
 * `capture:recipes` already wrote.
 */

import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Wording that marks the saved/favourite recipes area in the Dutch app. */
const SAVED_HINT = /bewaard|favoriet|opgeslagen/i;

/** How much of a matched subtree to keep in the slice file. */
const SLICE_DEPTH = 6;
const SLICE_ARRAY = 3;
const SLICE_STRING = 300;

interface Found {
  path: string;
  node: unknown;
}

async function main(): Promise<void> {
  const dataDir = process.env['DATA_DIR'] ?? './data';
  const outDir = join(dataDir, 'capture');
  const pagePath = join(outDir, 'recipes-page.json');

  let page: unknown;
  try {
    const raw = await readFile(pagePath, 'utf8');
    console.log(`Read ${pagePath} (${(raw.length / 1024 / 1024).toFixed(1)} MB)`);
    page = JSON.parse(raw);
  } catch (err) {
    console.error(`Could not read ${pagePath}.`);
    console.error('Run `npm run capture:recipes` first.');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const report: string[] = [];
  const say = (line = ''): void => {
    console.log(line);
    report.push(line);
  };

  say();
  say('==================== INSPECTION REPORT ====================');
  say();

  // ── 1. Component vocabulary ─────────────────────────────────────────
  // Which PML component types exist, and how often. Tells us what we are
  // dealing with before looking at anything specific.
  const typeCounts = new Map<string, number>();
  const idPatterns = new Map<string, number>();
  forEachObject(page, (obj) => {
    const t = obj['type'];
    if (typeof t === 'string') typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    const id = obj['id'];
    if (typeof id === 'string' && /[a-z]/i.test(id) && id.length < 60) {
      // Generalise "meal-segment-control-item-Bewaard" → "meal-segment-control-item-*"
      const generalised = id.replace(/[0-9a-f]{24}/gi, '<hex24>').replace(/\d+/g, '<n>');
      idPatterns.set(generalised, (idPatterns.get(generalised) ?? 0) + 1);
    }
  });

  say('--- Component types (top 25) ---');
  for (const [t, n] of topN(typeCounts, 25)) say(`  ${n.toString().padStart(5)}  ${t}`);
  say();

  say('--- Named component ids mentioning recipes/meals/saved (top 30) ---');
  const interestingIds = [...idPatterns.entries()].filter(([id]) =>
    /recipe|meal|cookbook|saved|bewaar|favorit/i.test(id),
  );
  for (const [id, n] of topN(new Map(interestingIds), 30)) {
    say(`  ${n.toString().padStart(5)}  ${id}`);
  }
  if (interestingIds.length === 0) say('  (none)');
  say();

  // ── 2. Where the saved/favourites wording appears ───────────────────
  const savedHits: Found[] = [];
  forEachNodeWithPath(page, (node, path) => {
    if (typeof node === 'string' && SAVED_HINT.test(node) && node.length < 120) {
      savedHits.push({ path, node });
    }
  });

  say('--- Where "Bewaard"/"Favorieten" appears (first 25) ---');
  for (const hit of savedHits.slice(0, 25)) {
    say(`  ${JSON.stringify(hit.node)}`);
    say(`      at ${hit.path}`);
  }
  say(`  (${savedHits.length} total)`);
  say();

  // ── 3. Recipe-id provenance ─────────────────────────────────────────
  // The previous run collected 93 candidate ids and every detail fetch failed,
  // so the question is not "what ids exist" but "which field actually holds a
  // recipe id". Grouping by the containing key answers that.
  const idsByKey = new Map<string, Set<string>>();
  forEachObject(page, (obj) => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== 'string') continue;
      if (!/^[0-9a-f]{24}$/i.test(value)) continue;
      const parentType = typeof obj['type'] === 'string' ? obj['type'] : '?';
      const bucket = `${key}  (on type=${parentType})`;
      let set = idsByKey.get(bucket);
      if (!set) {
        set = new Set();
        idsByKey.set(bucket, set);
      }
      set.add(value);
    }
  });

  say('--- Where 24-hex ids live (key, and the component type carrying it) ---');
  const sorted = [...idsByKey.entries()].sort((a, b) => b[1].size - a[1].size);
  for (const [bucket, set] of sorted.slice(0, 30)) {
    say(`  ${set.size.toString().padStart(4)}  ${bucket}`);
    say(`        e.g. ${[...set].slice(0, 3).join(', ')}`);
  }
  say();

  // ── 4. Anything that looks like a navigation target ─────────────────
  // Deep links name a recipe definitively — this is the most reliable route
  // to a real recipe id.
  const links = new Set<string>();
  forEachNodeWithPath(page, (node) => {
    if (typeof node !== 'string') return;
    if (node.length > 400) return;
    if (/recipe|meal/i.test(node) && /[?&/]/.test(node) && !/\s/.test(node)) links.add(node);
  });
  say('--- Link-ish strings mentioning recipe/meal (first 25) ---');
  for (const l of [...links].slice(0, 25)) say(`  ${l}`);
  if (links.size === 0) say('  (none)');
  say();

  // ── 5. Sample tiles ─────────────────────────────────────────────────
  // A recipe tile should carry an id plus a human-readable name. Printing two
  // real ones shows the exact field layout the parser must read.
  const tiles: Found[] = [];
  forEachNodeWithPath(page, (node, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    const hasId = Object.entries(obj).some(
      ([, v]) => typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v),
    );
    const hasName = ['name', 'title', 'text', 'label'].some((k) => typeof obj[k] === 'string');
    if (hasId && hasName) tiles.push({ path, node });
  });

  say('--- Sample nodes carrying BOTH a 24-hex id and a name (first 3) ---');
  for (const tile of tiles.slice(0, 3)) {
    say(`  at ${tile.path}`);
    say(indent(JSON.stringify(prune(tile.node, 3, 2, 120), null, 2), 4));
    say();
  }
  if (tiles.length === 0) say('  (none found)');
  say(`  (${tiles.length} such nodes in total)`);
  say();

  // ── 6. The recipe catalogue, straight from the app's own deep links ──
  // The tiles hide their names behind PML expression variables, but the
  // navigation targets spell everything out:
  //   …id=<recipeId>&image=<path>&name=<name>&source=SELLING_GROUP_TILE
  // That is a complete id→name mapping without touching the template layer.
  const catalogue = new Map<string, { id: string; name: string; image?: string }>();
  for (const link of links) {
    const id = /[?&,]id=([0-9a-f]{24})/i.exec(link)?.[1];
    if (!id) continue;
    const rawName = /[?&]name=([^&]+)/.exec(link)?.[1];
    const rawImage = /[?&]image=([^&]+)/.exec(link)?.[1];
    if (!rawName) continue;
    catalogue.set(id, {
      id,
      name: safeDecode(rawName),
      ...(rawImage ? { image: safeDecode(rawImage) } : {}),
    });
  }

  say('--- Recipes recovered from deep links (first 20) ---');
  for (const r of [...catalogue.values()].slice(0, 20)) say(`  ${r.id}  ${r.name}`);
  say(`  (${catalogue.size} recipes with names in total)`);
  say();

  // ── 7. Optional: dump one subtree by path ───────────────────────────
  // Pass --path=$.layout.body.… to see a specific node in full. Used to read
  // the "Bewaard" pill's onPress handler, which is what reveals the request
  // the app makes when that tab is tapped.
  const wantPath = process.argv.find((a) => a.startsWith('--path='))?.slice('--path='.length);
  if (wantPath) {
    say(`--- Subtree at ${wantPath} ---`);
    const node = resolvePath(page, wantPath);
    if (node === undefined) {
      say('  (path did not resolve)');
    } else {
      say(indent(JSON.stringify(prune(node, 8, 4, 300), null, 2), 4));
    }
    say();
  }

  say('==================== END REPORT ====================');

  // ── 6. Write the bounded slice for deeper analysis ──────────────────
  const slice = {
    note: 'Bounded extract of a Picnic recipes Fusion page. Arrays and depth are truncated.',
    savedWordingPaths: savedHits.slice(0, 40).map((h) => ({ path: h.path, text: h.node })),
    sampleTiles: tiles.slice(0, 10).map((t) => ({
      path: t.path,
      node: prune(t.node, SLICE_DEPTH, SLICE_ARRAY, SLICE_STRING),
    })),
    links: [...links].slice(0, 60),
    idBuckets: sorted.slice(0, 40).map(([bucket, set]) => ({
      bucket,
      count: set.size,
      samples: [...set].slice(0, 5),
    })),
    typeCounts: Object.fromEntries(topN(typeCounts, 60)),
  };

  const slicePath = join(outDir, 'favourites-slice.json');
  const cataloguePath = join(outDir, 'recipes-catalogue.json');
  await writeFile(slicePath, JSON.stringify(slice, null, 2), { mode: 0o600 });
  await writeFile(cataloguePath, JSON.stringify([...catalogue.values()], null, 2), { mode: 0o600 });
  await writeFile(join(outDir, 'inspect-report.txt'), report.join('\n'), { mode: 0o600 });

  console.log();
  console.log(`Wrote ${slicePath}`);
  console.log(`Wrote ${cataloguePath}  (${catalogue.size} recipes)`);
  console.log(`Wrote ${join(outDir, 'inspect-report.txt')}`);
  console.log();
  console.log('All small. Send the report (or paste it) to continue.');
}

// ──────────────────────────────────────────────────────────────────────
// Traversal helpers
// ──────────────────────────────────────────────────────────────────────

const MAX_DEPTH = 60;

/** Visit every plain object in the tree. */
function forEachObject(
  value: unknown,
  fn: (obj: Record<string, unknown>) => void,
  depth = 0,
): void {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) forEachObject(item, fn, depth + 1);
    return;
  }
  fn(value as Record<string, unknown>);
  for (const v of Object.values(value)) forEachObject(v, fn, depth + 1);
}

/**
 * Visit every node with a dotted path. Paths are what make the report
 * actionable — "this string lives at layout.body.children[3].header" tells us
 * where to point the parser.
 */
function forEachNodeWithPath(
  value: unknown,
  fn: (node: unknown, path: string) => void,
  path = '$',
  depth = 0,
): void {
  if (depth > MAX_DEPTH) return;
  fn(value, path);
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    // Only descend into the first 40 entries of huge arrays; layout lists
    // repeat the same shape and we only need the shape.
    for (let i = 0; i < Math.min(value.length, 40); i++) {
      forEachNodeWithPath(value[i], fn, `${path}[${i}]`, depth + 1);
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    forEachNodeWithPath(v, fn, `${path}.${k}`, depth + 1);
  }
}

/** Depth/width/length-limited copy, so a sample stays readable. */
function prune(value: unknown, depth: number, maxArray: number, maxString: number): unknown {
  if (depth <= 0) return '…';
  if (typeof value === 'string') {
    return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxArray).map((v) => prune(v, depth - 1, maxArray, maxString));
    if (value.length > maxArray) kept.push(`…${value.length - maxArray} more`);
    return kept;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = prune(v, depth - 1, maxArray, maxString);
    }
    return out;
  }
  return value;
}

/** Percent-decode without throwing on malformed input. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolve one of the dotted paths this report prints, e.g.
 * `$.layout.body.child.children[0].id`. Only supports the syntax we emit.
 */
function resolvePath(root: unknown, path: string): unknown {
  const cleaned = path.replace(/^\$\.?/, '');
  if (cleaned.length === 0) return root;
  let current: unknown = root;
  for (const segment of cleaned.split('.')) {
    const match = /^([^[]*)((\[\d+\])*)$/.exec(segment);
    if (!match) return undefined;
    const key = match[1] ?? '';
    if (key.length > 0) {
      if (!current || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    for (const idx of (match[2] ?? '').matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(idx[1])];
    }
  }
  return current;
}

function topN(counts: Map<string, number>, n: number): Array<[string, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

main().catch((err) => {
  console.error('Inspection failed:');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
