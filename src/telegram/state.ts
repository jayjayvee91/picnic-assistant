/**
 * Per-process Telegram-side state.
 *
 * Some state survives restarts (bot paused/running, allowed chat id,
 * onboarding flag) — that lives in the SQLite `meta` table. Other state is
 * ephemeral (which chats are mid re-auth, in-memory conversation history) —
 * that lives in this module's maps.
 *
 * Keeping persistence and in-memory state side-by-side here makes it easy to
 * see what survives a deploy.
 */

import { getMeta, setMeta, type DB } from '../memory/index.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.mjs';

// ──────────────────────────────────────────────────────────────────────
// Persistent state (SQLite meta table)
// ──────────────────────────────────────────────────────────────────────

const KEY_BOT_RUNNING = 'bot_running';
const KEY_ALLOWED_CHAT_ID = 'telegram_allowed_chat_id';
const KEY_ONBOARDING_DONE = 'onboarding_completed';

/** Whether the bot is currently honouring messages. Defaults to `true`. */
export function isBotRunning(db: DB): boolean {
  return getMeta(db, KEY_BOT_RUNNING) !== 'false';
}

export function setBotRunning(db: DB, running: boolean): void {
  setMeta(db, KEY_BOT_RUNNING, running ? 'true' : 'false');
}

/**
 * Resolve the allowed chat id from `meta` first (set at runtime via
 * `/setchat`), falling back to the `TELEGRAM_ALLOWED_CHAT_ID` env var.
 * Returns null if neither is set — in which case the bot replies with a
 * helpful "send /chatid to see your id" message and refuses to do anything.
 */
export function getAllowedChatId(db: DB, fallback: string | null): number | null {
  const fromMeta = getMeta(db, KEY_ALLOWED_CHAT_ID);
  const raw = fromMeta ?? fallback;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function setAllowedChatId(db: DB, chatId: number): void {
  setMeta(db, KEY_ALLOWED_CHAT_ID, String(chatId));
}

export function isOnboardingDone(db: DB): boolean {
  return getMeta(db, KEY_ONBOARDING_DONE) === 'true';
}

export function markOnboardingDone(db: DB): void {
  setMeta(db, KEY_ONBOARDING_DONE, 'true');
}

// ──────────────────────────────────────────────────────────────────────
// Ephemeral state (lost on restart)
// ──────────────────────────────────────────────────────────────────────

/**
 * Where each chat is in the SMS re-auth state machine.
 *   - `idle`: nothing pending.
 *   - `awaiting-sms-code`: user typed `/sms`, we asked Picnic to send an SMS,
 *     and we're waiting for them to paste the 6-digit code back.
 */
export type AuthFlowState = 'idle' | 'awaiting-sms-code';

/** Per-chat conversation memory + re-auth phase. */
export interface ChatState {
  history: MessageParam[];
  authFlow: AuthFlowState;
}

const chatStates = new Map<number, ChatState>();

export function getOrCreateChatState(chatId: number): ChatState {
  let s = chatStates.get(chatId);
  if (!s) {
    s = { history: [], authFlow: 'idle' };
    chatStates.set(chatId, s);
  }
  return s;
}

export function resetChatHistory(chatId: number): void {
  const s = getOrCreateChatState(chatId);
  s.history = [];
}
