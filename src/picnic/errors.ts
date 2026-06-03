/**
 * Errors raised by the Picnic adapter. Distinct types so the Telegram layer can
 * route them differently:
 *
 * - `TwoFactorRequiredError`  → bot enters the SMS-code flow with the user.
 * - `AuthRequiredError`       → stored session is missing/expired; bot asks the
 *                               user to start a full re-login (including SMS).
 * - `PicnicCallError`         → a Picnic call failed for other reasons (network,
 *                               server error). The bot reports and stops.
 */

export class TwoFactorRequiredError extends Error {
  constructor(message = 'Two-factor authentication required.') {
    super(message);
    this.name = 'TwoFactorRequiredError';
  }
}

export class AuthRequiredError extends Error {
  constructor(message = 'Picnic session expired or missing — re-login required.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class PicnicCallError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PicnicCallError';
    this.cause = cause;
  }
}
