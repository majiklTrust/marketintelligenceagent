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
# Phase 8c: ALB security group lockdown (optional, recommended)
# ═══════════════════════════════════════════════════════════════
# Restricts the ALB security group so it only accepts traffic
# from CloudFront's managed origin-facing prefix list. Until this
# step runs, the ALB is reachable directly at its DNS name over
# HTTPS on port 443, which is useful during deployment and
# testing but becomes a bypass once CloudFront is the front door.
#
# IMPORTANT: Run this ONLY AFTER:
#   - 08b-wait-cloudfront.sh has reported 'Deployed'
#   - You've updated DNS to point at the CloudFront distribution
#   - You've verified the site works via CloudFront (07-verify.sh)
#
# Running this prematurely — before DNS cutover or before
# CloudFront is serving traffic — will break the site until the
# lockdown is reversed. The script prompts for explicit
# confirmation before making any changes.
#
# What this script does:
#   1. Looks up the CloudFront origin-facing managed prefix list
#   2. Authorizes the ALB SG for port ${CF_HTTP_ORIGIN_PORT} from
#      that prefix list
#   3. Revokes the existing 0.0.0.0/0 rules on ports 80 and 443
#   4. Saves the prior rules to state in case you need to roll back
#
# To roll back: bash 08c-lockdown-alb.sh --revert
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"

REVERT_MODE="no"
if [ "${1:-}" = "--revert" ]; then
  REVERT_MODE="yes"
fi

ALB_SG_ID=$(require_state ALB_SG_ID)

# ── Revert mode ──────────────────────────────────────────────
if [ "$REVERT_MODE" = "yes" ]; then
  banner "Phase 8c: Reverting ALB SG lockdown"

  PL_ID=$(load_state CF_PREFIX_LIST_ID || true)
  if [ -z "$PL_ID" ]; then
    err "No lockdown state found — nothing to revert."
    exit 1
  fi

  step "Re-opening ALB SG to 0.0.0.0/0"
  aws ec2 authorize-security-group-ingress --group-id "$ALB_SG_ID" \
    --protocol tcp --port 443 --cidr "0.0.0.0/0" > /dev/null 2>&1 \
    && info "Port 443 re-opened" || warn "Port 443 rule may already exist"
  aws ec2 authorize-security-group-ingress --group-id "$ALB_SG_ID" \
    --protocol tcp --port 80 --cidr "0.0.0.0/0" > /dev/null 2>&1 \
    && info "Port 80 re-opened" || warn "Port 80 rule may already exist"

  step "Revoking CloudFront prefix list rule"
  aws ec2 revoke-security-group-ingress --group-id "$ALB_SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=${CF_HTTP_ORIGIN_PORT},ToPort=${CF_HTTP_ORIGIN_PORT},PrefixListIds=[{PrefixListId=${PL_ID}}]" \
    > /dev/null 2>&1 && info "Prefix list rule revoked" || warn "Prefix list rule may already be absent"

  save_state CF_PREFIX_LIST_ID ""
  banner "ALB SG restored to pre-lockdown state"
  exit 0
fi

# ── Normal lockdown flow ─────────────────────────────────────
banner "Phase 8c: Lock down ALB security group"

CF_ID=$(load_state CF_ID || true)
if [ -z "$CF_ID" ]; then
  err "No CloudFront distribution state found (CF_ID missing)."
  err "Run 08-cloudfront.sh first."
  exit 1
fi

CF_DOMAIN=$(load_state CF_DOMAIN || true)

# ── Sanity check: is CloudFront actually deployed? ───────────
step "Verifying CloudFront distribution is deployed"

CF_STATUS=$(aws cloudfront get-distribution --id "$CF_ID" \
  --query 'Distribution.Status' --output text 2>/dev/null || echo "UNKNOWN")

if [ "$CF_STATUS" != "Deployed" ]; then
  err "CloudFront distribution status is '${CF_STATUS}', expected 'Deployed'."
  err "Run 08b-wait-cloudfront.sh first and wait for it to finish."
  exit 1
fi
info "CloudFront status: Deployed"

# ── Sanity check: is DNS pointing at CloudFront? ─────────────
step "Verifying DNS points at CloudFront"

DIG_RESULT=$(dig +short CNAME "${FQDN}" 2>/dev/null | head -1 | sed 's/\.$//')
if echo "$DIG_RESULT" | grep -qi "cloudfront.net"; then
  info "${FQDN} resolves to CloudFront (${DIG_RESULT})"
else
  err "${FQDN} does NOT currently resolve to CloudFront."
  err "Resolved to: ${DIG_RESULT:-NXDOMAIN}"
  err ""
  err "If you lock down the ALB now, the site will break until you"
  err "update DNS to point at ${CF_DOMAIN}."
  echo ""
  read -p "  Proceed anyway? (type 'force' to continue): " FORCE
  if [ "$FORCE" != "force" ]; then
    echo "  Aborted."
    exit 1
  fi
  warn "Proceeding despite DNS check failure (user override)"
