/**
 * Thin wrapper around the Anthropic SDK.
 *
 * Centralises:
 *   - Construction of the Anthropic client from env.
 *   - The cache-aware `system` block layout (static block tagged
 *     `cache_control: ephemeral`, dynamic block plain).
 *   - The `messages.create` call (no retries — per the cost-runaway design,
 *     a single API error should report and stop, not loop).
 *
 * Higher layers (the agent loop) build the `messages` array, this module
 * just delivers it.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Message, MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages.mjs';

export interface AnthropicClientOptions {
  apiKey: string;
  model: string;
  /** Defaults to 4096 — high enough for a chunky tool-using reply. */
  maxTokens?: number;
}

export class AgentAnthropicClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicClientOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 4096;
  }

  /**
   * One Anthropic call. The `system` argument is the prompt produced by
   * `buildSystemPrompt` — the static block is cached, the dynamic block is
   * not.
   */
  async send(args: {
    staticSystemBlock: string;
    dynamicSystemBlock: string;
    tools: Tool[];
    messages: MessageParam[];
  }): Promise<Message> {
    return await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [
        {
          type: 'text',
          text: args.staticSystemBlock,
          // ephemeral cache = ~5 minute TTL. Plenty for a conversation;
          // re-cached on the next turn within the window.
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: args.dynamicSystemBlock,
        },
      ],
      tools: args.tools,
      messages: args.messages,
    });
  }
}
