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
# LinkedIn AI Agent — AWS Deployment Configuration
# ═══════════════════════════════════════════════════════════════
# Source this file from all phase scripts:
#   source "$(dirname "$0")/config.sh"
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ── Region ────────────────────────────────────────────────────
export AWS_REGION="us-east-1"
export AWS_DEFAULT_REGION="us-east-1"

# ── Domain ────────────────────────────────────────────────────
DOMAIN=majikl.com
SUBDOMAIN=$SUBDOMAIN
FQDN=$DOMAIN
if [ -n "$SUBDOMAIN" ];then FQDN="${SUBDOMAIN}.${DOMAIN}";fi
FQDSHORT=$(echo "$FQDN" |\
  sed -E 's#^[a-zA-Z]+://##; s#/.*##; s/:.*$//' |\
  awk -F. '{for(i=1;i<=NF;i++) printf "%s%s", (i>1?"-":""), substr($i,1,4); print ""}')

# ── Naming ────────────────────────────────────────────────────
PROJECT="mjagt-${FQDSHORT}"
ENV_TAG="production"

# ── Network ───────────────────────────────────────────────────
VPC_CIDR="10.10.0.0/16"
SUBNET_PUBLIC_1_CIDR="10.10.1.0/24"
SUBNET_PUBLIC_2_CIDR="10.10.2.0/24"
AZ_1="${AWS_REGION}a"
AZ_2="${AWS_REGION}b"

# ── Compute ───────────────────────────────────────────────────
INSTANCE_TYPE="m7i-flex.large"

# AMI selection. AMI_OWNER must be a numeric AWS account ID or one of
# the well-known aliases ("amazon", "self"). AMI_NAME is a wildcard
# pattern matched against image names. Both are passed verbatim into
# `aws ec2 describe-images` in 04-compute.sh.
#
# Current target: Ubuntu 24.04 LTS (Noble Numbat), x86_64, server.
# Canonical's official AWS account ID is 099720109477. The name
# pattern targets the HVM SSD images (the standard cloud variant).
AMI_OWNER="099720109477"
AMI_NAME="ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"

# Default SSH user for the chosen AMI. Ubuntu AMIs use "ubuntu",
# Amazon Linux uses "ec2-user". This is referenced by all SSH/SCP
# operations in the deploy scripts so the user can be swapped along
# with the AMI without further edits.
SSH_USER="ubuntu"

EBS_SIZE=20                            # GB, gp3
KEY_NAME="${PROJECT}-key"
SSH_ALLOWED_CIDR="$SSH_ALLOWED_CIDR"

# ── Application ───────────────────────────────────────────────
APP_PORT=$APP_PORT
GITHUB_REPO="$GITGUB_REPO"
GITHUB_BRANCH=${GITHUB_BRANCH:-master}

# ── CloudFront + S3 (Phase 8) ────────────────────────────────
# Bucket name is global to AWS S3. The bucket is treated as a
# shared apex resource — multiple sites under majikl.com may
# coexist in this bucket under different prefix folders. The
# deploy script creates the bucket if it does not exist and
# adds a per-distribution policy statement that does not
# disturb other tenants.
S3_BUCKET_NAME="majikl-com-frontend"

# AWS region the bucket lives in. Should match AWS_REGION
# unless you have a reason to host static assets in a
# different region. The bucket region is referenced when
# building the S3 origin DomainName for CloudFront.
S3_BUCKET_REGION="${AWS_REGION}"

# Folder inside the bucket where this site's static content
# lives. CloudFront uses this as the OriginPath, so requests
# for /styles/alpha.css get rewritten to
# s3://${S3_BUCKET_NAME}/${S3_PREFIX}/styles/alpha.css.
S3_PREFIX="majikl-site"

# CloudFront price class. PriceClass_100 = US/Canada/Europe
# only, cheapest tier. PriceClass_200 adds Asia and South
# America. PriceClass_All adds everywhere. For an early-stage
# product PriceClass_100 is fine.
CF_PRICE_CLASS="PriceClass_100"

# Port that CloudFront uses to talk to the ALB origin.
# We use HTTP (port 80) intentionally — the ALB's TLS cert
# is bound to ${FQDN}, but CloudFront's origin SNI uses the
# ALB DNS name (marketintelligence-agent-alb-NNN.elb.amazonaws.com),
# which doesn't match. HTTP avoids the cert mismatch. The
# CloudFront → ALB hop stays inside the AWS network, and
# 08c-lockdown-alb.sh restricts the ALB SG so the ALB is
# only reachable from CloudFront edge IPs.
CF_HTTP_ORIGIN_PORT=80

# Whether 06-application.sh should issue a CloudFront cache
# invalidation after re-uploading static files. Off until
# Phase 8 has run for the first time (the application phase
# checks for CloudFront state and skips silently if it is
# not yet provisioned).
INVALIDATE_ON_DEPLOY="true"

CLOUDFRONT_DISTRIBUTION_ID="$(grep CF_ID .deploy-state | tail -1 | cut -d= -f2)"

# ── Tags (applied to all resources) ──────────────────────────
TAG_SPEC="ResourceType=__TYPE__,Tags=[{Key=Name,Value=${PROJECT}-__NAME__},{Key=Project,Value=${PROJECT}},{Key=Environment,Value=${ENV_TAG}}]"

# ── State file ────────────────────────────────────────────────
# Phase scripts write resource IDs here. Subsequent phases read them.
STATE_FILE="$(dirname "$0")/.deploy-state"

save_state() {
  local key="$1" val="$2"
  # Remove existing key if present, then append
  if [ -f "$STATE_FILE" ]; then
    grep -v "^${key}=" "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null || true
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
  fi
  echo "${key}=${val}" >> "$STATE_FILE"
}

load_state() {
  local key="$1"
  if [ -f "$STATE_FILE" ]; then
    grep "^${key}=" "$STATE_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true
  fi
}

require_state() {
  local key="$1"
  local val
  val=$(load_state "$key")
  if [ -z "$val" ]; then
    echo "ERROR: Required state '${key}' not found. Run the previous phase first."
    exit 1
  fi
  echo "$val"
}

# ── Tag helper ────────────────────────────────────────────────
make_tags() {
  local type="$1" name="$2"
  echo "${TAG_SPEC//__TYPE__/$type}" | sed "s/__NAME__/$name/g"
}

# ── Logging ───────────────────────────────────────────────────
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
