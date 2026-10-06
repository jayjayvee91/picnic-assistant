/**
 * Where did the Anthropic money go? Reads `api_call_log` and prints, per
 * conversation, the number of steps, the cost and how much was served from
 * cache — then which tools produced the most text, since every later step
 * re-sends it.
 *
 * Run with (on the VPS, against the live database):
 *   npm run report:cost
 *   npm run report:cost -- --days=14
 *
 * Read-only; costs nothing.
 */

import 'dotenv/config';
import { join } from 'node:path';

import { openDatabase, getApiCallLog, type ApiCallLogEntry } from '../memory/index.js';
import { CONVERSATION_IDLE_RESET_MS } from '../telegram/state.js';

const daysArg = process.argv.find((a) => a.startsWith('--days='));
const days = daysArg ? Number(daysArg.slice('--days='.length)) : 7;
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const dataDir = process.env['DATA_DIR'] ?? './data';
const db = openDatabase(join(dataDir, 'data.db'));
const log = getApiCallLog(db, { since });

if (log.length === 0) {
  console.log(`No Claude calls logged in the last ${days} days.`);
  process.exit(0);
}

// Same boundary the bot uses: 4 hours of silence starts a new conversation.
const conversations: ApiCallLogEntry[][] = [];
for (const entry of log) {
  const current = conversations.at(-1);
  const last = current?.at(-1);
  const gap = last ? Date.parse(entry.createdAt) - Date.parse(last.createdAt) : Infinity;
  if (!current || gap >= CONVERSATION_IDLE_RESET_MS) conversations.push([entry]);
  else current.push(entry);
}

const eur = (n: number) => `€${n.toFixed(2)}`;

console.log(`Conversations in the last ${days} days\n`);
console.log('started (UTC)       steps    cost   cached input');
for (const c of conversations) {
  const cost = c.reduce((s, e) => s + e.costEur, 0);
  const input = c.reduce((s, e) => s + e.inputTokens + e.cacheWriteTokens + e.cacheReadTokens, 0);
  const cached = c.reduce((s, e) => s + e.cacheReadTokens, 0);
  const pct = input > 0 ? Math.round((cached / input) * 100) : 0;
  console.log(
    `${c[0]!.createdAt.slice(0, 16).replace('T', ' ')}  ${String(c.length).padStart(6)}  ` +
      `${eur(cost).padStart(6)}   ${String(pct).padStart(3)}%`,
  );
}

const byTool = new Map<string, { calls: number; chars: number }>();
for (const e of log) {
  // A step's result size is shared by the tools it called together.
  for (const name of e.tools) {
    const t = byTool.get(name) ?? { calls: 0, chars: 0 };
    t.calls += 1;
    t.chars += e.toolResultChars / e.tools.length;
    byTool.set(name, t);
  }
}

console.log('\nTools by text produced (re-sent on every later step)\n');
console.log('tool                            calls   chars/call   total chars');
for (const [name, t] of [...byTool].sort((a, b) => b[1].chars - a[1].chars)) {
  console.log(
    `${name.padEnd(30)}  ${String(t.calls).padStart(5)}   ${String(Math.round(t.chars / t.calls)).padStart(10)}   ` +
      `${String(Math.round(t.chars)).padStart(11)}`,
  );
}

const total = log.reduce((s, e) => s + e.costEur, 0);
console.log(`\nTotal: ${eur(total)} over ${log.length} steps.`);
