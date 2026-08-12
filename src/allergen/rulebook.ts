/**
 * The gluten rulebook — a human-editable Markdown file at
 * `DATA_DIR/gluten-rules.md`.
 *
 * Why a file (and not constants in this module)
 * ---------------------------------------------
 * The whole point of this design is that the gluten decision must NOT be a
 * black box. Every term that can cause a product to be blocked lives in a file
 * you can open, read, and edit — same posture as `profile.md`. If the guard
 * blocks your pasta, you can see exactly which line did it, and change it.
 *
 * Sections (all optional; unknown headings are ignored)
 * -----------------------------------------------------
 * `## Bevat gluten`  → terms that mean gluten. A match BLOCKS the product.
 * `## Twijfel`       → ambiguous terms. A match marks the product UNVERIFIED
 *                      (added, but flagged for you to check) — never silently
 *                      allowed.
 * `## Veilig`        → terms that are explicitly fine. These exist to stop a
 *                      broader term from false-matching: e.g. "glutenvrije
 *                      haver" should not trip a "haver" rule. A safe term that
 *                      *contains* a blocking term wins for that span of text.
 * `## Voorbeelden`   → free-text notes for humans. Never parsed into rules;
 *                      purely a place to record reasoning ("mout komt van
 *                      gerst") so the file explains itself.
 *
 * Editing
 * -------
 * Edit by hand over SSH, or let the assistant propose a line via
 * `propose_gluten_rule` → you approve → `commit_gluten_rule` appends it. Same
 * approve-before-write discipline as the household profile: the bot never
 * silently changes what is considered gluten.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/** Rule sections that produce actual matching behaviour. */
export type RuleSection = 'Bevat gluten' | 'Twijfel' | 'Veilig';

const RULE_SECTIONS: RuleSection[] = ['Bevat gluten', 'Twijfel', 'Veilig'];

/** Free-text section for human notes — parsed out, never matched against. */
const NOTES_SECTION = 'Voorbeelden';

export interface GlutenRulebook {
  /** Terms whose presence means gluten. Lower-cased, normalised. */
  contains: string[];
  /** Ambiguous terms — presence means "cannot confirm", not "unsafe". */
  doubtful: string[];
  /** Terms explicitly safe; used to suppress false positives. */
  safe: string[];
  /** Human notes from `## Voorbeelden`. Never used for matching. */
  notes: string[];
}

/** An empty rulebook. Matching against it yields no hits (never a block). */
export const EMPTY_RULEBOOK: GlutenRulebook = { contains: [], doubtful: [], safe: [], notes: [] };

// ──────────────────────────────────────────────────────────────────────
// Loading
// ──────────────────────────────────────────────────────────────────────

/**
 * Read and parse the rulebook fresh from disk. Like `loadProfile`, this always
 * re-reads so hand edits take effect on the very next check — no restart.
 *
 * Throws if the file is missing; call `ensureRulebookSeeded` at boot.
 */
export async function loadRulebook(rulebookPath: string): Promise<GlutenRulebook> {
  const markdown = await fs.readFile(rulebookPath, 'utf8');
  return parseRulebook(markdown);
}

/**
 * Create `gluten-rules.md` from the seed template if it does not exist.
 * Idempotent. Returns true if the file was created.
 */
export async function ensureRulebookSeeded(rulebookPath: string): Promise<boolean> {
  try {
    await fs.access(rulebookPath);
    return false;
  } catch {
    await fs.mkdir(dirname(rulebookPath), { recursive: true });
    await atomicWrite(rulebookPath, RULEBOOK_TEMPLATE);
    return true;
  }
}

/**
 * Append a term to a rule section and save atomically. Mirrors
 * `appendToProfileSection` — including creating the section if it is absent.
 *
 * `term` is the bare term ("moutextract"), not a bullet. Callers should have
 * user approval before invoking this.
 */
export async function appendRule(
  rulebookPath: string,
  section: RuleSection,
  term: string,
  note?: string,
): Promise<void> {
  const cleanTerm = term.replace(/\s+/g, ' ').trim();
  if (cleanTerm.length === 0) {
    throw new Error('Refusing to append an empty rule to the gluten rulebook.');
  }
  const cleanNote = note?.replace(/\s+/g, ' ').trim();
  const bullet = cleanNote ? `${cleanTerm} — ${cleanNote}` : cleanTerm;

  const current = await fs.readFile(rulebookPath, 'utf8');
  await atomicWrite(rulebookPath, insertBullet(current, section, bullet));
}

// ──────────────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────────────

/**
 * Pure parser: Markdown → rulebook. Exported so the smoke test can exercise
 * it without touching the filesystem.
 *
 * A rule line is a bullet (`- …`). Everything after an em-dash, en-dash or
 * `#` on the line is treated as a human comment and stripped, so you can
 * annotate rules inline:
 *
 *     - moutextract — komt van gerst
 *
 * yields the term `moutextract`. Placeholder bullets wrapped in parentheses
 * (as used in the seed template) are ignored.
 */
