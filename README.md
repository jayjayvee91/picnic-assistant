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
├── memory/      SQLite store, household profile, purchase summary
├── picnic/      Picnic API adapter (decided in Step 2: MRVDH direct or mcp-picnic sidecar)
├── scheduler/   Weekly Thursday 20:00 nudge
└── telegram/    Telegram bot, group chat restriction, /sms /stop /start /status commands
```

## Privacy

This bot handles personal data: Picnic credentials/session, purchase history, and household
preferences. All of it lives on a single VPS you control, in files that `.gitignore` excludes
from source control. See `PLAN.md` § "Privacy & Security Posture" for the full handling rules.

## License

Not yet decided. Treat as private code for now.
