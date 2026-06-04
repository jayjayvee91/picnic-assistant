#!/usr/bin/env bash
# One-time VPS hardening + Node install.
#
# Run this ONCE on a fresh Hetzner Ubuntu VPS, logged in as `root` via SSH.
# It does NOT install the bot — that's `install-bot.sh`, run as the new user
# after this script completes.
#
# What it does, in order:
#   1. Apt update + minimal package install (git, curl, ufw, unattended-upgrades).
#   2. Creates a non-root user with sudo (default name: `jeroen`).
#   3. Copies the root SSH key over to that user so you can log in as them.
#   4. Disables root SSH login and password-based SSH auth.
#   5. Configures UFW firewall: allow SSH (22) only.
#   6. Installs Node.js 22 LTS from NodeSource.
#   7. Enables unattended-upgrades for security patches.
#
# Idempotent: safe to re-run. Lines that would already be done are skipped.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/jayjayvee91/picnic-assistant/main/deploy/setup-vps.sh \
#     | sudo bash -s -- jeroen
#
# Or copy the file across and run:
#   sudo bash setup-vps.sh jeroen

set -euo pipefail

USERNAME="${1:-jeroen}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "This script must be run as root (use sudo)." >&2
  exit 1
fi

step() { printf '\n=== %s ===\n' "$1"; }

step "1. Updating apt and installing prerequisites"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  git curl ufw unattended-upgrades ca-certificates

step "2. Creating user '$USERNAME' (if it doesn't already exist)"
if id -u "$USERNAME" >/dev/null 2>&1; then
  echo "User $USERNAME already exists, skipping."
else
  adduser --disabled-password --gecos "" "$USERNAME"
  usermod -aG sudo "$USERNAME"
  # No-password sudo so the bot's update script can run systemctl without prompts.
  # We accept the trade-off: the user already has full sudo via password anyway,
  # and SSH is key-only, so an attacker would need to compromise the key first.
  echo "$USERNAME ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/"$USERNAME"
  chmod 0440 /etc/sudoers.d/"$USERNAME"
fi

step "3. Copying root SSH key(s) to $USERNAME"
if [[ -f /root/.ssh/authorized_keys ]]; then
  mkdir -p "/home/$USERNAME/.ssh"
  cp /root/.ssh/authorized_keys "/home/$USERNAME/.ssh/authorized_keys"
  chown -R "$USERNAME":"$USERNAME" "/home/$USERNAME/.ssh"
  chmod 0700 "/home/$USERNAME/.ssh"
  chmod 0600 "/home/$USERNAME/.ssh/authorized_keys"
else
  echo "WARNING: /root/.ssh/authorized_keys not found. You must manually add an"
  echo "SSH public key to /home/$USERNAME/.ssh/authorized_keys before locking out root."
fi

step "4. Disabling root SSH login and password auth"
SSHD_CONFIG=/etc/ssh/sshd_config
sed -i \
  -e 's/^#\?PermitRootLogin.*/PermitRootLogin no/' \
  -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' \
  -e 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' \
  "$SSHD_CONFIG"
# Some Ubuntu images split sshd config — clear any overrides that re-enable it.
if [[ -d /etc/ssh/sshd_config.d ]]; then
  for f in /etc/ssh/sshd_config.d/*.conf; do
    [[ -e "$f" ]] || continue
    sed -i \
      -e 's/^#\?PermitRootLogin.*/PermitRootLogin no/' \
      -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' \
      "$f"
  done
fi
systemctl reload ssh || systemctl reload sshd

step "5. Configuring UFW firewall: allow SSH only"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

step "6. Installing Node.js 22 LTS from NodeSource"
if command -v node >/dev/null 2>&1 && [[ "$(node --version)" =~ ^v22\. ]]; then
  echo "Node 22 already installed: $(node --version)"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

step "7. Enabling unattended-upgrades"
dpkg-reconfigure -plow unattended-upgrades || true
systemctl enable --now unattended-upgrades

cat <<EOF

==========================================================================
Setup complete.

Next steps:
  1. Log out of root: type 'exit'.
  2. Log back in as $USERNAME from your laptop:
       ssh $USERNAME@<your-server-ip>
     (the same SSH key you used as root will work)
  3. Run the bot installer:
       bash <(curl -sSL https://raw.githubusercontent.com/jayjayvee91/picnic-assistant/main/deploy/install-bot.sh)
     or clone the repo manually and run deploy/install-bot.sh.

If you can't SSH in as $USERNAME, log in as root from your laptop's other
SSH session (don't close the current root session yet) and check
/home/$USERNAME/.ssh/authorized_keys.
==========================================================================
EOF
