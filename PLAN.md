# Picnic Assistant — Implementation Plan

**Overall Progress:** 80% (8/10 steps complete; Step 9 artefacts ready for deployment)

**TLDR:** Build a Dutch-speaking Telegram bot that proposes a weekly Picnic grocery cart for Jeroen + partner based on purchase history, Picnic recipes, and a household profile. Runs 24/7 on a small EU VPS. All-in cost ~€7–13/month on top of any existing Claude Pro subscription (the bot uses the Anthropic API, billed separately from Pro).

---

## Critical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Picnic integration | **MRVDH `picnic-api` v4 directly** (no sidecar) | Step 2a investigation found `setDeliverySlot` is already exposed by MRVDH v4 — `mcp-picnic` wraps the same library, so the sidecar added complexity without unique capability. See `docs/decision-step2.md`. |
| Runtime language | TypeScript (Node.js) | Forced by wrapper choice; Anthropic TS SDK is solid |
| LLM | Claude Sonnet (current) via **Anthropic API** (separate from Claude Pro), prompt caching on, single-model for v1 | Best Dutch + tool reliability; API is mandatory because Pro has no programmatic interface |
| Persistence | SQLite (single file) | Zero-ops, easy to back up |
| Household profile | Plain editable Markdown file alongside SQLite | Human-readable; user can SSH-edit |
| Hosting | Hetzner CX23 (or CAX11 ARM), EU region (~€5/mo) | EU-hosted, reputable, predictable. CX22 was the previous name; Hetzner renamed the line. |
| User interface | Telegram bot in a group chat (Jeroen + partner + bot) | Free, identity-aware, cross-platform |
| Language & tone | Dutch only, informal "je"-form, plain, no filler/emojis, asks when uncertain | Household chat, project preference for plain language |
| Cart automation | **Level B + Level C**: bot builds cart in Picnic AND reserves a delivery slot at commit time. User pays/confirms in Picnic app. | `setDeliverySlot` is available in MRVDH v4, so Level C costs nothing extra |
| Commit mode | **Hybrid (b′)**: weekly draft → atomic commit on approval; ad-hoc "voeg X toe" → live commit | Atomic safety for big decisions; no friction for single adds |
| Context strategy | **Layered**: profile + rolling purchase summary + last ~8 orders in system prompt; `search_order_history` tool for deeper digs | Small cacheable prompt; deeper history on demand |
| Bootstrap | **Backfill 6 months** of Picnic history on first login + interactive Dutch onboarding for `profile.md` | Useful from day 1, not week 4 |
| Re-auth flow | **Telegram-based**: bot DMs the group when token expires, user replies with `/sms` to trigger SMS, then sends the 6-digit code | Preserves "always reachable from phone" goal |
| Weekly nudge | Thursday 20:00 Europe/Amsterdam | Per requirements |
| Identity | Distinguish Jeroen vs partner via Telegram user ID | Per requirements |
| Price logic | **Price-blind**; brand preferences live in `profile.md` (e.g. "default to huismerk", "pindakaas: altijd Calvé") | User has budget context; Picnic shows prices at review |
| Cost runaway guards | 15 tool calls/turn cap; ~30k token conversation cap (older turns summarised); €2/day API spend kill-switch; no auto-retries on API errors | Bounds worst-case bill |
| Monitoring | **Self-reporting to Telegram**: bot posts in group when Picnic or Anthropic is unreachable, or when repeated failures occur | Same surface as normal use |
| Kill switches | `/stop`, `/start`, `/status` in Telegram (state in SQLite, survives reboots) + `systemctl stop` as nuclear via SSH | Phone-first; SSH stays available |

---

## Privacy & Security Posture

Three categories of personal data live on the VPS:

- ⚠️ **Picnic credentials / auth token** — `.env`, mode `0600`, never in git, never logged. Long-lived token only (no plaintext password after first 2FA). Re-auth via Telegram `/sms` flow.
- ⚠️ **Order history & cart contents** — local SQLite only. Sent to Anthropic only as the slice needed for the current decision.
- ⚠️ **Household profile** — plain Markdown file on VPS; same protection level as credentials.

Baseline VPS hardening (Step 9) applies to all three.

---

## Tasks

