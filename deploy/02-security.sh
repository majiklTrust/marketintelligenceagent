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
# Phase 2: Security Groups + Key Pair + IAM Role
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"
banner "Phase 2: Security Groups + Key Pair + IAM Role"

VPC_ID=$(require_state VPC_ID)

# ── ALB Security Group ────────────────────────────────────────
step "Creating ALB security group (HTTPS from anywhere)"

ALB_SG_ID=$(aws ec2 create-security-group \
  --group-name "${PROJECT}-alb-sg" \
  --description "ALB - HTTPS inbound from internet" \
  --vpc-id "$VPC_ID" \
  --query 'GroupId' --output text \
  --tag-specifications "$(make_tags security-group alb-sg)")

aws ec2 authorize-security-group-ingress \
  --group-id "$ALB_SG_ID" \
  --protocol tcp --port 443 \
  --cidr "0.0.0.0/0" > /dev/null

# Also allow HTTP for redirect to HTTPS
aws ec2 authorize-security-group-ingress \
  --group-id "$ALB_SG_ID" \
  --protocol tcp --port 80 \
  --cidr "0.0.0.0/0" > /dev/null

save_state ALB_SG_ID "$ALB_SG_ID"
info "ALB SG: $ALB_SG_ID (443 + 80 from 0.0.0.0/0)"

# ── EC2 Security Group ───────────────────────────────────────
step "Creating EC2 security group (app from ALB, SSH from you)"

EC2_SG_ID=$(aws ec2 create-security-group \
  --group-name "${PROJECT}-ec2-sg" \
  --description "EC2 - app port from ALB, SSH restricted" \
  --vpc-id "$VPC_ID" \
  --query 'GroupId' --output text \
  --tag-specifications "$(make_tags security-group ec2-sg)")

# App port from ALB security group only
aws ec2 authorize-security-group-ingress \
  --group-id "$EC2_SG_ID" \
  --protocol tcp --port "$APP_PORT" \
  --source-group "$ALB_SG_ID" > /dev/null

# SSH from specified CIDR
aws ec2 authorize-security-group-ingress \
  --group-id "$EC2_SG_ID" \
  --protocol tcp --port 22 \
  --cidr "$SSH_ALLOWED_CIDR" > /dev/null

save_state EC2_SG_ID "$EC2_SG_ID"
info "EC2 SG: $EC2_SG_ID (${APP_PORT} from ALB, 22 from ${SSH_ALLOWED_CIDR})"

# ── SSH Key Pair ──────────────────────────────────────────────
step "SSH key pair"

KEY_DIR="$(dirname "$0")/keys"
mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

KEY_FILE="${KEY_DIR}/${KEY_NAME}"
KEY_PUB="${KEY_FILE}.pub"

# Decide whether to create, reuse, or overwrite. Teardown
# intentionally preserves local keys, so on a fresh deploy of
# the same project the file will already exist. ssh-keygen
# without explicit handling would prompt interactively for
# overwrite confirmation, which hangs non-interactive runs and
# is brittle even when interactive.
if [ -f "$KEY_FILE" ]; then
  echo ""
  echo "  Existing private key found at:"
  echo "    $KEY_FILE"
  echo ""
  echo "    [r] Reuse — keep existing key, sync to AWS if needed (default)"
  echo "    [o] Overwrite — delete local + AWS key, generate fresh"
  echo "    [a] Abort"
  echo ""
  read -p "  Choice [R/o/a]: " KEY_CHOICE
  KEY_CHOICE=${KEY_CHOICE:-r}
  case "$KEY_CHOICE" in
    [Rr]*) KEY_ACTION="reuse" ;;
    [Oo]*) KEY_ACTION="overwrite" ;;
    [Aa]*) echo "  Aborted by user."; exit 0 ;;
    *) err "Invalid choice: $KEY_CHOICE"; exit 1 ;;
  esac
else
  KEY_ACTION="create"
fi

