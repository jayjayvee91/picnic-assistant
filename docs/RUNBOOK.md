# Picnic Assistant — Runbook

How to operate the bot in production. Written for **future-Jeroen**, who may have forgotten how everything works. Plain language, copy-pasteable commands.

## Quick reference

**Where to run these:** The "Telegram" rows are typed into the Telegram chat on your phone. **Every other row is a Linux command typed on the VPS shell over SSH** — NOT in PowerShell on your laptop. To get to the VPS shell from PowerShell:

```
ssh jeroen@<your-server-ip>
```

…then run the command. Commands that touch project files assume you're in `~/picnic-assistant`; if you're not, run `cd ~/picnic-assistant` first.

| Thing you want to do | Where | Command |
|---|---|---|
| **Read live logs** | VPS (SSH) | `journalctl -u picnic-assistant -f` |
| **Restart the bot** | VPS (SSH) | `sudo systemctl restart picnic-assistant` |
| **Stop the bot (server-side)** | VPS (SSH) | `sudo systemctl stop picnic-assistant` |
| **Start the bot (server-side)** | VPS (SSH) | `sudo systemctl start picnic-assistant` |
| **Check whether it's running** | VPS (SSH) | `sudo systemctl status picnic-assistant` |
| **Pause the bot from your phone** | Telegram (phone) | Send `/stop` |
| **Resume the bot from your phone** | Telegram (phone) | Send `/start` |
| **Check today's API spend** | Telegram (phone) | Send `/status` |
| **Move the bot to another chat** (e.g. a household group) | Telegram (phone) | Send `/movechat` in the current chat — see [Moving the bot to another chat](#moving-the-bot-to-another-chat) |
| **Deploy a code update** | GitHub | Merge to `main` — deploys automatically ([Automatic deploys](#automatic-deploys)). By hand: `bash ~/picnic-assistant/deploy/update.sh` on the VPS |
| **Make a manual DB backup** | VPS (SSH, in `~/picnic-assistant`) | `cp data/data.db data/backups/data-manual-$(date +%F).db` |

---

## First-time deploy

You only do this once. After that, you use `update.sh`.

### Step A — Provision a Hetzner VPS

1. Go to https://console.hetzner.cloud → log in.
2. **Create Project**, name it `picnic-assistant`.
3. **Add Server**:
   - **Location**: Falkenstein (Germany) or Helsinki (Finland) — pick whichever feels closer.
   - **Image**: Ubuntu 24.04.
   - **Type**: **CX23** (2 vCPU, 4 GB RAM, 40 GB disk, x86 — ~€5/month). The older "CX22" name in earlier drafts of this doc was renamed by Hetzner. If you'd rather use ARM (slightly cheaper), pick **CAX11** instead — same specs, Ampere CPU. Either works; we tested on x86 so CX23 is the safer pick.
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

The bot prints a one-time claim token in the journal at startup when no chat is configured yet:

```
[telegram] BOOTSTRAP TOKEN: 1a2b3c4d5e6f7a8b
```

On your phone, in Telegram, open the chat the bot should live in (a private chat with the bot, or a group — see [Moving the bot to another chat](#moving-the-bot-to-another-chat) for the group setup) and send:

```
/setchat 1a2b3c4d5e6f7a8b
```

It confirms that this chat is now the active one. You're live.

`/chatid` replies with a chat's id in any chat, if you'd rather set `TELEGRAM_ALLOWED_CHAT_ID` in `.env` instead.

---

## Reading logs

```
journalctl -u picnic-assistant -f
```

`-f` = follow (live). Use Ctrl+C to detach. Replace `-f` with `--lines=200` for a one-shot dump of the last 200 lines.

Look for these prefixes:
- `[picnic]` — Picnic-adapter logs (auth, restored session, DRY_RUN writes)
- `[telegram]` — bot lifecycle (start/stop, errors)
- `[scheduler]` — cron logs (next-fire time, weekly nudge sent/skipped, order sync results)
- `[bootstrap]` — order-history backfill notes (only on first run or after `--force`)
- `[sync]` — incremental order-history sync warnings

---

## Common operations

### Order-history sync

The bot keeps its own order history current. A cron job inside the bot process
runs daily at **03:30 Europe/Amsterdam**, plus once about five seconds after
every startup — so a deploy also refreshes the history immediately.

Each run pulls the list of completed deliveries, walks only those at or after
the newest order already stored (minus a 3-day overlap, because Picnic
finalises an order at delivery time), and upserts them. A typical run fetches
zero or one delivery. It costs no Anthropic tokens — Picnic HTTP only — and it
keeps running while the bot is `/stop`ped, so a paused weekend doesn't leave
you with stale history on Monday.

Confirm it ran:

```
journalctl -u picnic-assistant --no-pager | grep 'order sync'
```

You want a line like `order sync: nothing new since <date>` (steady state) or
`order sync: recorded 1 order(s), 23 item(s), 0 failed`.

If it reports `no usable order watermark`, the `orders` table is empty — the
sync falls back to a 30-day window and full history needs the one-time backfill
(`npm run smoke:memory`, see Step G).

Note: only `COMPLETED` deliveries are synced. An in-flight (`CURRENT`) order is
deliberately not recorded — nothing in the codebase deletes an order, so a
cancelled one would linger forever and skew the averages behind the weekly
suggestions.

### Moving the bot to another chat

The bot answers exactly one chat. To move it — typically from your private chat to a group with the rest of the household — no server access is needed:

1. **Turn off privacy mode** (once per bot). In @BotFather send `/setprivacy`, pick the bot, choose **Disable**. Without this, a bot in a group only sees commands and replies to itself, not ordinary messages. If the bot was already in the group, remove it and add it again so the change applies.
2. **Add the bot to the new chat.**
3. In the **current** chat, send `/movechat`. The bot replies with a `/setchat <token>` line.
4. In the **new** chat, send that `/setchat <token>` line within 10 minutes.

The bot confirms in the new chat and tells the old one it has moved. From then on everything — the Thursday nudge, Picnic re-auth prompts, error reports — goes to the new chat.

Order history, the household profile, recipe rotation and gluten rules carry over; the running conversation starts fresh. Everyone in the chat has the same rights, including approving the cart and `/stop`.

The token is single-use and lives in memory only: a restart cancels a pending move. A `/movechat` from any other chat is silently ignored. The moved-to chat is stored in the database, so it takes precedence over `TELEGRAM_ALLOWED_CHAT_ID` in `.env`.

### Automatic deploys

Every push to `main` (in practice: merging a "Promote develop to main" PR) runs `.github/workflows/deploy.yml`. It runs the full CI suite first, then logs in to the VPS once and runs `deploy/update.sh`. The run fails, and GitHub emails you, if the checks fail, the pull fails, or the bot doesn't stay up for 20 seconds after the restart. Follow it under the repo's **Actions** tab, which also works from the GitHub mobile app.

The login uses a dedicated deploy key that is locked to one command on the VPS: whoever holds it can run `update.sh` (deploy what is on `main`) and nothing else — no shell, no port forwarding. The runner also pins the server's host key, so it won't talk to an impostor at the same IP.

**One-time setup** (VPS shell as `jeroen`, then the GitHub website):

1. Make sure git can fetch without asking for credentials, since nobody is there to type them:
   ```
   cd ~/picnic-assistant && GIT_TERMINAL_PROMPT=0 git fetch origin && echo OK
   ```
   If this doesn't print `OK`, store a read-only credential first (a fine-grained GitHub token with *Contents: read* on this repo only, saved with `git config credential.helper store` and one `git fetch`).
2. Create the deploy key and lock it to the update script:
   ```
   ssh-keygen -t ed25519 -N '' -C github-deploy -f ~/github-deploy-key
   echo "restrict,command=\"bash /home/jeroen/picnic-assistant/deploy/update.sh\" $(cat ~/github-deploy-key.pub)" >> ~/.ssh/authorized_keys
   ```
3. Print the two values GitHub needs:
   ```
   cat ~/github-deploy-key                    # the private key, for VPS_SSH_KEY
   cat /etc/ssh/ssh_host_ed25519_key.pub      # the server's host key, for VPS_HOST_KEY
   ```
4. On GitHub: repo **Settings → Secrets and variables → Actions → New repository secret**, four times:

   | Name | Value |
   |---|---|
   | `VPS_HOST` | the VPS IP address |
   | `VPS_USER` | `jeroen` |
   | `VPS_SSH_KEY` | the whole private key from step 3, including the `-----BEGIN` and `-----END` lines |
   | `VPS_HOST_KEY` | the `ssh-ed25519 AAAA…` line from step 3 |

5. Delete the key files from the VPS — GitHub has the only copy now:
   ```
   shred -u ~/github-deploy-key ~/github-deploy-key.pub
   ```
6. Test it: **Actions → Deploy → Run workflow** (branch `main`). The log ends with the bot's last 20 journal lines.

Until all four secrets exist, the workflow logs a warning and deploys nothing.

**Revoking the key** (e.g. if a secret may have leaked): on the VPS, delete the line containing `github-deploy` from `~/.ssh/authorized_keys`. Deploys stop immediately; manual SSH is unaffected.

**Gluten checks:** `verify:allergen` and `verify:recipe` need live Picnic data, so the automatic deploy can't run them. After a release that touches the gluten guard or recipe parsing, run them on the VPS by hand.

### Updating the code

Once [automatic deploys](#automatic-deploys) are set up, merging into `main` is enough. To deploy by hand instead (or if the automatic deploy failed and you've fixed the cause on the server):

```
bash ~/picnic-assistant/deploy/update.sh
```

It pulls, reinstalls deps if needed, restarts the service, and checks the bot is still up 20 seconds later. Last 20 log lines are printed so you can see the new process come up.

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
- Hetzner CX23 (or CAX11): ~€5
- Anthropic API: ~€2–8 depending on usage

Hetzner bill is fixed and visible at console.hetzner.cloud. Anthropic bill is at console.anthropic.com → Usage. Set a billing alert at Anthropic if you want belt-and-braces on top of the in-bot daily cap.
