#!/usr/bin/env bash
# Install the Picnic Assistant on a prepared VPS.
#
# Pre-conditions: `setup-vps.sh` has been run, you are now SSH'd in as the
# non-root user (default: jeroen), Node 22 is available.
#
# What it does:
#   1. Clones the repo into ~/picnic-assistant (or pulls if it exists).
#   2. Installs npm dependencies.
#   3. If `.env` doesn't exist, copies `.env.example` and tells you to fill it.
#   4. Creates the data/ directory.
#   5. Installs the systemd unit (sudo) and enables it on boot.
#   6. Does NOT start the bot — you start it manually after filling .env and
#      after running `npm run smoke:picnic` once to seed the Picnic session.
#
# Idempotent. Safe to re-run after editing the systemd unit.
#
# Usage:
#   bash <(curl -sSL https://raw.githubusercontent.com/jayjayvee91/picnic-assistant/main/deploy/install-bot.sh)

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/jayjayvee91/picnic-assistant.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/picnic-assistant}"
BRANCH="${BRANCH:-main}"

step() { printf '\n=== %s ===\n' "$1"; }

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Don't run this as root. Log in as your non-root user first." >&2
  exit 1
fi

step "1. Fetching the code at $INSTALL_DIR (branch: $BRANCH)"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  cd "$INSTALL_DIR"
  git fetch origin
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

step "2. Installing npm dependencies"
npm ci --no-audit --no-fund

step "3. Preparing .env"
if [[ -f .env ]]; then
  echo ".env already exists, leaving it alone."
else
  cp .env.example .env
  chmod 0600 .env
  cat <<MSG
Created .env from .env.example with permissions 0600.
You must fill it in now:
  nano $INSTALL_DIR/.env
Required values: PICNIC_USERNAME, PICNIC_PASSWORD, ANTHROPIC_API_KEY,
TELEGRAM_BOT_TOKEN. Leave DRY_RUN=true for the first runs.
MSG
fi

step "4. Creating data directory"
mkdir -p "$INSTALL_DIR/data"
chmod 0700 "$INSTALL_DIR/data"

step "5. Installing systemd unit"
SERVICE_SRC="$INSTALL_DIR/deploy/picnic-assistant.service"
SERVICE_DST="/etc/systemd/system/picnic-assistant.service"
USERNAME="$(id -un)"
# Substitute the __USER__ placeholder with the current username before installing.
sudo bash -c "sed 's|__USER__|$USERNAME|g' '$SERVICE_SRC' > '$SERVICE_DST'"
sudo chmod 0644 "$SERVICE_DST"
sudo systemctl daemon-reload
sudo systemctl enable picnic-assistant

cat <<EOF

==========================================================================
Install complete.

Before starting the bot:
  1. Edit the .env file (if you haven't yet): nano $INSTALL_DIR/.env
  2. Authenticate Picnic ONCE so the long-lived token is saved:
       cd $INSTALL_DIR && npm run smoke:picnic
     (You'll get an SMS code on your phone; type it into the terminal.)
  3. Verify Anthropic + agent work:
       npm run smoke:agent
     Try a couple of messages; Ctrl+C to exit.
  4. Start the bot under systemd:
       sudo systemctl start picnic-assistant
  5. Tail the logs to confirm it's healthy:
       journalctl -u picnic-assistant -f
  6. On your phone, send the bot /chatid then /setchat to register the chat.

To deploy code updates later:
  bash $INSTALL_DIR/deploy/update.sh

For everything else, see docs/RUNBOOK.md.
==========================================================================
EOF