# Overwrite path: clean both sides first, then fall through to create.
if [ "$KEY_ACTION" = "overwrite" ]; then
  rm -f "$KEY_FILE" "$KEY_PUB"
  # Best-effort AWS deletion. If the key isn't in AWS, this is a no-op.
  aws ec2 delete-key-pair --key-name "$KEY_NAME" > /dev/null 2>&1 || true
  info "Existing key removed (local + AWS)"
  KEY_ACTION="create"
fi

# Create path: generate locally.
if [ "$KEY_ACTION" = "create" ]; then
  ssh-keygen -t ed25519 -f "$KEY_FILE" -N "" -C "${PROJECT}-deploy" -q
  info "Key pair generated locally"
fi

# Sync to AWS independent of how we got the local key. Reuse may
# have a stale local key with no AWS counterpart (e.g., teardown
# removed the AWS side); create needs first-time import.
AWS_KEY_PRESENT=$(aws ec2 describe-key-pairs \
  --key-names "$KEY_NAME" \
  --query 'KeyPairs[0].KeyName' --output text 2>/dev/null || echo "")

if [ -z "$AWS_KEY_PRESENT" ] || [ "$AWS_KEY_PRESENT" = "None" ]; then
  aws ec2 import-key-pair \
    --key-name "$KEY_NAME" \
    --public-key-material "fileb://${KEY_PUB}" \
    --tag-specifications "$(make_tags key-pair key)" > /dev/null
  info "Key pair imported to AWS as $KEY_NAME"
else
  info "Key pair already in AWS as $KEY_NAME — skipping import"
fi

chmod 600 "$KEY_FILE"
chmod 644 "$KEY_PUB"

save_state KEY_NAME "$KEY_NAME"
save_state KEY_PATH "$KEY_FILE"
info "Private key path: $KEY_FILE"
warn "Back up your private key. It cannot be regenerated."

# ── IAM Role for EC2 ─────────────────────────────────────────
step "Creating IAM role for EC2 (SSM + CloudWatch)"

# Trust policy — allows EC2 to assume this role
TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "ec2.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}'

aws iam create-role \
  --role-name "${PROJECT}-ec2-role" \
  --assume-role-policy-document "$TRUST_POLICY" \
  --tags "Key=Project,Value=${PROJECT}" "Key=Environment,Value=${ENV_TAG}" > /dev/null

# Attach managed policies for SSM Session Manager and CloudWatch
aws iam attach-role-policy \
  --role-name "${PROJECT}-ec2-role" \
  --policy-arn "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"

aws iam attach-role-policy \
  --role-name "${PROJECT}-ec2-role" \
  --policy-arn "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"

# Create instance profile and attach role
aws iam create-instance-profile \
  --instance-profile-name "${PROJECT}-ec2-profile" > /dev/null

aws iam add-role-to-instance-profile \
  --instance-profile-name "${PROJECT}-ec2-profile" \
  --role-name "${PROJECT}-ec2-role"

save_state IAM_ROLE "${PROJECT}-ec2-role"
save_state INSTANCE_PROFILE "${PROJECT}-ec2-profile"
info "IAM role: ${PROJECT}-ec2-role"
info "Instance profile: ${PROJECT}-ec2-profile"

# IAM is eventually consistent — wait for propagation. The
# downstream consumer is phase 4's run-instances call which
# references the instance profile by name. AWS does not provide
# a wait command for IAM propagation. 10 seconds is sometimes
# insufficient (~5% of the time in observation), 20 is safer.
echo "  Waiting 20s for IAM propagation..."
sleep 20

# ── Summary ───────────────────────────────────────────────────
banner "Phase 2 Complete"
echo "  ALB SG:     $ALB_SG_ID"
echo "  EC2 SG:     $EC2_SG_ID"
echo "  Key pair:   $KEY_NAME"
echo "  Private key: ${KEY_DIR}/${KEY_NAME}"
echo "  IAM role:   ${PROJECT}-ec2-role"
echo ""
echo "  Next: bash 03-certificate.sh"
