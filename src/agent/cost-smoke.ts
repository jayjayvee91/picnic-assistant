/**
 * Offline checks for the API-cost measures in `docs/cost-plan.md`.
 *
 * Run with:
 *   npm run smoke:cost
 *
 * No network, no Picnic session, no API key — Claude is replaced by a fake
 * that returns canned responses and the database is `:memory:`, so this runs
 * in CI and costs nothing.
 *
 * Every measure here fails silently. A cache marker that goes missing, a
 * conversation that is never cleared, a log row that is never written: none of
 * them throws, the bot keeps answering, and the only symptom is a bill that is
 * quietly back to €3 a weekly shop. That is worth an assertion rather than
 * trust.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages.mjs';

import {
  openDatabase,
  upsertDraftCart,
  getDraftCart,
  getApiCallLog,
  recordApiSpend,
} from '../memory/index.js';
import { continueOrStartConversation } from '../telegram/state.js';
import { AgentAnthropicClient } from './client.js';
import { takeBudgetWarning } from './guards.js';
import { AgentLoop } from './loop.js';
import type { AgentContext } from './tools.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(detail ? `${name} — ${detail}` : name);
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A canned final reply, as Claude would send it. */
function textReply(text: string): Message {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'fake',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as Message;
}

/** Stands in for the Anthropic SDK and remembers every request it was sent. */
function fakeSdk(replies: Message[]) {
  const requests: MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    messages: {
      create: async (params: MessageCreateParamsNonStreaming): Promise<Message> => {
        // Snapshot: the loop keeps appending to the same messages array.
        requests.push({ ...params, messages: [...params.messages] });
        const next = replies.shift();
        if (!next) throw new Error('fake SDK ran out of replies');
        return next;
      },
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Caching — the conversation, not just the instructions
// ──────────────────────────────────────────────────────────────────────

{
  const sdk = fakeSdk([textReply('Hoi')]);
  const client = new AgentAnthropicClient({ apiKey: 'unused', model: 'fake', sdk });
  await client.send({
    staticSystemBlock: 'vaste instructies',
    dynamicSystemBlock: 'vandaag',
    tools: [],
    messages: [{ role: 'user', content: 'melk' }],
  });
  const req = sdk.requests[0];
  check(
    'every request asks Claude to cache the conversation so far',
    req?.cache_control?.type === 'ephemeral',
    JSON.stringify(req?.cache_control),
  );
}

// ──────────────────────────────────────────────────────────────────────
// Fresh conversation after 4 hours of silence
// ──────────────────────────────────────────────────────────────────────

{
  const CHAT = 4242;
  const t0 = new Date('2026-10-08T18:00:00Z');
  const minutes = (m: number) => new Date(t0.getTime() + m * 60_000);

  const first = continueOrStartConversation(CHAT, t0);
  first.history = [
    { role: 'user', content: 'melk en eieren graag' },
    { role: 'assistant', content: 'Staat erin.' },
  ];

  check(
    'a message within 4 hours continues the conversation',
    continueOrStartConversation(CHAT, minutes(3 * 60 + 59)).history.length === 2,
  );
  // The clock runs from the last message, not the first: a long weekly shop
  // with short pauses is one conversation.
  check(
    'the 4 hours count from the last message, not the first',
    continueOrStartConversation(CHAT, minutes(7 * 60)).history.length === 2,
  );
  continueOrStartConversation(CHAT, minutes(7 * 60)).spentEur = 0.42;
  const fresh = continueOrStartConversation(CHAT, minutes(11 * 60));
  check(
    'a message after 4+ hours of silence starts a fresh conversation',
    fresh.history.length === 0,
  );
  check(
    'a fresh conversation starts its cost count at zero',
    fresh.spentEur === 0 && fresh.steps === 0,
  );

  // The draft lives in SQLite under its own key; a fresh conversation must
  // never take the half-built basket with it.
  const db = openDatabase(':memory:');
  upsertDraftCart(db, 'telegram-main', [{ articleId: 's1', articleName: 'Melk', quantity: 1 }]);
  continueOrStartConversation(CHAT, minutes(30 * 60));
  check(
    'the saved draft survives a fresh conversation',
    getDraftCart(db, 'telegram-main')?.items.length === 1,
  );
}

// ──────────────────────────────────────────────────────────────────────
// Emergency brake — trims a runaway conversation, never a normal shop
// ──────────────────────────────────────────────────────────────────────

const profileDir = await mkdtemp(join(tmpdir(), 'cost-smoke-'));
const profilePath = join(profileDir, 'profile.md');
await writeFile(profilePath, '# Huishoudprofiel\n');

/** An agent loop on an in-memory database, talking to a fake Claude. */
function fakeAgent(replies: Message[], dailySpendLimitEur = 100) {
  const db = openDatabase(':memory:');
  const sdk = fakeSdk(replies);
  const agent = new AgentLoop({
    // A text-only turn touches nothing but the database and the profile.
    ctx: { db, profilePath, conversationKey: 'test' } as unknown as AgentContext,
    anthropic: new AgentAnthropicClient({ apiKey: 'unused', model: 'fake', sdk }),
    profilePath,
    dailySpendLimitEur,
  });
  return { db, sdk, agent };
}

/**
 * A conversation shaped like a real weekly shop: one household message, then
 * `steps` rounds of the bot searching Picnic and reading the results.
 */
function shopConversation(steps: number, resultChars: number): MessageParam[] {
  const history: MessageParam[] = [{ role: 'user', content: 'boodschappen voor deze week' }];
  for (let i = 0; i < steps; i++) {
    history.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name: 'search_picnic_products', input: {} }],
    });
    history.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(resultChars) }],
    });
  }
  history.push({ role: 'assistant', content: 'Je mandje staat klaar.' });
  return history;
}