### Step 1 — Project scaffolding ✅
🟩 Initialise Node.js + TypeScript project (`npm init`, `tsconfig.json`) — used npm instead of pnpm because pnpm wasn't installed; npm is bundled with Node and avoids an extra install
🟩 Set up linter + formatter (eslint flat config + prettier, light)
🟩 Create folder structure: `src/picnic/`, `src/agent/`, `src/memory/`, `src/telegram/`, `src/scheduler/` (with `.gitkeep` placeholders)
🟩 Set up `.env.example` and `.gitignore` (block `.env`, `*.db`, `profile.md`)
🟩 Add `README.md` with what-this-is, prereqs, local-dev commands, and branching policy
🟩 Smoke tests pass: `npm run check`, `npm run lint`, `npm run format:check`, `npx tsx src/index.ts`

### Step 2 — Picnic adapter layer ⚠️ PRIVACY (credentials)

**Step 2a — Integration investigation (done)**
🟩 Checked `ivo-toby/mcp-picnic`: wraps MRVDH `picnic-api@^4.0.0`; doesn't avoid that dependency
🟩 Verified MRVDH v4 exposes `setDeliverySlot(slotId)` as a public method on `CartService` (confirmed via source read of `src/domains/cart/service.ts`)
🟩 Decision recorded in `docs/decision-step2.md`: **MRVDH direct, no sidecar; Level C included in v1**
🟩 Plan's Critical Decisions table updated

**Step 2b — PicnicClient implementation** ✅
🟩 Add `picnic-api@4.4.0` dependency, pinned exact (note: the *actual* method names from the v4 type defs are `verify2FACode` not `verify2FA`, and order history is `delivery.getDeliveries(filter)` not a separate `getOrderHistory`)
🟩 Write `src/picnic/client.ts` — thin `PicnicClient` wrapping `login` (incl. 2FA), `getDeliveries`, `searchProducts`, `getRecipesPage`, `addProductToCart`, `removeProductFromCart`, `getCart`, `getDeliverySlots`, **`setDeliverySlot`** (Level C)
🟩 Honour `DRY_RUN`: all write methods are `Promise<void>` no-ops with a structured log line; reads always pass through
🟩 Implement 2FA login flow: detect `second_factor_authentication_required`, request SMS via `auth.generate2FACode("SMS")`, verify via `auth.verify2FACode(code)`
🟩 Persist long-lived token to `DATA_DIR/picnic-session.json` after first 2FA via atomic write (`writeFile` → `rename`); file perms `0600` (best-effort chmod on Windows, mandatory on Linux)
🟩 Detect expired-token responses and emit `AuthRequiredError` (heuristic on `401`/`unauthorized` in error message, plus `response.status`)
🟩 `safeLog` helper redacts `password`, `authKey`, `token`, `code`, `otp`, `secret` even if a caller accidentally passes them
🟩 `src/picnic/index.ts` is the single import surface for downstream code
🟩 Manual smoke test passed: `npm run smoke:picnic` against Jeroen's real account; 2FA round-tripped via SMS; **234 completed deliveries** returned; session persisted; no credentials in logs. Most recent delivery's top-level keys: `delivery_id, creation_time, slot, eta2, status, delivery_time, orders` (informs Step 3 schema).

**Step 2c — interface boundary** 🟩
🟩 Downstream code talks to Picnic only via `src/picnic/index.ts`; `picnic-api` is not imported anywhere outside `src/picnic/client.ts`. Verified by file inspection.

### Step 3 — Memory store ✅
🟩 SQLite via `better-sqlite3@12.10.0` (prebuilt Windows + Linux binaries). Schema in `src/memory/db.ts` is idempotent (`CREATE TABLE IF NOT EXISTS`), uses WAL mode and foreign keys.
🟩 Tables: `orders`, `order_items`, `products_seen`, `suggestion_log` (kept for v2 diff observation), `chat_turns`, `draft_cart`, `api_spend_daily`, `meta` (small key/value store for flags like `bootstrap_completed`)
🟩 Repository in `src/memory/repository.ts`: `recordOrder`, `getRecentOrders`, `searchOrderHistory`, `logSuggestion`, `getLatestSuggestion`, `upsertDraftCart`/`getDraftCart`/`clearDraftCart`, `recordApiSpend`/`getTodayApiSpend`, `getMeta`/`setMeta`, `appendChatTurn`. Money as integer cents; timestamps as ISO 8601.
🟩 Bootstrap in `src/memory/bootstrap.ts`: pulls last 6 months of completed deliveries, calls `getDelivery(id)` per delivery, flattens `OrderLine.items[]` (count-by-repetition) into `(article_id, quantity)` rows. Idempotent (gated by `meta.bootstrap_completed`); polite (default 250ms throttle); resumable on partial failure.
🟩 Purchase summary in `src/memory/summary.ts`: typical basket (top-N by order count + avg quantity per order), avg interval days between deliveries, last order timestamp. Stored under `meta.purchase_summary_json`. Recomputed at the end of bootstrap; will be recomputed after every new order in Step 8.
🟩 Daily local backup in `src/memory/backup.ts`: uses `better-sqlite3`'s online `db.backup()` for crash-safe snapshots; default retention 14 files; cron wiring is Step 7's job.
🟩 Public surface in `src/memory/index.ts`; nothing outside `src/memory/` touches SQL directly.
🟩 Manual smoke test (Jeroen) passed: bootstrap ran, summary computed, backup written, top-10 basket recognisable.

