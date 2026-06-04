/**
 * Thin wrapper around MRVDH's `picnic-api` v4.
 *
 * Why this layer exists
 * ---------------------
 * 1. **Stable surface for the rest of the bot.** Memory, agent, and Telegram
 *    layers import only `PicnicClient` — never `picnic-api` directly. If MRVDH
 *    breaks or we ever swap libraries, only this file changes.
 * 2. **`DRY_RUN` gating.** All write operations (`addToCart`, `removeFromCart`,
 *    `setDeliverySlot`) are no-ops with a log line when `DRY_RUN=true`. This is
 *    how we test locally without polluting the real Picnic cart.
 * 3. **Typed error surface.** Distinct error classes (`TwoFactorRequiredError`,
 *    `AuthRequiredError`) let the Telegram layer route auth issues into the
 *    `/sms` re-auth flow rather than treating them as generic failures.
 * 4. **Session persistence.** First successful 2FA produces a long-lived auth
 *    key that we save to disk. Subsequent boots restore it — no re-login until
 *    Picnic invalidates the key.
 *
 * What this layer is NOT
 * ----------------------
 * - A retry/backoff layer. If a call fails, it throws. The agent loop decides
 *   what to do (usually: report and stop, per the cost-runaway design).
 * - A cache. Reads always hit Picnic. (Memory store caches separately, by
 *   choice, in `src/memory/`.)
 *
 * Privacy
 * -------
 * - The password is held only until first successful 2FA, then discarded.
 *   After that, only the long-lived `authKey` is kept in memory + on disk.
 * - `console.log` of credentials, the password, or the auth key is forbidden.
 *   `safeLog` below redacts known-sensitive fields if structured data ever
 *   needs logging.
 */

import PicnicApi from 'picnic-api';

import { AuthRequiredError, PicnicCallError, TwoFactorRequiredError } from './errors.js';
import { clearSession, loadSession, saveSession, type PicnicSession } from './session.js';

/**
 * The shape of the underlying client. `picnic-api` only exports the constructor
 * (CommonJS `export =`), so we derive the instance shape this way and then use
 * it to extract method return types — no subpath imports needed, no internal
 * type paths to keep in sync.
 */
type Inner = InstanceType<typeof PicnicApi>;

/**
 * Re-exports of types we use, derived from the methods we call. Downstream
 * code (memory, agent, Telegram) imports these from here so it never has to
 * touch `picnic-api` itself.
 */
export type Cart = Awaited<ReturnType<Inner['cart']['getCart']>>;
export type Delivery = Awaited<ReturnType<Inner['delivery']['getDeliveries']>>[number];
export type DeliveryDetail = Awaited<ReturnType<Inner['delivery']['getDelivery']>>;
export type SellingUnit = Awaited<ReturnType<Inner['catalog']['search']>>[number];
export type GetDeliverySlotsResult = Awaited<ReturnType<Inner['cart']['getDeliverySlots']>>;
export type FusionPage = Awaited<ReturnType<Inner['recipe']['getRecipesPage']>>;

export type PicnicCountryCode = 'NL' | 'DE' | 'FR';

export interface PicnicClientOptions {
  username: string;
  password: string;
  countryCode?: PicnicCountryCode;
  sessionFile: string;
  dryRun: boolean;
}

export class PicnicClient {
  /** The underlying MRVDH client. Private — only this file touches it. */
  private readonly inner: Inner;
  private readonly opts: PicnicClientOptions;
  /** Tracks whether we've completed login (or restored a valid session). */
  private hasAuth = false;