{
  // ~40 steps with generous 4 KB results: well past the old 30k-token cap,
  // and an ordinary weekly shop.
  const normal = shopConversation(40, 4000);
  const { sdk, agent } = fakeAgent([textReply('Prima')]);
  await agent.runTurn({ userMessage: 'en nog wat kaas', speakerName: null, history: normal });
  check(
    'a normal-sized weekly shop is never cut short',
    sdk.requests[0]?.messages.length === normal.length + 1,
    `${sdk.requests[0]?.messages.length} of ${normal.length + 1} messages sent`,
  );
}

{
  // Five shops' worth in one conversation: a runaway, not a weekly shop.
  const runaway = [
    ...shopConversation(40, 4000),
    ...shopConversation(40, 4000),
    ...shopConversation(40, 4000),
    ...shopConversation(40, 4000),
    ...shopConversation(40, 4000),
  ];
  const { sdk, agent } = fakeAgent([textReply('Prima')]);
  await agent.runTurn({ userMessage: 'en nog wat kaas', speakerName: null, history: runaway });
  const sent = sdk.requests[0]?.messages ?? [];
  check(
    'a runaway-sized conversation is trimmed',
    sent.length < runaway.length + 1,
    `${sent.length} of ${runaway.length + 1} messages sent`,
  );
  // Cutting in the middle of a tool round would leave a tool result whose
  // request was dropped, which Claude rejects outright.
  check(
    'a trimmed conversation starts at a real household message',
    sent[0]?.role === 'user' && typeof sent[0]?.content === 'string',
    JSON.stringify(sent[0]).slice(0, 80),
  );
}

// ──────────────────────────────────────────────────────────────────────
// Step log — every Claude call, with its tokens, cost and tools
// ──────────────────────────────────────────────────────────────────────

{
  const toolStep = {
    ...textReply(''),
    content: [{ type: 'tool_use', id: 'tu1', name: 'get_recent_orders', input: { limit: 1 } }],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 1_000,
      output_tokens: 50,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 10_000,
    },
  } as unknown as Message;
  const { db, agent } = fakeAgent([toolStep, textReply('Je laatste bestelling was leeg.')]);
  await agent.runTurn({ userMessage: 'wat bestelde ik?', speakerName: null, history: [] });

  const log = getApiCallLog(db);
  check('every Claude call is recorded', log.length === 2, String(log.length));
  const step = log[0];
  check(
    'a step records all four kinds of tokens',
    step?.inputTokens === 1_000 &&
      step.outputTokens === 50 &&
      step.cacheWriteTokens === 2_000 &&
      step.cacheReadTokens === 10_000,
    JSON.stringify(step),
  );
  // Sonnet 4.5: $3 in, $15 out, $3.75 cache write, $0.30 cache read per
  // million tokens: 0.003 + 0.00075 + 0.0075 + 0.003 = $0.01425, at 0.92
  // EUR/USD = €0.01311.
  check(
    'a step records its cost in euros',
    Math.abs((step?.costEur ?? 0) - 0.01311) < 1e-9,
    String(step?.costEur),
  );
  check(
    'a step records which tools it asked for',
    step?.tools.join(',') === 'get_recent_orders',
    step?.tools.join(','),
  );
  check(
    'a step records how big its tool results were',
    (step?.toolResultChars ?? 0) > 0,
    String(step?.toolResultChars),
  );
  check('the final reply asks for no tools', log[1]?.tools.length === 0);
}

// ──────────────────────────────────────────────────────────────────────
// Budget warning — once per day, at 75% of the limit
// ──────────────────────────────────────────────────────────────────────

{
  const db = openDatabase(':memory:');
  const day1 = new Date('2026-10-08T17:00:00Z');
  const day1Later = new Date('2026-10-08T19:00:00Z');
  const day2 = new Date('2026-10-09T17:00:00Z');

  recordApiSpend(db, 1.4, day1);
  check('below 75% of the limit there is no warning', takeBudgetWarning(db, 2, day1) === null);

  recordApiSpend(db, 0.2, day1); // €1.60 of €2.00
  const warning = takeBudgetWarning(db, 2, day1);
  check('crossing 75% of the limit produces a warning', warning !== null);
  check(
    'the warning says how much is spent and what the limit is',
    !!warning && warning.includes('1,60') && warning.includes('2,00'),
    warning ?? 'null',
  );

  recordApiSpend(db, 0.1, day1Later);
  check(
    'the warning comes once per day, not once per message',
    takeBudgetWarning(db, 2, day1Later) === null,
  );

  recordApiSpend(db, 1.6, day2);
  check('a new day can warn again', takeBudgetWarning(db, 2, day2) !== null);
}

// ──────────────────────────────────────────────────────────────────────

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) FAILED, ${passed} passed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`All ${passed} cost checks passed.`);
