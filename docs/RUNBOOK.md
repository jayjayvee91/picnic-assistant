# Picnic Assistant — Runbook

How to operate the bot in production. Written for **future-Jeroen**, who may have forgotten how everything works. Plain language, copy-pasteable commands.

## Quick reference

| Thing you want to do | Command |
|---|---|
| **Read live logs** | `journalctl -u picnic-assistant -f` |
| **Restart the bot** | `sudo systemctl restart picnic-assistant` |
| **Stop the bot (server-side)** | `sudo systemctl stop picnic-assistant` |
| **Start the bot (server-side)** | `sudo systemctl start picnic-assistant` |
| **Check whether it's running** | `sudo systemctl status picnic-assistant` |
| **Pause the bot from your phone** | Send `/stop` in Telegram |
| **Resume the bot from your phone** | Send `/start` in Telegram |
| **Check today's API spend** | Send `/status` in Telegram |
| **Deploy a code update** | `bash ~/picnic-assistant/deploy/update.sh` |
| **Make a manual DB backup** | `cp data/data.db data/backups/data-manual-$(date +%F).db` |

---

## First-time deploy

You only do this once. After that, you use `update.sh`.

### Step A — Provision a Hetzner VPS

1. Go to https://console.hetzner.cloud → log in.
2. **Create Project**, name it `picnic-assistant`.
3. **Add Server**:
   - **Location**: Falkenstein (Germany) or Helsinki (Finland) — pick whichever feels closer.
   - **Image**: Ubuntu 24.04.
   - **Type**: CX22 (~€5/month, 2 vCPU, 4GB RAM, 40GB disk — more than enough).
   - **SSH key**: paste your public key here (see "Generating an SSH key" below if you don't have one).
   - **Name**: `picnic-bot`.
4. Wait ~30 seconds for it to spin up. Note the IPv4 address.

### Step B — Generate an SSH key (if you don't have one)

In PowerShell on your laptop:

```
ssh-keygen -t ed25519 -C "jeroen@picnic-bot"
```

Accept the default file location, set a passphrase or leave blank. The **public** key is at `C:\Users\<you>\.ssh\id_ed25519.pub`. Paste its contents into Hetzner's "SSH key" field.

### Step C — Run the VPS setup script

From PowerShell, SSH into the new server as root:

```
ssh root@<your-server-ip>
```

Then run the one-time setup (replace `jeroen` with whatever username you want):

```
bash <(curl -sSL https://raw.githubusercontent.com/jayjayvee91/picnic-assistant/main/deploy/setup-vps.sh) jeroen
```

This will:
- Create a `jeroen` user with sudo
- Copy your SSH key over
- Disable root SSH login + password auth
- Enable UFW firewall (SSH only)
- Install Node.js 22
- Enable unattended-upgrades

When it finishes, **`exit`** the root session, then SSH back in as the new user:

```
ssh jeroen@<your-server-ip>
```

> If you can't log in as `jeroen`: do NOT close your other root SSH session. From a second laptop terminal, SSH back in as root, check `/home/jeroen/.ssh/authorized_keys`, fix what's missing, and try again.

### Step D — Install the bot

As `jeroen` on the server:

```
bash <(curl -sSL https://raw.githubusercontent.com/jayjayvee91/picnic-assistant/main/deploy/install-bot.sh)
```

This clones the repo to `~/picnic-assistant`, installs deps, sets up `.env`, creates the data directory, and installs the systemd unit (enabled but not started).

### Step E — Fill in `.env`

```
nano ~/picnic-assistant/.env
```

Required fields:
- `PICNIC_USERNAME` — your Picnic login email
- `PICNIC_PASSWORD` — your Picnic password
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- `TELEGRAM_BOT_TOKEN` — from @BotFather

Optional:
- `DAILY_SPEND_LIMIT_EUR` — defaults to 2.00; raise if you want to test more
- `DRY_RUN` — leave as `true` for the first few days, flip to `false` once you're confident

Save: `Ctrl+O`, Enter, `Ctrl+X`.

### Step F — Authenticate Picnic once

```
cd ~/picnic-assistant
npm run smoke:picnic
```

This walks you through 2FA: an SMS code lands on your phone, you type it into the terminal, the long-lived auth token gets saved to `data/picnic-session.json`. After this, the bot can reach Picnic without you in the loop.

### Step G — Smoke-test the agent

```
npm run smoke:agent
```

Type a couple of Dutch messages, verify replies make sense. Ctrl+C to exit.

### Step H — Start the bot under systemd

```
sudo systemctl start picnic-assistant
journalctl -u picnic-assistant -f
```

Within ~5 seconds you should see the startup banner. Leave the journal open and message the bot from Telegram to verify it responds.

### Step I — Wire the chat

On your phone, in Telegram, send the bot:
1. `/chatid` — it replies with your chat id
2. `/setchat` — it confirms; this chat is now the active one

You're live.

---

## Reading logs

```
journalctl -u picnic-assistant -f
```

`-f` = follow (live). Use Ctrl+C to detach. Replace `-f` with `--lines=200` for a one-shot dump of the last 200 lines.

Look for these prefixes:
- `[picnic]` — Picnic-adapter logs (auth, restored session, DRY_RUN writes)
- `[telegram]` — bot lifecycle (start/stop, errors)
- `[scheduler]` — cron logs (next-fire time, weekly nudge sent/skipped)
- `[bootstrap]` — order-history backfill notes (only on first run or after `--force`)

---

## Common operations

### Updating the code

When you've merged changes into `main` on GitHub:

```
bash ~/picnic-assistant/deploy/update.sh
```

It pulls, reinstalls deps if needed, and restarts the service. Last 20 log lines are printed so you can see the new process come up.

### Rotating the Picnic password

1. Change your password at picnic.nl.
2. `sudo systemctl stop picnic-assistant`
3. `nano ~/picnic-assistant/.env` and update `PICNIC_PASSWORD`.
4. Delete the stale session: `rm ~/picnic-assistant/data/picnic-session.json`.
5. Re-authenticate: `cd ~/picnic-assistant && npm run smoke:picnic`. Complete the SMS flow.
6. `sudo systemctl start picnic-assistant`

### Rotating the Telegram bot token

If you ever suspect the token leaked:
1. In Telegram, message @BotFather → `/mybots` → your bot → **Revoke current token**.
2. Update `~/picnic-assistant/.env` with the new token.
3. `sudo systemctl restart picnic-assistant`.

### Rotating the Anthropic API key

1. console.anthropic.com → API Keys → revoke the old one, create a new one.
2. Update `~/picnic-assistant/.env`.
3. `sudo systemctl restart picnic-assistant`.

---

## Kill switches (in escalating order)

1. **Soft pause (phone-friendly):** send `/stop` in Telegram. Bot stops responding; cron nudges still fire but no-op. Resume with `/start`.
2. **Hard stop (SSH):** `sudo systemctl stop picnic-assistant`. The process is dead; nothing fires. Resume with `sudo systemctl start picnic-assistant`.
3. **Nuclear (token revoke):** message @BotFather → revoke the bot's token. No one (including you) can use the bot via that token until you generate a new one.

---

## When things go wrong

### Bot doesn't respond to Telegram messages
1. Check the service is running: `sudo systemctl status picnic-assistant`.
2. Check the logs for an error: `journalctl -u picnic-assistant -n 100`.
3. Check the bot isn't `/stopped`: send `/status` in Telegram (it always replies, even when paused).
4. If the bot says "daglimiet bereikt", the daily €2 spend cap fired. Either type `/start` to override or wait for UTC midnight.

### `AuthRequiredError` in the logs
The Picnic auth token expired. The bot will already have posted in Telegram asking for `/sms`. Reply with `/sms`, then the 6-digit code when it arrives.

If the bot couldn't even post (e.g. Telegram was down), do it manually: stop the bot, run `npm run smoke:picnic` to re-auth, start the bot.

### `DailySpendCapExceededError`
Today's API spend exceeded `DAILY_SPEND_LIMIT_EUR`. Either:
- Investigate why (`/status` shows the running total), then `/start` to override
- Wait until UTC midnight when the day resets

If this fires regularly, raise `DAILY_SPEND_LIMIT_EUR` in `.env` or investigate the agent's tool-call patterns.

### Disk full
Most likely cause: SQLite backups under `data/backups/`. Default retention is 14, but if backups are large you may want to lower this. To clean up manually:
```
ls -lh ~/picnic-assistant/data/backups/
rm ~/picnic-assistant/data/backups/data-2026-XX-XX*.db   # older ones
```

### Bot is in a crash-loop
`journalctl -u picnic-assistant -n 200` will show the recurring error. The systemd unit has `RestartSec=10` so the loop is at most 6 restarts/minute, not a fire hazard. Stop the loop with `sudo systemctl stop picnic-assistant`, fix the issue, restart.

---

## Files and locations

| What | Where |
|---|---|
| Code | `~/picnic-assistant/` |
| `.env` (secrets) | `~/picnic-assistant/.env` (mode 0600, gitignored) |
| SQLite database | `~/picnic-assistant/data/data.db` |
| Household profile | `~/picnic-assistant/data/profile.md` |
| Picnic session token | `~/picnic-assistant/data/picnic-session.json` (mode 0600) |
| Backups | `~/picnic-assistant/data/backups/` |
| systemd unit | `/etc/systemd/system/picnic-assistant.service` |
| Logs | systemd journal (`journalctl -u picnic-assistant`) |

---

## Costs

Expected monthly:
- Hetzner CX22: ~€5
- Anthropic API: ~€2–8 depending on usage

Hetzner bill is fixed and visible at console.hetzner.cloud. Anthropic bill is at console.anthropic.com → Usage. Set a billing alert at Anthropic if you want belt-and-braces on top of the in-bot daily cap.
