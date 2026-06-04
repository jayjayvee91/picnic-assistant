/**
 * Recipe URL extraction — best-effort.
 *
 * Step 5 ships only the structured-data path:
 *   1. Fetch the URL.
 *   2. Find `<script type="application/ld+json">` blocks.
 *   3. Walk them for a `@type: Recipe` (or `@graph` containing one).
 *   4. Return ingredient strings (and a few helpful fields like name, servings).
 *
 * If extraction fails, we return `null`. The agent's tool handler then asks
 * the user to paste the ingredients directly — per the always-show rule
 * agreed in grilling, the user reviews extracted ingredients before they
 * land in the draft anyway.
 *
 * The LLM-fallback path (send the page text to Claude and ask it to extract)
 * is deliberately deferred. It would work but adds non-trivial cost and
 * another failure mode for v1. Schema.org Recipe markup is present on most
 * big NL recipe sites (AH, Jumbo, Smulweb, Leukerecepten) so coverage is
 * already decent.
 */

export interface ExtractedRecipe {
  /** Source URL (echoed back). */
  url: string;
  /** Human-readable name if the structured data provided one. */
  name: string | null;
  /** Free-text servings (e.g. "4 personen"). */
  servings: string | null;
  /** Free-text ingredient strings as written in the source. */
  ingredients: string[];
}

export interface RecipeFetchOptions {
  /** Override the fetcher. Default: global `fetch`. Useful for tests. */
  fetcher?: typeof fetch;
  /** Override DNS lookup for tests. Should return an array of resolved IPs. */
  resolver?: (host: string) => Promise<string[]>;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Max redirect hops to follow. Each is re-validated. */
  maxRedirects?: number;
  /** Reject responses whose `Content-Length` exceeds this many bytes. */
  maxBodyBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Fetch a URL and pull ingredients via JSON-LD Recipe markup.
 *
 * Returns null when:
 *   - the URL is missing/malformed/non-HTTPS-or-HTTP
 *   - the host resolves to a private/loopback/link-local IP (SSRF guard —
 *     critically including 169.254.0.0/16 to block cloud-metadata endpoints)
 *   - the page is unreachable, redirects too many times, or is too large
 *   - extraction yields no ingredients
 *
 * Redirects are followed MANUALLY (max `maxRedirects` hops), and each Location
 * is re-validated through the same SSRF guard. This stops a recipe page from
 * 302-ing to `http://169.254.169.254/...`.
 */
export async function extractRecipeFromUrl(
  url: string,
  opts: RecipeFetchOptions = {},
): Promise<ExtractedRecipe | null> {
  const fetcher = opts.fetcher ?? fetch;
  const resolver = opts.resolver ?? defaultResolver;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let html: string;
  try {
    let currentUrl = url;
    let response: Response | null = null;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (!(await isSafeUrl(currentUrl, resolver))) return null;

      response = await fetcher(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });

      // Manual redirect handling so we re-validate each Location.
      if (response.status >= 300 && response.status < 400) {
        const loc = response.headers.get('location');
        if (!loc) return null;
        try {
          currentUrl = new URL(loc, currentUrl).toString();
        } catch {
          return null;
        }
        continue;
      }
      break;
    }
    if (!response || !response.ok) return null;

    const contentLength = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) return null;

    html = await response.text();
    if (html.length > maxBodyBytes) return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  return extractRecipeFromHtml(html, url);
}

/**
 * Pure helper: given a raw HTML string, try to extract a Recipe. Separated so
 * tests can pass canned HTML without hitting the network.
 */
