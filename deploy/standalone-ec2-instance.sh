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
# Standalone SSH Instance — Ubuntu 22.04
# ═══════════════════════════════════════════════════════════════
# Creates a single EC2 instance for SSH access only. Uses the
# same Ubuntu 22.04 AMI as the migration target. No ALB, no
# target group, no CloudFront, no application deployment.
#
# Use cases:
#   - Jump box / bastion host
#   - Ad-hoc debugging and administration
#   - Testing Ubuntu compatibility before full migration
#
# Can run independently of the main deployment pipeline.
# If deploy/.deploy-state exists, reuses VPC, subnet, and key
# pair from the existing deployment. Otherwise creates minimal
# standalone infrastructure.
#
# The instance gets a public IP via the subnet's auto-assign
# setting. No Elastic IP is allocated (add one manually if
# you need a stable address).
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Logging helpers ──────────────────────────────────────────
info()  { echo "  ✓ $*"; }
warn()  { echo "  ⚠ $*"; }
err()   { echo "  ✗ $*" >&2; }
step()  { echo ""; echo "── $* ──────────────────────────────────────"; }
banner() {
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "  $*"
  echo "═══════════════════════════════════════════════════════════"
  echo ""
}

# ── Configuration ────────────────────────────────────────────
AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"

# Instance sizing — intentionally smaller than the app server.
# Override with environment variables if needed.
SSH_INSTANCE_TYPE="${SSH_INSTANCE_TYPE:-t3.small}"
SSH_EBS_SIZE="${SSH_EBS_SIZE:-10}"

# Ubuntu 22.04 AMI settings
UBUNTU_AMI_OWNER="099720109477"
UBUNTU_AMI_PATTERN="ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"
UBUNTU_ROOT_DEVICE="/dev/sda1"
SSH_USER="ubuntu"

# Naming — if config.sh is available, derive from PROJECT.
# Otherwise use a standalone prefix.
if [ -f "${SCRIPT_DIR}/config.sh" ]; then
  source "${SCRIPT_DIR}/config.sh"
  NAME_PREFIX="${PROJECT}"
else
  NAME_PREFIX="standalone"
fi

SSH_INSTANCE_NAME="${NAME_PREFIX}-standalone"

# ── State file helpers (standalone) ──────────────────────────
STATE_FILE="${SCRIPT_DIR}/.standalone-instance-state"

save_ssh_state() {
  local key="$1" val="$2"
  if [ -f "$STATE_FILE" ]; then
    grep -v "^${key}=" "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null || true
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
  fi
  echo "${key}=${val}" >> "$STATE_FILE"
}

banner "Standalone SSH Instance — Ubuntu 22.04"

# ── Resolve AMI ──────────────────────────────────────────────
step "Finding latest Ubuntu 22.04 AMI"

