#!/bin/bash
#
# Copyright (c) 2026 majiklTrust Market Intelligence, LLC. All rights reserved.
#
# This file is part of Market Intelligence and contains proprietary and
# confidential information. Unauthorized copying, modification, distribution,
# or use of this file, via any medium, is strictly prohibited without the
# express written permission of the copyright holder.
#

# ═══════════════════════════════════════════════════════════════
# EC2 UserData — Bootstrap Script (Ubuntu 24.04 LTS)
# ═══════════════════════════════════════════════════════════════
# This runs as root on first boot. It installs Node.js, PM2, and
# prepares the system for the application. The application itself
# is deployed in Phase 6 (via SSH).
#
# Target OS: Ubuntu 24.04 LTS (Noble Numbat).
# Default user: ubuntu.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail
exec > /var/log/userdata.log 2>&1
echo "=== UserData started at $(date) ==="

# ── Non-interactive apt ───────────────────────────────────────
# 24.04's needrestart will prompt during package operations and
# stall a non-interactive cloud-init run. Suppress all prompts and
# the daemon-restart confirmation so apt operations complete
# unattended. DEBIAN_FRONTEND=noninteractive is the canonical knob;
# NEEDRESTART_MODE=a (automatic) tells needrestart to restart
# services without asking.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

# ── System Updates ────────────────────────────────────────────
apt-get update -qq
apt-get install -y -qq \
    git \
    curl \
    ca-certificates \
    build-essential \
    unzip

# ── Node.js 22 LTS via nvm ───────────────────────────────────
# nvm is installed per-user. UserData runs as root, so we
# install nvm as the ubuntu user via sudo -u.
sudo -u ubuntu bash << 'NVMINSTALL'
set -euo pipefail
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# shellcheck disable=SC1090
source ~/.nvm/nvm.sh
nvm install 22
nvm use 22
nvm alias default 22
echo "Node: $(node --version)"
echo "npm: $(npm --version)"

# ── PM2 (global for ubuntu user) ──────────────────────────────
npm install -g pm2
echo "PM2: $(pm2 --version)"
NVMINSTALL

# Configure PM2 to start on boot. The systemd unit must reference
# the nvm-managed Node binary (nvm installs to per-user paths, not
# /usr/bin), so we resolve the active Node version path at runtime
# and prepend it to PATH for `pm2 startup`.
NVM_NODE_VER=$(sudo -u ubuntu bash -c 'source ~/.nvm/nvm.sh && node --version')
NVM_NODE_PATH="/home/ubuntu/.nvm/versions/node/${NVM_NODE_VER}/bin"
env PATH="${NVM_NODE_PATH}:$PATH" pm2 startup systemd -u ubuntu --hp /home/ubuntu
systemctl enable pm2-ubuntu

# ── Application Directory ────────────────────────────────────
# Directory is created by git clone in Phase 6 (06-application.sh).
# Do NOT mkdir here — an empty directory breaks the clone logic.

# ── CloudWatch Agent ─────────────────────────────────────────
# Ubuntu doesn't have an apt repo for the CloudWatch agent. Amazon
# publishes a stable .deb at the URL below; this is the canonical
# install path documented in AWS's CloudWatch agent guide.
#
# DEBT: Hardcoded URL. The .deb is unsigned at the apt level and
# pulled directly from S3. For a hardening pass, mirror this into
# our own S3 bucket with a known SHA-256 and verify before install.
CW_AGENT_URL="https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb"
CW_AGENT_DEB="/tmp/amazon-cloudwatch-agent.deb"
curl -fsSL -o "$CW_AGENT_DEB" "$CW_AGENT_URL"
dpkg -i "$CW_AGENT_DEB"
rm -f "$CW_AGENT_DEB"

# CloudWatch agent config — ships PM2 logs. Paths under
# /home/ubuntu/.pm2/logs/ are created when PM2 starts the app
# in Phase 6; the agent will pick them up once they appear.
cat > /opt/aws/amazon-cloudwatch-agent/etc/agent-config.json << 'CWEOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/home/ubuntu/.pm2/logs/*-out.log",
            "log_group_name": "/marketintelligence-agent/app",
            "log_stream_name": "{instance_id}/stdout",
            "retention_in_days": 30
          },
          {
            "file_path": "/home/ubuntu/.pm2/logs/*-error.log",
            "log_group_name": "/marketintelligence-agent/app",
            "log_stream_name": "{instance_id}/stderr",
            "retention_in_days": 30
          }
        ]
      }
    }
  }
}
CWEOF

/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/agent-config.json -s

# ── Swap (safety net for low-RAM instances) ───────────────────
# Production target is m7i-flex.large (8 GB RAM); swap is harmless
# headroom there. Retained for parity with the AL2023 userdata and
# to guard against accidental small-instance test deploys.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  chmod 600 /swapfile
  mkswap /swapfile > /dev/null
  swapon /swapfile
  echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
fi

# ── Signal completion ─────────────────────────────────────────
echo "=== UserData completed at $(date) ==="
touch /home/ubuntu/.userdata-complete
chown ubuntu:ubuntu /home/ubuntu/.userdata-complete