### Step 4 — Household profile ⚠️ PRIVACY (preferences) ✅
🟩 Profile structure defined (`Preferences` / `Dislikes` / `Brands` / `Patterns`); seed template inlined in `src/memory/profile.ts`; default brand rules included (huismerk-by-default, Calvé for pindakaas)
🟩 `loadProfile(path)` reads fresh on every call (no caching) — picks up your SSH edits automatically on next conversation
🟩 `atomicWriteProfile(path, content)` uses `writeFile → rename` pattern; `0600` perms (best-effort on Windows, mandatory on Linux); a crash mid-write leaves the old file intact
🟩 `appendToProfileSection(path, section, bullet)` is the *mechanism* for "propose addition": agent calls this only after user approves
🟩 `ensureProfileSeeded(path)` is idempotent: creates the file from the template on first run, no-op if it already exists
🟩 Public surface added to `src/memory/index.ts` — no downstream code touches the file directly
🟩 Runtime smoke check (against a temp file): seeding is idempotent, append-to-existing-section works, append-to-missing-section creates the section, all behaviour matches design
→ **Interactive Dutch onboarding moved to Step 6** — it's a Telegram-driven flow that requires the agent loop + bot to exist. The mechanism (`appendToProfileSection`) ships here; the policy ("ask these 5 questions") lives in Step 6.

