/**
 * Endpoint probe for a single recipe.
 *
 * Run with:
 *   npm run capture:probe -- --id=<recipeId>
 *
 * Why this exists
 * ---------------
 * `getRecipeDetailsPage()` — the library's wrapper around
 * `/pages/recipe-details-page-root?recipe_id=…` — failed for every id we tried,
 * even though the ids are demonstrably real (the overview page's own deep links
 * pair them with recipe names). So either that page id is stale, or recipe
 * details live somewhere else entirely.
 *
 * Separately, the library ships a routes reference listing a plain REST
 * endpoint, `GET /recipes/{recipe_id}`, that no service method wraps. If that
 * one answers, recipe ingredients arrive as ordinary JSON and Phase 2 never
 * has to parse a PML tree for them at all — a much better position than
 * reverse-engineering UI layout.
 *
 * This tries each candidate in turn and reports exactly what came back, so we
 * pick the endpoint based on evidence rather than assumption.
 *
 * Read-only: every probe is a GET.
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

/**
 * Candidate endpoints, best-guess first.
 *
 * These are no longer guesses: the overview page's own deep links enumerate
 * the Fusion page ids that actually exist, and `recipe-details-page-root` (the
 * one the library calls) is not among them. `selling-group-details-page` is —
 * and Picnic calls recipes "selling groups" throughout, so that is the page a
 * recipe tile leads to.
 *
 * `action-bottom-sheet` is kept only for reference: it answers, but its body
 * is a SUSPENSE placeholder that defers to `action-bottom-sheet-content`, so
 * the sheet itself carries no recipe data.
 */
function candidates(id: string): Array<{ label: string; path: string }> {
  const enc = encodeURIComponent(id);
  return [
    {
      label: 'selling-group-details-page (id)',
      path: `/pages/selling-group-details-page?id=${enc}`,
    },
    {
      label: 'selling-group-details-page (selling_group_id)',
      path: `/pages/selling-group-details-page?selling_group_id=${enc}`,
    },
    {
      label: 'selling-group-details-page (recipe_id)',
      path: `/pages/selling-group-details-page?recipe_id=${enc}`,
    },
    // The deferred content the bottom sheet actually loads.
    {
      label: 'action-bottom-sheet-content',
      path: `/pages/action-bottom-sheet-content?id=${enc}`,
    },
    // Saved-recipes surfaces discovered in the page-id vocabulary. No id needed.
    { label: 'my-recipes-page-root', path: `/pages/my-recipes-page-root` },
    { label: 'saved-deep-dive-page', path: `/pages/saved-deep-dive-page` },
  ];
}

async function main(): Promise<void> {
  const username = requireEnv('PICNIC_USERNAME');
  const password = requireEnv('PICNIC_PASSWORD');
  const dataDir = process.env['DATA_DIR'] ?? './data';
  const sessionFile = process.env['PICNIC_SESSION_FILE'] ?? join(dataDir, 'picnic-session.json');
  const outDir = join(dataDir, 'capture');

  const id = process.argv.find((a) => a.startsWith('--id='))?.split('=')[1];
  // `--page=` probes one arbitrary page id, for following a lead without
  // editing the candidate list.
  const singlePage = process.argv.find((a) => a.startsWith('--page='))?.slice('--page='.length);
  if (!id && !singlePage) {
    console.error('Usage: npm run capture:probe -- --id=<recipeId>');
    console.error('   or: npm run capture:probe -- --page=<pageId> [--id=<recipeId>]');
    console.error('Pick an id from data/capture/recipes-catalogue.json.');
    process.exit(1);
  }

  const client = new PicnicClient({
    username,
    password,
    countryCode: (process.env['PICNIC_COUNTRY_CODE'] ?? 'NL') as 'NL' | 'DE' | 'FR',
    sessionFile,
    dryRun: true,
  });

  if (!(await client.restoreSession())) {
    console.error('No Picnic session on disk. Run `npm run smoke:picnic` first.');
    process.exit(2);
  }

  await mkdir(outDir, { recursive: true });
  const report: string[] = [];
  const say = (line = ''): void => {
    console.log(line);
    report.push(line);
  };

  const toProbe = singlePage
    ? [
        {
          label: singlePage,
          path: `/pages/${singlePage}${id ? `?id=${encodeURIComponent(id)}` : ''}`,
        },
      ]
    : candidates(id ?? '');

  say(id ? `Probing recipe id: ${id}` : `Probing page: ${singlePage ?? ''}`);
  say();

  for (const { label, path } of toProbe) {
    say(`--- ${label} ---`);
    say(`    GET ${path}`);
    try {
      const result = await client.rawGet<unknown>(path);
      const json = JSON.stringify(result, null, 2);
      const file = join(outDir, `probe-${slug(label)}.json`);
      await writeFile(file, json, { mode: 0o600 });
      say(`    OK — ${(json.length / 1024).toFixed(1)} KB, wrote ${file}`);
      say(`    top-level keys: ${describeKeys(result)}`);
      const ingredientish = findIngredientHints(result);
      say(
        ingredientish.length > 0
          ? `    looks like it contains ingredients: ${ingredientish.slice(0, 6).join(', ')}`
          : '    no obvious ingredient fields at a glance',
      );
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        say('    AUTH FAILED — session expired. Re-run `npm run smoke:picnic`.');
        break;
      }
      say(`    failed: ${describeError(err)}`);
    }
    say();
  }

  await writeFile(join(outDir, 'probe-report.txt'), report.join('\n'), { mode: 0o600 });
  say(`Wrote ${join(outDir, 'probe-report.txt')}`);
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function describeKeys(value: unknown): string {
  if (Array.isArray(value)) return `(array of ${value.length})`;
  if (value && typeof value === 'object') return Object.keys(value).join(', ') || '(empty object)';
  return `(${typeof value})`;
}

/** Field names that would mean we found the ingredient list. */
const INGREDIENT_KEYS = /ingredient|ingredienten|portions|servings|steps|instructions|nutrition/i;

function findIngredientHints(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20 || out.length > 30 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) findIngredientHints(item, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (INGREDIENT_KEYS.test(k) && !out.includes(k)) out.push(k);
    findIngredientHints(v, out, depth + 1);
  }
  return out;
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

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

main().catch((err) => {
  console.error('Probe failed:');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
