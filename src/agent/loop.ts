/**
 * The agent loop.
 *
 *   1. Append the new user message to the conversation.
 *   2. Build the system prompt (static + dynamic blocks).
 *   3. Call Claude with the conversation, tools, and system prompt.
 *   4. If the response contains tool_use blocks, execute each, append a
 *      `tool_result` user message, and loop. Capped at 15 tool calls per
 *      user turn so a buggy model can't burn through a thousand calls.
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

    for (let iter = 0; iter <= MAX_TOOL_CALLS_PER_TURN; iter++) {
      assertWithinDailySpendCap(this.opts.ctx.db, this.opts.dailySpendLimitEur);

      const response = await this.opts.anthropic.send({
        staticSystemBlock: staticBlock,
        dynamicSystemBlock: dynamicBlock,
        tools: AGENT_TOOLS,
        messages,
      });

      spentEur += recordCallCost(this.opts.ctx.db, {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      });

      // Append the assistant's response to the conversation we're building.
      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );

      if (toolUses.length === 0) {
        // Plain text response — we're done.
        const reply = extractFinalText(response);
        return {
          reply,
          updatedHistory: messages,
          spentEur,
          toolCallCount,
        };
      }

      // We have tool calls. Enforce the per-turn cap before executing.
      if (toolCallCount + toolUses.length > MAX_TOOL_CALLS_PER_TURN) {
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

      // Loop — the next iteration sends the tool_results back to Claude.
    }

    // We only reach here if we hit the for-loop bound without returning. That
    // means the cap caught us between iterations even though the granular
    // check didn't — defensive belt-and-braces.
    throw new IterationCapExceededError();
  }
}

/**
 * When the rough token count of the prior conversation exceeds the soft cap,
 * drop the oldest half. Crude but bounded — for v1 this is enough to keep a
 * runaway chat from burning through context indefinitely. A future version
 * could summarise the dropped half via a small Claude call instead.
 *
 * We measure roughly: stringify each message's content and tot up bytes.
 * 30k input tokens is several megabytes of dialogue — well beyond normal use
 * — so most turns this is a no-op.
 */
function trimHistoryToBudget(history: MessageParam[]): MessageParam[] {
  if (history.length === 0) return history;
  const concatenated = history
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('');
  if (roughTokenCount(concatenated) <= CONVERSATION_TOKEN_SOFT_CAP) return history;
  const dropTo = Math.floor(history.length / 2);
  return history.slice(dropTo);
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
