# picnic-assistant

A Dutch-speaking Telegram bot that drafts weekly Picnic grocery orders, based on purchase history,
favourited Picnic recipes, and a household preferences profile. Reachable from your phone via
Telegram, runs 24/7 on a small EU VPS.

See [`PLAN.md`](./PLAN.md) for the full implementation plan and decision rationale.

## Status

Pre-alpha. Scaffolding only — not functional yet. Track progress in `PLAN.md`.

## Prerequisites

- Node.js >= 22 (current LTS recommended)
- A Picnic account (NL)
- An Anthropic API key (separate from any Claude Pro subscription)
- A Telegram bot token (via [@BotFather](https://t.me/botfather))

## Local development

```bash
# Install dependencies
npm install

# Activate the pre-commit hook that blocks accidental secret commits.
# One-time per clone. See .githooks/pre-commit for what it checks.
npm run setup-hooks

# Copy and fill in environment variables
cp .env.example .env
# edit .env

# Run the bot in watch mode (re-runs on file change)
npm run dev

# Type-check without building
npm run check

# Lint and format
npm run lint
npm run format
```

While `DRY_RUN=true` is set in `.env`, the bot runs the full loop but never writes to your Picnic
cart. Use this for everyday local development.

## Branching

- **`main`** — what's deployed to the VPS. Never push directly. Promote from `develop` only when
  ready to ship.
- **`develop`** — default branch. Feature work branches off here and merges back via PR.
- **`step-N-…`** — short-lived feature branches, one per implementation step in `PLAN.md`.

GitHub branch protection isn't enabled (requires Pro for private repos), so the rule above is
enforced by self-discipline. If you ever push directly to `main` by accident, revert and
re-promote from `develop`.

## Project structure

```
src/
├── agent/       Claude agent loop, tool definitions, prompt assembly
├── allergen/    Gluten guard: rulebook, decision engine, audit log
├── memory/      SQLite store, household profile, purchase summary
├── picnic/      Picnic API adapter (decided in Step 2: MRVDH direct or mcp-picnic sidecar)
├── scheduler/   Weekly Thursday 20:00 nudge
└── telegram/    Telegram bot, group chat restriction, /sms /stop /start /status commands
```

## Gluten guard (coeliac safety)

Someone in the household has coeliac disease, so **no product containing gluten
— or possible traces — may reach the cart.** This is enforced in code, not by
asking the model to remember: `src/allergen/guard.ts` checks every article on
every path into the draft or the cart (`add_to_draft`, `add_to_cart_now`,
`commit_draft_to_cart`). The model cannot skip it.

**Three verdicts.** `blocked` never enters the cart. `allowed` is positively
verified. `unverified` means the data was missing or unclear — the item is still
added (the household's chosen policy) but flagged by name, never silently.
Anything unknown fails toward caution: a failed fetch, an upstream parser break,
or an empty allergen list all yield `unverified`, never `allowed`.

**It is not a black box.** Every term that can block a product lives in
`DATA_DIR/gluten-rules.md`, which you edit directly — sections `Bevat gluten`
(blocks), `Twijfel` (flags), `Veilig` (prevents false matches), and
`Voorbeelden` (your own notes). Every decision is recorded with the raw allergen
and ingredient data it saw; read it back with `/glutenlog` in Telegram.

**Teaching it.** If a verdict was wrong, tell the bot in chat — it proposes a
rulebook line and appends it only after you approve (same discipline as profile
edits). Product-specific mistakes use an override instead, so a one-off
mislabelling doesn't become a general rule.

**Ordering gluten on purpose** (e.g. bread for a housemate who isn't coeliac)
is possible: acknowledge the gluten explicitly and the bot routes it through a
dedicated exception path, either once or standing. It is logged, labelled in the
cart, and the model can never take that route on its own initiative.

```bash
# Verify the guard offline — no Picnic session or API key needed
npm run smoke:allergen
```

The check depends on Picnic's product-detail data, whose upstream parser is
marked experimental. `npm run smoke:picnic` probes it against a real product so
a layout change upstream surfaces loudly rather than silently degrading every
product to `unverified`.

## Privacy

This bot handles personal data: Picnic credentials/session, purchase history, and household
preferences. All of it lives on a single VPS you control, in files that `.gitignore` excludes
from source control. See `PLAN.md` § "Privacy & Security Posture" for the full handling rules.

## License

Not yet decided. Treat as private code for now.