AMI_ID=$(aws ec2 describe-images \
  --owners "$UBUNTU_AMI_OWNER" \
  --filters \
    "Name=name,Values=${UBUNTU_AMI_PATTERN}" \
    "Name=architecture,Values=x86_64" \
    "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text)

if [ "$AMI_ID" = "None" ] || [ -z "$AMI_ID" ]; then
  err "No Ubuntu 22.04 AMI found in $AWS_REGION"
  exit 1
fi
info "AMI: $AMI_ID"

# ── Resolve network (reuse or standalone) ────────────────────
step "Resolving network configuration"

DEPLOY_STATE="${SCRIPT_DIR}/.deploy-state"

if [ -f "$DEPLOY_STATE" ]; then
  # Reuse the existing deployment's VPC and subnet
  VPC_ID=$(grep "^VPC_ID=" "$DEPLOY_STATE" | tail -1 | cut -d= -f2-)
  SUBNET_ID=$(grep "^SUBNET_1_ID=" "$DEPLOY_STATE" | tail -1 | cut -d= -f2-)
  KEY_NAME_STATE=$(grep "^KEY_NAME=" "$DEPLOY_STATE" | tail -1 | cut -d= -f2-)
  KEY_PATH_STATE=$(grep "^KEY_PATH=" "$DEPLOY_STATE" | tail -1 | cut -d= -f2-)

  if [ -n "$VPC_ID" ] && [ -n "$SUBNET_ID" ]; then
    info "Reusing deployment VPC: $VPC_ID"
    info "Reusing deployment subnet: $SUBNET_ID"
  fi
fi

# Fallback: use default VPC
if [ -z "${VPC_ID:-}" ]; then
  VPC_ID=$(aws ec2 describe-vpcs \
    --filters "Name=isDefault,Values=true" \
    --query 'Vpcs[0].VpcId' --output text)

  if [ "$VPC_ID" = "None" ] || [ -z "$VPC_ID" ]; then
    err "No default VPC found and no .deploy-state to reference"
    echo "  Set VPC_ID and SUBNET_ID as environment variables, or"
    echo "  run this from the deploy/ directory with an existing deployment."
    exit 1
  fi
  info "Using default VPC: $VPC_ID"

  SUBNET_ID=$(aws ec2 describe-subnets \
    --filters "Name=vpc-id,Values=${VPC_ID}" "Name=default-for-az,Values=true" \
    --query 'Subnets[0].SubnetId' --output text)
  info "Using default subnet: $SUBNET_ID"
fi

# ── Key pair ─────────────────────────────────────────────────
step "Key pair"

# Reuse the deployment key if available
if [ -n "${KEY_NAME_STATE:-}" ] && [ -f "${KEY_PATH_STATE:-}" ]; then
  KEY_NAME="$KEY_NAME_STATE"
  KEY_PATH="$KEY_PATH_STATE"
  info "Reusing deployment key: $KEY_NAME"
else
  # Create or reuse a standalone key
  KEY_DIR="${SCRIPT_DIR}/keys"
  mkdir -p "$KEY_DIR"
  chmod 700 "$KEY_DIR"
  KEY_NAME="${SSH_INSTANCE_NAME}-key"
  KEY_PATH="${KEY_DIR}/${KEY_NAME}"

  if [ -f "$KEY_PATH" ]; then
    info "Existing key found: $KEY_PATH"
  else
    ssh-keygen -t ed25519 -f "$KEY_PATH" -N "" -C "${SSH_INSTANCE_NAME}" -q
    chmod 600 "$KEY_PATH"
    info "Generated: $KEY_PATH"
  fi

  # Sync to AWS
  AWS_KEY_CHECK=$(aws ec2 describe-key-pairs \
    --key-names "$KEY_NAME" \
    --query 'KeyPairs[0].KeyName' --output text 2>/dev/null || echo "")

  if [ -z "$AWS_KEY_CHECK" ] || [ "$AWS_KEY_CHECK" = "None" ]; then
    aws ec2 import-key-pair \
      --key-name "$KEY_NAME" \
      --public-key-material "fileb://${KEY_PATH}.pub" > /dev/null
    info "Key imported to AWS: $KEY_NAME"
  else
    info "Key already in AWS: $KEY_NAME"
  fi
fi

# ── Security group (SSH only) ────────────────────────────────
step "Security group (SSH only)"

# Detect caller's public IP for SSH restriction
CALLER_IP=$(curl -s --max-time 5 https://checkip.amazonaws.com 2>/dev/null || echo "")

if [ -n "$CALLER_IP" ]; then
  SSH_CIDR="${CALLER_IP}/32"
  info "Detected your IP: $CALLER_IP"
else
  SSH_CIDR="${SSH_ALLOWED_CIDR:-0.0.0.0/0}"
  warn "Could not detect your IP — using ${SSH_CIDR}"
fi

SG_NAME="${SSH_INSTANCE_NAME}-sg"

# Check if SG already exists (idempotent re-runs)
EXISTING_SG=$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=${SG_NAME}" "Name=vpc-id,Values=${VPC_ID}" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")

if [ "$EXISTING_SG" != "None" ] && [ -n "$EXISTING_SG" ]; then
  SSH_SG_ID="$EXISTING_SG"
  info "Reusing existing SG: $SSH_SG_ID"
else
  SSH_SG_ID=$(aws ec2 create-security-group \
    --group-name "$SG_NAME" \
    --description "SSH-only access for ${SSH_INSTANCE_NAME}" \
    --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)

  aws ec2 authorize-security-group-ingress \
    --group-id "$SSH_SG_ID" \
    --protocol tcp --port 22 \
    --cidr "$SSH_CIDR" > /dev/null

  aws ec2 create-tags --resources "$SSH_SG_ID" \
    --tags "Key=Name,Value=${SG_NAME}" > /dev/null

  info "Created SG: $SSH_SG_ID (SSH from ${SSH_CIDR})"
fi

# ── Launch instance ──────────────────────────────────────────
step "Launching instance (${SSH_INSTANCE_TYPE})"

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type "$SSH_INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SSH_SG_ID" \
  --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address \
  --block-device-mappings "[{\"DeviceName\":\"${UBUNTU_ROOT_DEVICE}\",\"Ebs\":{\"VolumeSize\":${SSH_EBS_SIZE},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled" \
  --query 'Instances[0].InstanceId' --output text \
  --tag-specifications \
    "ResourceType=instance,Tags=[{Key=Name,Value=${SSH_INSTANCE_NAME}},{Key=Purpose,Value=ssh-utility}]" \
    "ResourceType=volume,Tags=[{Key=Name,Value=${SSH_INSTANCE_NAME}-ebs}]")