export function extractRecipeFromHtml(html: string, url: string): ExtractedRecipe | null {
  for (const block of findLdJsonBlocks(html)) {
    const recipe = findRecipeNode(block);
    if (!recipe) continue;
    const ingredients = normaliseIngredients(recipe.recipeIngredient);
    if (ingredients.length === 0) continue;
    return {
      url,
      name: typeof recipe.name === 'string' ? recipe.name : null,
      servings: extractServings(recipe),
      ingredients,
    };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

interface RecipeNode {
  '@type'?: string | string[];
  name?: unknown;
  recipeIngredient?: unknown;
  recipeYield?: unknown;
}

/**
 * Yield each `application/ld+json` block as a parsed value. Skips malformed
 * blocks rather than throwing — many sites ship slightly broken JSON-LD.
 */
function* findLdJsonBlocks(html: string): Generator<unknown> {
  // Greedy, but anchored at the script tag — handles whitespace and attribute
  // ordering. `[\s\S]` rather than `.` because the body may span lines.
  const re = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const body = match[1];
    if (!body) continue;
    try {
      yield JSON.parse(body) as unknown;
    } catch {
      // Some pages have multiple JSON objects in one block, comma-separated
      // or with stray characters. Worth a single fallback attempt.
      const trimmed = body.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        // Already attempted; nothing else to do.
        continue;
      }
    }
  }
}

/**
 * Walk a parsed JSON-LD value and return the first Recipe-typed node it finds.
 * Handles three common shapes:
 *   - top-level Recipe: { "@type": "Recipe", ... }
 *   - graph wrapper:    { "@graph": [ { "@type": "Recipe", ... }, ... ] }
 *   - array of objects: [ { "@type": "WebPage" }, { "@type": "Recipe", ... } ]
 */
function findRecipeNode(value: unknown): RecipeNode | null {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (isRecipeType(obj['@type'])) return obj as RecipeNode;
  if (Array.isArray(obj['@graph'])) {
    return findRecipeNode(obj['@graph']);
  }
  return null;
}

function isRecipeType(value: unknown): boolean {
  if (typeof value === 'string') return value === 'Recipe';
  if (Array.isArray(value)) return value.some((v) => typeof v === 'string' && v === 'Recipe');
  return false;
}

function normaliseIngredients(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

// ──────────────────────────────────────────────────────────────────────
// SSRF guard
// ──────────────────────────────────────────────────────────────────────

/**
 * True iff the URL is safe to fetch from a VPS context: http/https scheme,
 * hostname that resolves only to public IPs.
 */
async function isSafeUrl(
  raw: string,
  resolve: (host: string) => Promise<string[]>,
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname;
  if (host.length === 0) return false;

  // If the host is an IP literal, classify it directly (DNS would just echo it back).
  if (isIpLiteral(host)) {
    return !isBlockedIp(stripBrackets(host));
  }

  // Otherwise resolve through DNS and reject if ANY result is private/loopback.
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return false;
  }
  if (addresses.length === 0) return false;
  return !addresses.some((ip) => isBlockedIp(ip));
}

/** Best-effort detection of IP literals in a URL hostname. IPv6 comes wrapped in `[…]`. */
function isIpLiteral(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** True iff `ip` is in a range we refuse to fetch from. Covers IPv4 + IPv6. */
function isBlockedIp(ip: string): boolean {
  if (ip.includes(':')) return isBlockedIpv6(ip);
  return isBlockedIpv4(ip);
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return true; // malformed — fail closed
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; //   0.0.0.0/8
  if (a === 10) return true; //  10.0.0.0/8 (RFC 1918)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — INCLUDES cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a >= 224) return true; // 224.0.0.0/4 multicast, 240/4 reserved
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb')
  ) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
  if (lower.startsWith('ff')) return true; // ff00::/8 multicast
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped — recheck the v4 part.
    const v4 = lower.slice(7);
    return isBlockedIpv4(v4);
  }
  return false;
}

async function defaultResolver(host: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const results = await lookup(host, { all: true });
  return results.map((r) => r.address);
}

function extractServings(recipe: RecipeNode): string | null {
  const y = recipe.recipeYield;
  if (typeof y === 'string') return y;
  if (typeof y === 'number') return String(y);
  if (Array.isArray(y) && y.length > 0) {
    const first = y[0];
    if (typeof first === 'string') return first;
    if (typeof first === 'number') return String(first);
  }
  return null;
}