### Step 5 — Claude agent core ✅
🟩 `@anthropic-ai/sdk@0.100.1` installed; configurable model via `ANTHROPIC_MODEL` env (default `claude-sonnet-4-5-20250929`)
🟩 `src/agent/prompt.ts`: Dutch system prompt builder. Static block (role, tone, hybrid-mode rules, profile-handling rules, recipe rules, household profile, purchase summary) is cache-eligible; dynamic block (today's date/day in Europe/Amsterdam, current speaker, last 8 orders) is per-turn.
🟩 `src/agent/tools.ts`: 12 tools defined and wired — `search_picnic_products`, `get_cart`, `get_recent_orders`, `search_order_history`, `fetch_recipe_url`, `add_to_draft`, `remove_from_draft`, `show_draft`, `commit_draft_to_cart`, `add_to_cart_now`, `propose_profile_addition`, `commit_profile_addition`. Profile additions are split propose/commit so the agent must wait for explicit approval before writing.
🟩 Hybrid b′ logic encoded in the system prompt with explicit "ask if unclear" rule.
🟩 `src/agent/recipes.ts`: JSON-LD Recipe extractor (schema.org). LLM-fallback intentionally deferred to v2; failure returns a "vraag de ingrediënten" note so the always-show rule still works.
🟩 `src/agent/loop.ts`: agent loop with tool-call execution, conversation-history accumulation, cache-aware system prompt delivery via `AgentAnthropicClient`.
🟩 `src/agent/guards.ts`: tool-call cap (15/turn), daily spend kill-switch (`assertWithinDailySpendCap` + `recordCallCost` with EUR estimates from Anthropic usage tokens), rough token estimator. Conversation token guard wired into the loop as "drop oldest half when over 30k tokens."
🟩 No auto-retries on API errors; first failure throws.
🟩 Prompt caching on: static system block tagged `cache_control: ephemeral`.
🟩 Public surface via `src/agent/index.ts`; static checks (tsc, eslint, prettier) all clean.
🟩 Manual smoke (Jeroen) passed: 21-item weekly draft (€0.10), commit on approval (€0.12), ad-hoc add (€0.02), profile dedup-recognition (trivial). Total ~€0.27 across 4 turns; well within €2/day cap.

### Step 6 — Telegram interface ✅
🟩 `telegraf@4.16.3` installed; bot token via `TELEGRAM_BOT_TOKEN`
🟩 Allowed-chat restriction via middleware: `meta.telegram_allowed_chat_id` (set by `/setchat`) takes precedence over the env var; strangers ignored silently; unset state prompts the user with `/chatid` then `/setchat`
🟩 Identity: `ctx.from.first_name` passed into `AgentLoop.runTurn(speakerName)`; agent's system prompt already injects "wie er nu praat"
🟩 Free-text messages routed to the agent loop; replies chunked when over 4096 chars (paragraph-aware split, hard-wrap fallback)
🟩 `/sms` re-auth flow: per-chat state machine (`idle` ↔ `awaiting-sms-code`); a 6-digit message during the awaiting phase auto-verifies; bot posts `AUTH_REQUIRED_PROMPT` when the agent throws `AuthRequiredError`
🟩 Interactive Dutch onboarding (moved from Step 4): single welcome message on first message in the chat, gated by `meta.onboarding_completed`. The agent's `propose_profile_addition` flow drives the actual learning — no 5-step state machine.
🟩 `/start`, `/stop`, `/status`, `/reset` commands; running flag persisted in SQLite so `/stop` survives a deploy
🟩 Self-reporting: `DailySpendCapExceededError`, `IterationCapExceededError`, and unknown errors all surface as Dutch chat messages instead of crashing the process
🟩 `npm run start:telegram` (`src/telegram/run.ts`) boots the full runtime; graceful SIGINT/SIGTERM shutdown
🟩 Manual smoke (Jeroen) passed: `/chatid` + `/setchat` wiring worked, onboarding welcome landed on first message, ad-hoc adds round-tripped (DRY_RUN logs confirmed), `/status` printed correctly. One transient `TimeoutError` on a `ctx.reply` (Telegram API took >90s) — gracefully handled by the error path and the bot recovered. Documented as a known operational reality, not a code defect.

### Step 7 — Scheduler ✅ (smoke passed)
🟩 `croner@10.0.1` instead of `node-cron` — zero deps, built-in TS types, no audit warnings. Same cron pattern API.
🟩 `src/scheduler/cron.ts`: Thursday 20:00 Europe/Amsterdam (`0 20 * * 4`) → posts the nudge into the configured chat. DST handled by the library.
🟩 Skips when `/stop` is active (the cron fires but `fireWeeklyNudge` checks `isBotRunning` and no-ops if paused). Skips when no allowed chat id is configured.
🟩 Logs `nextRun` ISO timestamp at startup so it's obvious in the logs when the next fire is.
🟩 Wired into `src/telegram/run.ts` — same process as the bot; stopped on SIGINT/SIGTERM.
🟩 `/nudge_now` operator command added so the cron-firing path can be exercised without waiting for Thursday.

### Step 8 — Weekly recap (lightweight learning) ✅
🟩 Recap question appended to the weekly nudge in `buildWeeklyNudge` ("Hoe ging de bestelling van vorige week? Moet ik iets onthouden voor de volgende keer?")
🟩 Replies flow through the normal agent loop — the existing `propose_profile_addition` tool covers the "remember this" path agreed in grilling.
🟩 Active diff observation remains v2 backlog.

### Step 9 — VPS deployment ⚠️ PRIVACY (everything lives here) 🟨
🟩 `deploy/setup-vps.sh`: one-time root-on-fresh-VPS script. Creates non-root user with sudo, copies SSH key, disables root SSH + password auth (with both `sshd_config` and `sshd_config.d/*.conf` overrides), UFW firewall (SSH only), Node.js 22 from NodeSource, `unattended-upgrades`. Idempotent.
🟩 `deploy/install-bot.sh`: as-jeroen script. Git clone (or pull if existing), `npm ci`, seed `.env` from `.env.example` with `0600`, create `data/` with `0700`, install systemd unit with `__USER__` placeholder substitution. Enables but does NOT start the service.
🟩 `deploy/update.sh`: future-deploy script. Refuses to run with uncommitted changes, ff-only pull from `main`, conditional `npm ci` only if `package-lock.json` changed, `systemctl restart`, tails the last 20 log lines.
🟩 `deploy/picnic-assistant.service`: systemd unit. `User=__USER__`, `EnvironmentFile=.env`, `Restart=always`, `RestartSec=10`. Mild hardening: `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome=read-only` with `ReadWritePaths=data/`.
🟩 `docs/RUNBOOK.md`: full operator manual — first-time deploy (Hetzner provisioning, SSH key gen, setup → install → env → smoke → start), reading logs (`journalctl -u picnic-assistant -f`), routine ops (update, password rotation), kill switches (soft `/stop` → systemd → token revoke), troubleshooting (`AuthRequiredError`, spend cap, disk full, crash-loops), and a file-locations table.
🟩 Logging: bot writes to stdout/stderr → captured by systemd journal. No file logging in v1 (journal handles rotation). `safeLog` redaction from Step 2 ensures credentials never appear.
🟥 **Actually deploy**: run `setup-vps.sh` then `install-bot.sh` on a fresh Hetzner VPS, fill `.env`, run `smoke:picnic` once for auth, start the service, wire Telegram chat. Walked through in the next turns.

### Step 10 — First-run validation
🟥 First-run sequence: fresh deploy → first `/start` triggers Picnic login + 2FA → backfill 6 months of orders → run onboarding → seed `profile.md` → ready
🟥 Run one full cycle: Thursday nudge fires → bot drafts cart → human reviews in Picnic → order placed → next nudge incl. recap
🟥 Sanity-check Anthropic API cost after week 1; tune prompt size if needed
🟥 Confirm credentials never appear in logs or git
🟥 Walk through `/sms` re-auth flow at least once
🟥 Walk through `/stop` + `/start` + `/status` from phone at least once

---

## v2 Backlog (designed, not built)

### Active diff observation
**Goal:** bot automatically notices when you removed/added/changed items between its suggestion and the final order, and asks if it should remember anything from that.

**Mechanism:**
- **Polling cadence:** lazy-check on user interaction + once-a-day cron at 23:00 (after Picnic's pre-delivery edit cut-off).
- **Matching:** when a new order with `delivery_date` is detected, find the most recent `suggestion_log` entry within the past 14 days. If found, diff against that. If not, log silently.
- **Timing:** only diff orders whose edit cut-off has passed. Editable orders ignored until next day's check.
- **Surface rule:** at most 1–2 deltas per recap, only the kind that *suggest a preference*. Trivial diffs ignored.
- **Cold-start caveat:** first 2–3 weeks of data are noisy. Phrase as questions, not learnings.

**Why deferred:** data model (`suggestion_log`) is in v1; adding diff is ~1 day later. Waiting lets us tune on real data.

### ~~Slot reservation (Level C)~~ — moved to v1
Step 2a investigation found `setDeliverySlot` is exposed by MRVDH v4. Now part of v1 scope. See `docs/decision-step2.md`.

### Cheap-call routing to Haiku
After 1–2 months of usage, identify which calls are trivial enough for Haiku.

### Vendor-managed secrets
Move from `.env` to Doppler/Infisical free tier.

### Off-VPS backups
Encrypted SQLite snapshots to a cheap object store (e.g. Backblaze B2).

### Budget cap / price awareness
Optional weekly budget with warnings. Skipped in v1 because Picnic shows prices at review and brand rules in profile already cover most preferences.

### File-locking for profile.md
Real lock to handle the rare case where the user is SSH-editing at the exact moment the bot writes. Current design accepts this race.

### External uptime monitoring
Healthchecks.io or Uptime Kuma. Skipped because in-band self-reporting covers most cases.

---

## Out of Scope (v1)

- ❌ Full auto-checkout (Level D)
- ~~Level C slot reservation~~ → in v1 (free with MRVDH v4)
- ❌ Active diff observation (v2 — weekly recap stays in v1)
- ❌ Smart proactive nudges beyond the single weekly cron
- ❌ Model fine-tuning / RAG / vector search
- ❌ Mixed-model routing (Sonnet + Haiku)
- ❌ Vendor-managed secrets
- ❌ Multi-account Picnic
- ❌ English / multilingual UI
- ❌ Mobile app
- ❌ Off-VPS backups
- ❌ Reliability guarantees for arbitrary recipe URLs (best-effort + always-show)
- ❌ Price/budget logic (brand preferences via profile only)
- ❌ External uptime monitoring
- ❌ File-lock on `profile.md`