  constructor(opts: PicnicClientOptions) {
    this.opts = opts;
    this.inner = new PicnicApi({ countryCode: opts.countryCode ?? 'NL' });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Authentication lifecycle
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Try to restore a saved session from disk. Returns true if a key was loaded.
   * Does NOT verify the key — if it's expired, the next API call throws
   * `AuthRequiredError` and the caller starts a fresh login.
   */
  async restoreSession(): Promise<boolean> {
    const session = await loadSession(this.opts.sessionFile);
    if (!session) return false;
    this.inner.authKey = session.authKey;
    this.hasAuth = true;
    safeLog('info', 'Picnic session restored from disk.');
    return true;
  }

  /**
   * Start a fresh login. If Picnic returns `second_factor_authentication_required`,
   * the method throws `TwoFactorRequiredError`. The caller must then drive the
   * SMS flow:
   *
   *   await client.requestSmsCode();
   *   // ... ask the user for the code ...
   *   await client.verifyTwoFactorCode(code);
   *
   * If 2FA is NOT required (rare in practice for Picnic NL), the method completes
   * normally and the session is persisted.
   */
  async login(): Promise<void> {
    let result;
    try {
      result = await this.inner.auth.login(this.opts.username, this.opts.password);
    } catch (err) {
      throw new PicnicCallError('Login request failed.', err);
    }

    if (result.second_factor_authentication_required) {
      safeLog('info', 'Picnic login accepted; 2FA required.');
      throw new TwoFactorRequiredError();
    }

    // No 2FA needed → already authenticated.
    await this.completeAuth(result.authKey);
  }

  /**
   * Ask Picnic to send a 2FA code to the user's phone via SMS. Call only after
   * `login()` has thrown `TwoFactorRequiredError`.
   */
  async requestSmsCode(): Promise<void> {
    try {
      await this.inner.auth.generate2FACode('SMS');
      safeLog('info', 'Picnic SMS code requested.');
    } catch (err) {
      throw new PicnicCallError('Could not request 2FA SMS code.', err);
    }
  }

  /**
   * Verify the 6-digit code the user just received. On success, the long-lived
   * auth key is captured and persisted.
   */
  async verifyTwoFactorCode(code: string): Promise<void> {
    let result;
    try {
      result = await this.inner.auth.verify2FACode(code);
    } catch (err) {
      throw new PicnicCallError('2FA verification failed.', err);
    }
    await this.completeAuth(result.authKey);
  }

  /**
   * Forget the current session (in memory + on disk). The next call will need
   * a fresh login. Used by the `/sms` re-auth flow when the saved key expired.
   */
  async forgetSession(): Promise<void> {
    this.inner.authKey = null;
    this.hasAuth = false;
    // Best-effort delete; if the file is already gone, fine.
    await clearSession(this.opts.sessionFile);
    safeLog('info', 'Picnic session forgotten.');
  }

  // ──────────────────────────────────────────────────────────────────────
  // Reads
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Past + current deliveries. Defaults to completed orders only — this is
   * what `Step 3` will pump into the order-history backfill.
   */
  async getDeliveries(
    filter: ('CURRENT' | 'COMPLETED' | 'CANCELLED')[] = ['COMPLETED'],
  ): Promise<Delivery[]> {
    return this.callAuthed(() => this.inner.delivery.getDeliveries(filter), 'getDeliveries');
  }

  /**
   * Full detail of a single delivery, including all order lines and the
   * articles inside them. `getDeliveries()` only returns slim summaries —
   * use this when you need the actual items in an order (e.g. the Step 3
   * bootstrap that backfills order history).
   */
  async getDelivery(deliveryId: string): Promise<DeliveryDetail> {
    return this.callAuthed(() => this.inner.delivery.getDelivery(deliveryId), 'getDelivery');
  }

  /** The current shopping cart (and its computed totals). */
  async getCart(): Promise<Cart> {
    return this.callAuthed(() => this.inner.cart.getCart(), 'getCart');
  }

  /** Free-text product search. */
  async searchProducts(query: string): Promise<SellingUnit[]> {
    return this.callAuthed(() => this.inner.catalog.search(query), 'searchProducts');
  }

  /** Available delivery slots. View-only — booking is `setDeliverySlot`. */
  async getDeliverySlots(): Promise<GetDeliverySlotsResult> {
    return this.callAuthed(() => this.inner.cart.getDeliverySlots(), 'getDeliverySlots');
  }

  /**
   * The Picnic "Recipes" overview page (a Fusion page — Picnic's CMS-style
   * structured content). The agent layer will need to parse this for both
   * "browse all recipes" and "user's saved recipes" — the saved-recipes list
   * is one of the sections within the page in current Picnic apps.
   *
   * Step 5 will add a typed parser once the page shape is observed in real data.
   */
  async getRecipesPage(): Promise<FusionPage> {
    return this.callAuthed(() => this.inner.recipe.getRecipesPage(), 'getRecipesPage');
  }

  // ──────────────────────────────────────────────────────────────────────
  // Writes (DRY_RUN-gated)
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Add a product to the cart. No-op when `DRY_RUN=true`.
   * Returns nothing — callers that need the resulting cart call `getCart()`
   * explicitly. Keeps the dry-run vs live behaviour symmetric.
   */
  async addProductToCart(productId: string, count = 1): Promise<void> {
    if (this.opts.dryRun) {
      safeLog('info', `DRY_RUN: would add product to cart`, { productId, count });
      return;
    }
    await this.callAuthed(
      () => this.inner.cart.addProductToCart(productId, count),
      'addProductToCart',
    );
  }

  /** Remove a product from the cart. No-op when `DRY_RUN=true`. */
  async removeProductFromCart(productId: string, count = 1): Promise<void> {
    if (this.opts.dryRun) {
      safeLog('info', `DRY_RUN: would remove product from cart`, { productId, count });
      return;
    }
    await this.callAuthed(
      () => this.inner.cart.removeProductFromCart(productId, count),
      'removeProductFromCart',
    );
  }

  /**
   * Reserve a delivery slot (Level C). No-op when `DRY_RUN=true`.
   * `slotId` comes from `getDeliverySlots()`.
   */
  async setDeliverySlot(slotId: string): Promise<void> {
    if (this.opts.dryRun) {
      safeLog('info', `DRY_RUN: would reserve delivery slot`, { slotId });
      return;
    }
    await this.callAuthed(() => this.inner.cart.setDeliverySlot(slotId), 'setDeliverySlot');
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  /** Capture a fresh auth key and persist it. */
  private async completeAuth(authKey: string): Promise<void> {
    this.inner.authKey = authKey;
    this.hasAuth = true;
    const session: PicnicSession = { authKey, savedAt: new Date().toISOString() };
    await saveSession(this.opts.sessionFile, session);
    safeLog('info', 'Picnic auth complete and session persisted.');
  }

  /**
   * Wrap a Picnic call so that:
   * 1. We refuse to make the call if we don't have an auth key.
   * 2. Anything that looks like a 401 from Picnic is translated into our
   *    `AuthRequiredError` so the Telegram layer can drive re-auth.
   *
   * The 401 detection is best-effort because MRVDH doesn't (yet) expose a
   * structured error type — we inspect the message/status. If we get it wrong,
   * the call surfaces as `PicnicCallError` and the bot reports it; the user
   * can still kick off re-auth manually.
   */
  private async callAuthed<T>(fn: () => Promise<T>, op: string): Promise<T> {
    if (!this.hasAuth || !this.inner.authKey) {
      throw new AuthRequiredError(`Cannot perform ${op}: no Picnic session.`);
    }
    try {
      return await fn();
    } catch (err) {
      if (looksLikeAuthFailure(err)) {
        // Drop the bad key so we don't keep retrying.
        this.hasAuth = false;
        this.inner.authKey = null;
        throw new AuthRequiredError(`Picnic auth rejected during ${op}.`);
      }
      throw new PicnicCallError(`Picnic call ${op} failed.`, err);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Heuristic for "the auth key is bad." MRVDH throws plain Errors with the
 * upstream status text — we check for 401-ish signals across a few shapes.
 *
 * Match list is deliberately narrow so we don't nuke a still-valid session
 * on errors that *mention* authentication without actually being an auth
 * failure (e.g. "auth service temporarily unavailable" should retry, not
 * trigger re-login).
 */
function looksLikeAuthFailure(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('401') ||
      msg.includes('unauthorized') ||
      msg.includes('unauthorised') ||
      msg.includes('invalid_token') ||
      msg.includes('token expired') ||
      msg.includes('session expired')
    ) {
      return true;
    }
  }
  if (typeof err === 'object' && err !== null) {
    const maybeResp = (err as { response?: { status?: number } }).response;
    if (maybeResp?.status === 401) return true;
  }
  return false;
}

/**
 * Minimal safe logger. Stays local to this module so the Picnic adapter
 * cannot accidentally pull in a logger that pretty-prints object graphs
 * containing credentials.
 *
 * Allowed fields are passed explicitly. We never accept "log this whole
 * options object" — that's how secrets leak.
 */
function safeLog(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, string | number | boolean>,
): void {
  const safeFields = fields
    ? Object.fromEntries(
        Object.entries(fields).filter(([k]) => !FORBIDDEN_LOG_KEYS.has(k.toLowerCase())),
      )
    : undefined;
  const payload = safeFields ? ` ${JSON.stringify(safeFields)}` : '';
  const line = `[picnic] ${message}${payload}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Keys we never log, even if a caller accidentally passes them. */
const FORBIDDEN_LOG_KEYS = new Set([
  'password',
  'authkey',
  'auth_key',
  'token',
  'code',
  'otp',
  'secret',
]);