export function parseRulebook(markdown: string): GlutenRulebook {
  const contains: string[] = [];
  const doubtful: string[] = [];
  const safe: string[] = [];
  const notes: string[] = [];

  let current: RuleSection | typeof NOTES_SECTION | null = null;

  // Strip HTML comment blocks BEFORE parsing. Without this, a commented-out
  // bullet is still read as a live rule — which would silently reinstate terms
  // the household deliberately disabled, and a gluten rulebook that quietly
  // does the opposite of what the file says is worse than no comments at all.
  const withoutComments = markdown.replace(/<!--[\s\S]*?-->/g, '');

  for (const rawLine of withoutComments.split('\n')) {
    const line = rawLine.trim();

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const title = (heading[1] ?? '').trim();
      const matched = RULE_SECTIONS.find((s) => s.toLowerCase() === title.toLowerCase());
      if (matched) {
        current = matched;
      } else if (title.toLowerCase() === NOTES_SECTION.toLowerCase()) {
        current = NOTES_SECTION;
      } else {
        current = null;
      }
      continue;
    }

    if (current === null) continue;
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const body = (bullet[1] ?? '').trim();
    if (body.length === 0) continue;

    if (current === NOTES_SECTION) {
      notes.push(body);
      continue;
    }

    const term = stripInlineComment(body);
    // Skip seed placeholders like "(nog niets toegevoegd)".
    if (term.length === 0 || term.startsWith('(')) continue;

    const normalised = normaliseText(term);
    if (normalised.length === 0) continue;

    if (current === 'Bevat gluten') contains.push(normalised);
    else if (current === 'Twijfel') doubtful.push(normalised);
    else safe.push(normalised);
  }

  return {
    contains: dedupe(contains),
    doubtful: dedupe(doubtful),
    safe: dedupe(safe),
    notes,
  };
}

