/**
 * Public surface of the Telegram layer.
 */

export { createBot, type TelegramBotOptions } from './bot.js';
export { isBotRunning, setBotRunning, getAllowedChatId, setAllowedChatId } from './state.js';
export { AUTH_REQUIRED_PROMPT } from './auth-flow.js';
export { ONBOARDING_WELCOME } from './onboarding.js';