fi

# ── Sanity check: is the site responding through CloudFront? ─
step "Verifying site is reachable through CloudFront"

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  --max-time 15 "https://${FQDN}/" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  info "https://${FQDN}/ → 200 (majikl-site live through CloudFront)"
else
  err "https://${FQDN}/ → ${HTTP_CODE} (expected 200)"
  echo ""
  read -p "  Proceed anyway? (type 'force' to continue): " FORCE
  if [ "$FORCE" != "force" ]; then
    echo "  Aborted."
    exit 1
  fi
fi

# ── Look up CloudFront managed prefix list ID ────────────────
step "Looking up CloudFront origin-facing prefix list"

# The name is the same in every AWS account and region, but the
# ID is region-scoped. us-east-1 has its own ID.
PL_ID=$(aws ec2 describe-managed-prefix-lists \
  --filters "Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing" \
  --query 'PrefixLists[0].PrefixListId' --output text 2>/dev/null || echo "")

if [ -z "$PL_ID" ] || [ "$PL_ID" = "None" ]; then
  err "Could not find CloudFront origin-facing prefix list."
  err "This is an AWS-managed prefix list that should exist in every region."
  err "Check your IAM permissions for ec2:DescribeManagedPrefixLists."
  exit 1
fi
info "Prefix list: $PL_ID"

save_state CF_PREFIX_LIST_ID "$PL_ID"

# ── Final confirmation prompt ────────────────────────────────
banner "Ready to lock down ALB security group"
echo "  This will make the following changes to SG ${ALB_SG_ID}:"
echo ""
echo "    ADD:     Allow tcp:${CF_HTTP_ORIGIN_PORT} FROM prefix list ${PL_ID}"
echo "             (CloudFront origin-facing IP ranges)"
echo ""
echo "    REVOKE:  Allow tcp:443 FROM 0.0.0.0/0"
echo "    REVOKE:  Allow tcp:80  FROM 0.0.0.0/0"
echo ""
echo "  After this, the ALB will only accept traffic from CloudFront's"
echo "  edge locations. Direct curl of the ALB DNS name will timeout."
echo ""
echo "  To undo later: bash 08c-lockdown-alb.sh --revert"
echo ""
read -p "  Type 'lockdown' to proceed: " CONFIRM
if [ "$CONFIRM" != "lockdown" ]; then
  echo "  Aborted."
  exit 1
fi

# ── Authorize prefix list rule first (add before remove) ─────
step "Authorizing CloudFront prefix list on port ${CF_HTTP_ORIGIN_PORT}"

aws ec2 authorize-security-group-ingress --group-id "$ALB_SG_ID" \
  --ip-permissions "IpProtocol=tcp,FromPort=${CF_HTTP_ORIGIN_PORT},ToPort=${CF_HTTP_ORIGIN_PORT},PrefixListIds=[{PrefixListId=${PL_ID}}]" \
  > /dev/null 2>&1 && info "Prefix list rule added" \
  || warn "Prefix list rule may already exist (continuing)"

# ── Revoke the wide-open rules ───────────────────────────────
step "Revoking 0.0.0.0/0 rules on ports 443 and 80"

aws ec2 revoke-security-group-ingress --group-id "$ALB_SG_ID" \
  --protocol tcp --port 443 --cidr "0.0.0.0/0" > /dev/null 2>&1 \
  && info "Port 443 0.0.0.0/0 rule revoked" \
  || warn "Port 443 rule may already be absent"

aws ec2 revoke-security-group-ingress --group-id "$ALB_SG_ID" \
  --protocol tcp --port 80 --cidr "0.0.0.0/0" > /dev/null 2>&1 \
  && info "Port 80 0.0.0.0/0 rule revoked" \
  || warn "Port 80 rule may already be absent"

# ── Post-lockdown sanity check ───────────────────────────────
step "Verifying site still reachable through CloudFront"

sleep 3
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  --max-time 15 "https://${FQDN}/" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  info "https://${FQDN}/ → 200 (still reachable via CloudFront)"
else
  err "https://${FQDN}/ → ${HTTP_CODE} — something broke!"
  err ""
  err "Attempting automatic rollback..."
  bash "$(dirname "$0")/08c-lockdown-alb.sh" --revert
  exit 1
fi

banner "Phase 8c Complete"
echo "  ALB is now locked down to CloudFront only."
echo ""
echo "  Direct access to the ALB DNS name will timeout."
echo "  All user traffic now flows through CloudFront edge."
echo ""
echo "  If you need to roll back for any reason:"
echo "    bash 08c-lockdown-alb.sh --revert"
echo ""
