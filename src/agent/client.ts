/**
 * Thin wrapper around the Anthropic SDK.
 *
 * Centralises:
 *   - Construction of the Anthropic client from env.
 *   - The cache layout: static `system` block tagged
 *     `cache_control: ephemeral`, plus a top-level marker that caches the
 *     conversation so far.
 *   - The `messages.create` call (no retries — per the cost-runaway design,
 *     a single API error should report and stop, not loop).
 *
 * Higher layers (the agent loop) build the `messages` array, this module
 * just delivers it.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages.mjs';

export interface AnthropicClientOptions {
  apiKey: string;
  model: string;
  /** Defaults to 4096 — high enough for a chunky tool-using reply. */
  maxTokens?: number;
  /** Stand-in for the SDK, so offline checks can see the exact request. */
  sdk?: Pick<Anthropic, 'messages'> | { messages: { create: MessagesCreate } };
}

type MessagesCreate = (params: MessageCreateParamsNonStreaming) => Promise<Message>;

export class AgentAnthropicClient {
  private readonly create: MessagesCreate;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicClientOptions) {
    const sdk = opts.sdk ?? new Anthropic({ apiKey: opts.apiKey });
    this.create = (params) => sdk.messages.create(params) as Promise<Message>;
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 4096;
  }

  /**
   * One Anthropic call. The `system` argument is the prompt produced by
   * `buildSystemPrompt`. Two cache breakpoints: one after the static block
   * (shared by every conversation) and one at the end of the request (this
   * conversation so far).
   */
  async send(args: {
    staticSystemBlock: string;
    dynamicSystemBlock: string;
    tools: Tool[];
    messages: MessageParam[];
  }): Promise<Message> {
    return await this.create({
      model: this.model,
      max_tokens: this.maxTokens,
      // Caches the whole request up to its last block, i.e. the conversation
      // so far. Each step of the tool loop re-sends everything before it, so
      // without this the growing conversation is paid at full price on every
      // step — the main reason one weekly shop used to cost €2+. The marker
      // moves forward each request; earlier entries are still hits.
      cache_control: { type: 'ephemeral' },
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