info "Instance: $INSTANCE_ID"

# ── Wait for running ─────────────────────────────────────────
step "Waiting for instance to start"

aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"

PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

info "Running — public IP: $PUBLIC_IP"

# ── Wait for SSH ─────────────────────────────────────────────
step "Waiting for SSH to become available"

MAX_SSH=12
SSH_WAIT=0
while [ $SSH_WAIT -lt $MAX_SSH ]; do
  if ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
    "${SSH_USER}@${PUBLIC_IP}" "echo ok" 2>/dev/null; then
    info "SSH is ready"
    break
  fi
  SSH_WAIT=$((SSH_WAIT + 1))
  echo "  [$SSH_WAIT/$MAX_SSH] Waiting for sshd... (10s)"
  sleep 10
done

if [ $SSH_WAIT -ge $MAX_SSH ]; then
  warn "SSH did not respond within 2 minutes"
  echo "  The instance is running but sshd may still be starting."
  echo "  Try manually: ssh -i ${KEY_PATH} ${SSH_USER}@${PUBLIC_IP}"
fi

# ── Save state ───────────────────────────────────────────────
save_ssh_state SSH_INSTANCE_ID "$INSTANCE_ID"
save_ssh_state SSH_PUBLIC_IP "$PUBLIC_IP"
save_ssh_state SSH_SG_ID "$SSH_SG_ID"
save_ssh_state SSH_KEY_PATH "$KEY_PATH"
save_ssh_state SSH_AMI_ID "$AMI_ID"

# ── Summary ──────────────────────────────────────────────────
banner "SSH Instance Ready"
echo "  Instance:  $INSTANCE_ID"
echo "  Public IP: $PUBLIC_IP (auto-assigned, may change on stop/start)"
echo "  AMI:       $AMI_ID (Ubuntu 22.04)"
echo "  Type:      $SSH_INSTANCE_TYPE"
echo ""
echo "  SSH:"
echo "    ssh -i ${KEY_PATH} ${SSH_USER}@${PUBLIC_IP}"
echo ""
echo "  State: $STATE_FILE"
echo ""
echo "  ── Cleanup ─────────────────────────────────────────────"
echo "  To terminate when done:"
echo "    aws ec2 terminate-instances --instance-ids $INSTANCE_ID"
echo "    aws ec2 delete-security-group --group-id $SSH_SG_ID"
echo ""
echo "  The public IP is auto-assigned and will be released on"
echo "  termination. If you need a stable IP, allocate an EIP:"
echo "    aws ec2 allocate-address --domain vpc"
echo "    aws ec2 associate-address --instance-id $INSTANCE_ID --allocation-id <alloc-id>"
