/**
 * First-run onboarding (moved here from Step 4).
 *
 * The mechanism for adding to `profile.md` is `appendToProfileSection` — that
 * shipped with Step 4. The *policy* lives here: when the bot first runs in a
 * chat (the `onboarding_completed` meta flag is false), send one Dutch
 * welcome message that explicitly invites the user to share a few preferences.
 *
 * We deliberately don't build a multi-step state machine that walks the user
 * through "question 1 of 5". The agent already has `propose_profile_addition`
 * and reads the profile every turn — letting the agent run the conversation
 * organically is friendlier and trusts the model rather than fighting it.
 *
 * After the welcome lands, the flag is set so we don't repeat it. Onboarding
 * is best-effort: if the user ignores the welcome and asks for a draft, the
 * bot still works (it'll just use the seed-template defaults until the user
 * shares more).
 */

import type { DB } from '../memory/index.js';
import { markOnboardingDone } from './state.js';

export const ONBOARDING_WELCOME = `Welkom! Ik ben jullie boodschappen-assistent. \
Ik help met de wekelijkse Picnic-bestelling op basis van wat jullie meestal kopen.

Voordat we beginnen, een paar dingen die handig zijn om te weten — je hoeft ze \
niet allemaal nu te beantwoorden, maar als je het me vertelt onthoud ik het:

1. Eten jullie vegetarisch / vegan / geen rundvlees / etc.?
2. Zijn er dingen die jullie absoluut niet lusten?
3. Welke merken pakken jullie standaard? (bijv. "altijd Optimel voor melk")
4. Wanneer bestellen jullie meestal — vast moment in de week of wisselend?

Stuur me gewoon een bericht als je iets wil delen, en als je klaar bent kun je \
vragen om de boodschappen voor deze week voor te stellen.`;

/**
 * Send the welcome and flip the flag in one step. The bot wires this in on
 * the first message it sees from the allowed chat.
 */
export async function sendOnboardingWelcome(
  db: DB,
  send: (text: string) => Promise<void>,
): Promise<void> {
  await send(ONBOARDING_WELCOME);
  markOnboardingDone(db);
}