/** Drop an inline human comment: everything from ` — `, ` - `, ` – ` or `#`. */
function stripInlineComment(body: string): string {
  return (
    body
      .split(/\s+[—–]\s+|\s+-\s+|#/)[0]
      ?.trim()
      .replace(/^["'`]|["'`]$/g, '')
      .trim() ?? ''
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// ──────────────────────────────────────────────────────────────────────
// Matching
// ──────────────────────────────────────────────────────────────────────

/**
 * Normalise text for comparison: lower-case, strip diacritics, collapse
 * whitespace and punctuation to single spaces.
 *
 * Diacritic stripping matters because Picnic's ingredient text is inconsistent
 * about them, and a rule for "mais" should match "maïs".
 */
export function normaliseText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface RuleMatch {
  /** The rulebook term that matched, as normalised. */
  term: string;
  /** Which section it came from. */
  section: RuleSection;
}

/**
 * Find rulebook terms present in `text`.
 *
 * Matching is on whole words (after normalisation), so a rule for "spelt"
 * does not fire on "speltarwevrij"… but also so that "tarwe" DOES fire on
 * "tarwebloem" is NOT true — multi-word and compound Dutch ingredient names
 * are common, so we deliberately match on word *prefixes* for the blocking
 * list: "tarwe" matches "tarwebloem" and "tarwezetmeel". That is the safe
 * direction for a blocking rule (over-match rather than under-match), and the
 * `Veilig` list is how you carve out the exceptions.
 *
 * Safe terms are applied by removing their spans from the text BEFORE looking
 * for blocking/doubtful terms, so "glutenvrije haver" can neutralise a "haver"
 * rule without disabling it globally.
 */
export function matchRules(text: string, rulebook: GlutenRulebook): RuleMatch[] {
  const normalised = normaliseText(text);
  if (normalised.length === 0) return [];

  // Blank out safe spans first so they cannot trigger a broader rule.
  let searchable = normalised;
  for (const safeTerm of rulebook.safe) {
    if (safeTerm.length === 0) continue;
    searchable = searchable.replaceAll(safeTerm, ' ');
  }

  const matches: RuleMatch[] = [];
  for (const term of rulebook.contains) {
    if (containsTerm(searchable, term)) matches.push({ term, section: 'Bevat gluten' });
  }
  for (const term of rulebook.doubtful) {
    if (containsTerm(searchable, term)) matches.push({ term, section: 'Twijfel' });
  }
  return matches;
}

/**
 * Word-start match: the term must begin at a word boundary, but may continue
 * into a longer compound (Dutch glues words together — "tarwebloem",
 * "gerstemout"). Deliberately generous in the blocking direction.
 */
function containsTerm(haystack: string, term: string): boolean {
  if (term.length === 0) return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(term, from);
    if (idx === -1) return false;
    const before = idx === 0 ? ' ' : haystack[idx - 1];
    if (before === ' ') return true;
    from = idx + 1;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

async function atomicWrite(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.rename(tmp, path);
  await fs.chmod(path, 0o600).catch(() => {
    // Best-effort; Windows ignores POSIX perms. Production is Linux.
  });
}

/**
 * Insert a bullet at the end of a section's body, creating the section at the
 * end of the file if it is missing. Same shape as the profile helper, kept
 * local so the two files can diverge without coupling.
 */
export function insertBullet(markdown: string, section: string, bullet: string): string {
  const lines = markdown.split('\n');
  const header = `## ${section}`;
  const headerIndex = lines.findIndex((line) => line.trim().toLowerCase() === header.toLowerCase());

  if (headerIndex === -1) {
    const trailing = lines.length > 0 && lines[lines.length - 1] !== '' ? '\n' : '';
    return `${markdown}${trailing}\n${header}\n\n- ${bullet}\n`;
  }

  let end = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const value = lines[i];
    if (value !== undefined && /^#{1,6} /.test(value)) {
      end = i;
      break;
    }
  }

  let insertAt = end;
  while (insertAt > headerIndex + 1) {
    const candidate = lines[insertAt - 1];
    if (candidate !== undefined && candidate.trim() !== '') break;
    insertAt -= 1;
  }

  return [...lines.slice(0, insertAt), `- ${bullet}`, ...lines.slice(insertAt)].join('\n');
}

/**
 * Seed content. Deliberately opinionated: it ships a usable starter list for
 * Dutch products rather than an empty file, because an empty rulebook would
 * silently degrade every product to "unverified" on first run.
 *
 * These terms are a starting point, NOT a certified list. Add to them.
 */
const RULEBOOK_TEMPLATE = `# Glutenregels

Dit bestand bepaalt hoe de assistent beoordeelt of een product gluten bevat.
Je kunt het zelf aanpassen — wijzigingen gelden direct bij de volgende controle.

Hoe de secties werken:

- **Bevat gluten** — komt deze term voor in de ingrediënten, dan wordt het
  product GEBLOKKEERD. Het belandt niet in de mand.
- **Twijfel** — komt deze term voor, dan weet de assistent het niet zeker. Het
  product wordt wel toegevoegd, maar duidelijk gemarkeerd zodat jij het
  controleert.
- **Veilig** — deze termen zijn expliciet oké. Ze bestaan om te voorkomen dat
  een bredere regel onterecht aanslaat (bijv. "glutenvrije haver" mag niet op
  een "haver"-regel stuklopen).
- **Voorbeelden** — vrije notities voor jezelf. Deze worden nooit als regel
  gebruikt.

Termen matchen op woordbegin: "tarwe" dekt ook "tarwebloem" en "tarwezetmeel".
Dat is bewust ruim — liever te vaak blokkeren dan te weinig. Gebruik de sectie
**Veilig** om uitzonderingen te maken.

Achter een term mag je met " — " een toelichting zetten; die wordt genegeerd
bij het matchen.

## Bevat gluten

- tarwe — alle tarwevormen, incl. tarwebloem en tarwezetmeel
- spelt
- gerst
- rogge
- mout — komt vrijwel altijd van gerst
- seitan — pure tarwegluten
- couscous
- bulgur
- griesmeel
- paneermeel
- kamut
- durum
- orzo — dit is tarwepasta, geen rijst
- panko
- gluten
- triticale — kruising van tarwe en rogge
- einkorn
- emmer — oude tarwesoort
- farro — Italiaanse naam voor emmertarwe
- khorasan
- beschuit
- crouton
- matze
- brooddeeg
- broodkruim

## Twijfel

- gemodificeerd zetmeel — bron staat er niet altijd bij
- dextrine
- bindmiddel
- bouillon — bevat vaak tarwe

<!--
Bewust NIET in deze lijst, omdat ze in bijna elk product voorkomen en dan
alles als "niet geverifieerd" markeren — waardoor je de waarschuwingen niet
meer leest:

- "aroma"  — staat op heel veel etiketten; zelden gluten
- "zetmeel" — meestal maïs- of aardappelzetmeel; "gemodificeerd zetmeel"
  hierboven dekt het echte twijfelgeval

Wil je toch maximale voorzichtigheid? Zet ze er dan zelf bij. Reken op veel
meer meldingen.
-->


## Veilig

- glutenvrij
- glutenvrije haver
- maiszetmeel
- aardappelzetmeel
- rijstmeel
- boekweit
- quinoa
- tapiocazetmeel

## Voorbeelden

- Mout komt van gerst, dus "moutextract" en "gerstemout" bevatten gluten — ook
  in kleine hoeveelheden.
- "Orzo" ziet eruit als rijst maar is tarwepasta.
- Haver is van nature glutenvrij maar raakt vaak besmet; alleen gecertificeerd
  glutenvrije haver is veilig.
`;
