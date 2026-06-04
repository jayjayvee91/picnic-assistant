#!/usr/bin/env bash
# Deploy a code update to the running bot.
#
# Usage:
#   bash deploy/update.sh
#
# What it does:
#   1. git fetch + ff-only pull from `main`. Refuses to update if you have
#      local changes (you should never edit code on the server).
#   2. Reinstalls dependencies if package-lock.json changed.
#   3. Restarts the systemd service.
#   4. Tails the last few log lines so you can see whether it came back up.
#
# Safe to run while the bot is processing a message — systemctl restart
# sends SIGTERM, the bot's graceful-shutdown handler completes any in-flight
# turn (within Telegraf's 90s timeout), then the new process starts.

set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n=== %s ===\n' "$1"; }

step "1. Checking working tree is clean"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: uncommitted changes in $(pwd). Resolve manually:" >&2
  git status --short >&2
  exit 1
fi

step "2. Pulling latest from main"
LOCK_BEFORE="$(sha256sum package-lock.json | awk '{print $1}')"
git fetch origin
git checkout main
git pull --ff-only origin main
LOCK_AFTER="$(sha256sum package-lock.json | awk '{print $1}')"

step "3. Installing dependencies (only if package-lock.json changed)"
if [[ "$LOCK_BEFORE" != "$LOCK_AFTER" ]]; then
  npm ci --no-audit --no-fund
else
  echo "package-lock.json unchanged, skipping npm ci."
fi

step "4. Restarting systemd service"
sudo systemctl restart picnic-assistant

step "5. Status + last 20 log lines"
sudo systemctl status picnic-assistant --no-pager --lines=0 || true
journalctl -u picnic-assistant --no-pager --lines=20

echo
echo "Update complete. Tail live logs with: journalctl -u picnic-assistant -f"
