/**
 * The agent loop.
 *
 *   1. Append the new user message to the conversation.
 *   2. Build the system prompt (static + dynamic blocks).
 *   3. Call Claude with the conversation, tools, and system prompt.
 *   4. If the response contains tool_use blocks, execute each, append a
 *      `tool_result` user message, and loop. Capped at
 *      `MAX_TOOL_CALLS_PER_TURN` (see `guards.ts`) so a buggy model can't
 *      burn through a thousand calls in one turn.
 *   5. When Claude responds with text only, return that text and the
 *      accumulated conversation for the caller to persist.
 *
 * Guards (per Q7 in grilling):
 *   - `assertWithinDailySpendCap` checked BEFORE each Anthropic call.
 *   - Per-turn tool-call cap of 15.
 *   - No automatic retries on API errors — first error throws.
 *   - Spend accumulated in SQLite via `recordCallCost` after every call.
 */

import type { ContentBlock, MessageParam, Message } from '@anthropic-ai/sdk/resources/messages.mjs';
import { logApiCall } from '../memory/index.js';
import { AgentAnthropicClient } from './client.js';
import { buildSystemPrompt } from './prompt.js';
import { AGENT_TOOLS, handleToolUse, type AgentContext } from './tools.js';
import {
  IterationCapExceededError,
  MAX_TOOL_CALLS_PER_TURN,
  CONVERSATION_TOKEN_SOFT_CAP,
  assertWithinDailySpendCap,
  recordCallCost,
  roughTokenCount,
} from './guards.js';

export interface RunTurnInput {
  /** The user's new message (Dutch). */
  userMessage: string;
  /** First name of the user for identity-awareness (or null). */
  speakerName: string | null;
  /** Conversation history so far (prior user / assistant turns). */
  history: MessageParam[];
}

export interface RunTurnResult {
  /** The bot's final Dutch reply. */
  reply: string;
  /** Updated conversation including this turn's exchange. */
  updatedHistory: MessageParam[];
  /** EUR spent on Anthropic for this turn. */
  spentEur: number;
  /** Tool calls made during this turn. */
  toolCallCount: number;
  /** Claude calls ("steps") made during this turn. */
  apiCallCount: number;
}

export interface AgentLoopOptions {
  ctx: AgentContext;
  anthropic: AgentAnthropicClient;
  profilePath: string;
  dailySpendLimitEur: number;
  /** Override "now" — useful for tests. */
  now?: () => Date;
}

export class AgentLoop {
  private readonly opts: AgentLoopOptions;

  constructor(opts: AgentLoopOptions) {
    this.opts = opts;
  }

  async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
    const now = (this.opts.now ?? (() => new Date()))();
    const { staticBlock, dynamicBlock } = await buildSystemPrompt({
      db: this.opts.ctx.db,
      profilePath: this.opts.profilePath,
      now,
      speakerName: input.speakerName,
    });

    const trimmedHistory = trimHistoryToBudget(input.history);
    const messages: MessageParam[] = [
      ...trimmedHistory,
      { role: 'user', content: input.userMessage },
    ];

    let spentEur = 0;
    let toolCallCount = 0;
    let apiCallCount = 0;

    for (let iter = 0; iter <= MAX_TOOL_CALLS_PER_TURN; iter++) {
      assertWithinDailySpendCap(this.opts.ctx.db, this.opts.dailySpendLimitEur);

      const response = await this.opts.anthropic.send({
        staticSystemBlock: staticBlock,
        dynamicSystemBlock: dynamicBlock,
        tools: AGENT_TOOLS,
        messages,
      });

      const usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      };
      const callEur = recordCallCost(this.opts.ctx.db, usage);
      spentEur += callEur;
      apiCallCount += 1;

      // Append the assistant's response to the conversation we're building.
      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );
      const logStep = (toolResultChars: number) =>
        logApiCall(this.opts.ctx.db, {
          conversationKey: this.opts.ctx.conversationKey,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheWriteTokens: usage.cacheCreationInputTokens,
          cacheReadTokens: usage.cacheReadInputTokens,
          costEur: callEur,
          tools: toolUses.map((t) => t.name),
          toolResultChars,
        });

      if (toolUses.length === 0) {
        // Plain text response — we're done.
        logStep(0);
        const reply = extractFinalText(response);
        return {
          reply,
          updatedHistory: messages,
          spentEur,
          toolCallCount,
          apiCallCount,
        };
      }

      // We have tool calls. Enforce the per-turn cap before executing.
      if (toolCallCount + toolUses.length > MAX_TOOL_CALLS_PER_TURN) {
        logStep(0);
        throw new IterationCapExceededError();
      }

      // Execute every tool_use in this assistant turn and bundle the results
      // into one user message (Anthropic's required shape: tool_result blocks
      // grouped together as a single user message).
      const toolResults: Array<{
        type: 'tool_result';
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }> = [];
      for (const block of toolUses) {
        const result = await handleToolUse(this.opts.ctx, block);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
        toolCallCount += 1;
      }
      messages.push({ role: 'user', content: toolResults });
      logStep(toolResults.reduce((sum, r) => sum + r.content.length, 0));

      // Loop — the next iteration sends the tool_results back to Claude.
    }

    // We only reach here if we hit the for-loop bound without returning. That
    // means the cap caught us between iterations even though the granular
    // check didn't — defensive belt-and-braces.
    throw new IterationCapExceededError();
  }
}

/**
 * Emergency brake: when the rough token count of the prior conversation
 * exceeds the soft cap, drop the oldest messages until it fits. Normal weekly
 * shops stay well under the cap, so this is a no-op in practice.
 *
 * The kept part always starts at a message the household typed. Cutting
 * anywhere else can leave a `tool_result` whose `tool_use` was dropped, or an
 * assistant turn first — both of which Claude rejects.
 */
function trimHistoryToBudget(history: MessageParam[]): MessageParam[] {
  let tokens = history.reduce((sum, m) => sum + messageTokens(m), 0);
  if (tokens <= CONVERSATION_TOKEN_SOFT_CAP) return history;
  let start = 0;
  while (start < history.length && tokens > CONVERSATION_TOKEN_SOFT_CAP) {
    tokens -= messageTokens(history[start]!);
    start++;
  }
  while (start < history.length && !isHouseholdMessage(history[start]!)) start++;
  return history.slice(start);
}

function messageTokens(m: MessageParam): number {
  return roughTokenCount(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
}

/** A user turn the household typed, as opposed to one carrying tool results. */
function isHouseholdMessage(m: MessageParam): boolean {
  if (m.role !== 'user') return false;
  return typeof m.content === 'string' || m.content.every((b) => b.type !== 'tool_result');
}

/**
 * Concatenate all top-level text blocks in a final assistant message.
 * Anthropic responses sometimes split text into multiple blocks; the bot's
 * Telegram reply should be a single string.
 */
function extractFinalText(response: Message): string {
  return response.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
