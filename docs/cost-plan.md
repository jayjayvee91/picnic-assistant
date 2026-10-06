# API cost plan

**Status:** agreed 2026-10-06, step 1 in progress.

**Problem:** a single weekly shop costs more than the €2/day API limit, so the
limit was raised to €5. That is a workaround, not a fix.

**Goal:** a weekly shop costs **€0.50–€1.00**, without making the bot less
smart and without changing how the household shops with it.

Terms (weekly shop, conversation, long-term memory) are defined in
[`CONTEXT.md`](../CONTEXT.md).

---

## Why it is expensive

Every time the bot "thinks" it sends Claude the whole conversation so far.
Building a 15–20 item shop takes ~30–40 of those steps, and each step re-sends
everything before it, so cost snowballs. Three things made it worse:

1. Only the fixed instructions were cached (charged at ~10% of normal). The
   growing conversation was paid at full price on every step.
2. The conversation was never cleared by itself (only `/reset` or a restart),
   so last week's chat, including old search results, was re-sent too.
3. When the conversation got long, the bot dropped its older half. That
   forgets recent context *and* breaks the cache, so the next step is full
   price again.

We also only recorded one spend total per day, so there was no way to see which
step or tool cost the most.

---

## Step 1: cut the waste (current model, Sonnet 4.5)

| # | Change | Why |
|---|---|---|
| 1 | Cache the conversation, not just the instructions | Re-sent text costs ~10% instead of 100% |
| 2 | Start a fresh conversation after **4 hours of silence** | No snowball from earlier shops; long-term knowledge comes from profile, order history and gluten decisions. The draft is stored separately and survives. `/reset` still works by hand. |
| 3 | Raise the "drop older half" limit so it is only an emergency brake | With caching a long conversation is cheap; dropping half breaks the cache and loses context |
| 4 | Log the cost of every step, including which tools were called | Find out what actually costs money instead of guessing |
| 5 | Telegram warning when today's spend passes 75% of the limit | No surprise stops halfway through a shop |

Then, on the server: set `DAILY_SPEND_LIMIT_EUR` back to **2.00** (it is 5.00
now). The bot runs on the VPS; changing the laptop `.env` does nothing.

**Measure:** do one real weekly shop, then compare its cost and per-step log
with today. If one tool's results turn out to dominate, slim that tool's output
next (search results are already slim).

## Step 2: upgrade the model

Switch to **Sonnet 5.5**, mainly for quality: it is newer and smarter at about
the same real cost. List price is a third lower, but it counts the same text as
~30% more tokens and "thinks" by default (billed), so expect ~10–15% saving at
best, and only if thinking is tuned down. Do this *after* step 1 so the two
effects can be told apart. Compare one weekly shop against step 1, paying
particular attention to gluten checks. Update the prices in
`src/agent/guards.ts` at the same time.

## Parked (revisit only if steps 1–2 are not enough)

- **Cheaper model (Haiku) or a cheap+smart pair.** Ruled out for now: no
  compromise on judgement, especially for gluten.
- **Bigger tools** (e.g. look up several items in one step). Only if the logs
  show the number of steps is still the main cost.
- **Plain-code staples** (add recurring items without Claude). Would change how
  the household shops.

## Ruled out

- **Batch processing** (half price, slow). The only scheduled job is the
  Thursday nudge, which does not use Claude.

## Budget rule

The daily limit stays as a **safety net against runaway bugs**, not as the
normal-use budget: back to €2/day, with a warning at 75%.
