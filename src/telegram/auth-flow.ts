/**
 * `/sms` re-auth flow.
 *
 * Per grilling Q2 the flow is:
 *   1. Agent (inside a tool call) throws `AuthRequiredError`.
 *   2. Telegram layer catches it, posts in the group:
 *      "Picnic-login is verlopen. Stuur /sms om een SMS-code te ontvangen."
 *   3. User sends `/sms`. We call `picnic.requestSmsCode()`, set the chat
 *      state to `awaiting-sms-code`, and tell the user to send the code.
 *   4. The next user message in that chat — if it's a 6-digit string — is
 *      passed to `picnic.verifyTwoFactorCode()`. On success we reset state
 *      to `idle` and tell them to retry the previous request.
 *
 * This module exposes the high-level handlers; the bot wires them up.
 */

import type { PicnicClient } from '../picnic/index.js';
import type { ChatState } from './state.js';

export const SMS_CODE_REGEX = /^\d{6}$/;

/** Handle the `/sms` command. Returns the Dutch message to send back. */
export async function handleSmsCommand(
  picnic: PicnicClient,
  chatState: ChatState,
): Promise<string> {
  try {
    await picnic.requestSmsCode();
    chatState.authFlow = 'awaiting-sms-code';
    return 'Ik heb Picnic gevraagd om een SMS-code te sturen. Stuur me de 6-cijferige code zodra je hem hebt.';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Kon Picnic niet bereiken om een SMS te sturen: ${msg}`;
  }
}

/** Handle a 6-digit SMS code while in the awaiting-sms-code state. */
export async function handleSmsCode(
  picnic: PicnicClient,
  chatState: ChatState,
  code: string,
): Promise<string> {
  try {
    await picnic.verifyTwoFactorCode(code);
    chatState.authFlow = 'idle';
    return 'Picnic-login is weer in orde. Stuur je vraag opnieuw.';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Stay in awaiting-sms-code so the user can try again with a fresh code.
    return `Verificatie mislukte: ${msg}. Probeer opnieuw met /sms voor een nieuwe code.`;
  }
}

/**
 * Helper: when an agent turn throws AuthRequiredError, this is the
 * standardised message the bot should post back.
 */
export const AUTH_REQUIRED_PROMPT =
  'Mijn Picnic-login is verlopen. Stuur /sms om een SMS-code te ontvangen, en daarna de code zelf, dan probeer ik het opnieuw.';
