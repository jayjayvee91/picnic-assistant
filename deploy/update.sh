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
#   4. Waits 20s and fails (exit 1) if the bot crashed or isn't running.
#   5. Tails the last few log lines so you can see whether it came back up.
#
# Also run automatically by .github/workflows/deploy.yml on every push to
# `main`, through a deploy key that can run this script and nothing else.
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
# Without a terminal (the automatic deploy), git must never stop to ask for a
# username or token: fail at once instead of hanging until the job times out.
[[ -t 0 ]] || export GIT_TERMINAL_PROMPT=0
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
STARTED_AT="$(systemctl show picnic-assistant -p ActiveEnterTimestampMonotonic --value)"

step "5. Checking it stays up"
# Restart=always hides a crash: the unit goes back to "activating" and starts
# again 10s later, so "is it active right now" is not enough. If it is still
# active after the wait AND it is the same process run that started above,
# the new code survived startup.
sleep 20
NOW_STARTED_AT="$(systemctl show picnic-assistant -p ActiveEnterTimestampMonotonic --value)"
HEALTHY=true
if ! systemctl is-active --quiet picnic-assistant || [[ "$NOW_STARTED_AT" != "$STARTED_AT" ]]; then
  HEALTHY=false
fi

step "6. Status + last 20 log lines"
sudo systemctl status picnic-assistant --no-pager --lines=0 || true
journalctl -u picnic-assistant --no-pager --lines=20

if [[ "$HEALTHY" != true ]]; then
  echo
  echo "ERROR: the bot did not stay up after the restart. See the log lines above." >&2
  exit 1
fi

echo
echo "Update complete. Tail live logs with: journalctl -u picnic-assistant -f"
