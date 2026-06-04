/**
 * Public surface of the agent layer.
 *
 * Higher layers (Telegram in Step 6, scheduler in Step 7) import only from
 * here.
 */

export { AgentAnthropicClient, type AnthropicClientOptions } from './client.js';
export { AgentLoop, type AgentLoopOptions, type RunTurnInput, type RunTurnResult } from './loop.js';
export {
  IterationCapExceededError,
  DailySpendCapExceededError,
  MAX_TOOL_CALLS_PER_TURN,
} from './guards.js';
export type { AgentContext } from './tools.js';
export { AGENT_TOOLS } from './tools.js';
