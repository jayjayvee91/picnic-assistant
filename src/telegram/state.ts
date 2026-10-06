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
  /** When the household last sent a message that reached the agent. */
  lastMessageAt: Date | null;
  /** Anthropic spend of the current conversation, for `/status`. */
  spentEur: number;
  /** Claude calls made in the current conversation, for `/status`. */
  steps: number;
}

/**
 * Silence after which the next message starts a fresh conversation. Long
 * enough for a break in the middle of a weekly shop, short enough that two
 * shops never blend. Anything worth keeping across shops belongs in long-term
 * memory (profile, order history, gluten decisions), not in the conversation —
 * re-sending last week's chat on every step was a large part of the bill.
 */
export const CONVERSATION_IDLE_RESET_MS = 4 * 60 * 60 * 1000;

const chatStates = new Map<number, ChatState>();

export function getOrCreateChatState(chatId: number): ChatState {
  let s = chatStates.get(chatId);
  if (!s) {
    s = { history: [], authFlow: 'idle', lastMessageAt: null, spentEur: 0, steps: 0 };
    chatStates.set(chatId, s);
  }
  return s;
}

/**
 * Call for every message headed to the agent. Clears the conversation if the
 * chat has been silent for `CONVERSATION_IDLE_RESET_MS`, then marks now as
 * the last message. The draft is untouched: it lives in SQLite, not here.
 */
export function continueOrStartConversation(chatId: number, now = new Date()): ChatState {
  const s = getOrCreateChatState(chatId);
  if (s.lastMessageAt && now.getTime() - s.lastMessageAt.getTime() >= CONVERSATION_IDLE_RESET_MS) {
    startFresh(s);
  }
  s.lastMessageAt = now;
  return s;
}

export function resetChatHistory(chatId: number): void {
  startFresh(getOrCreateChatState(chatId));
}

function startFresh(s: ChatState): void {
  s.history = [];
  s.spentEur = 0;
  s.steps = 0;
}
