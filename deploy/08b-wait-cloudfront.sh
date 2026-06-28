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
# Phase 8b: Wait for CloudFront distribution to deploy
# ═══════════════════════════════════════════════════════════════
# Polls the CloudFront distribution created in phase 8 until its
# status reaches 'Deployed'. This typically takes 10–20 minutes.
#
# Runs safely in the foreground — it prints periodic progress so
# you know it's alive. Ctrl+C to abort; the distribution will
# continue deploying in AWS and you can rerun this script later.
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"
banner "Phase 8b: Waiting for CloudFront deployment"

CF_ID=$(require_state CF_ID)
CF_DOMAIN=$(require_state CF_DOMAIN)

info "Distribution: $CF_ID"
info "Domain: $CF_DOMAIN"
echo ""

# ── Poll loop ────────────────────────────────────────────────
# The `aws cloudfront wait distribution-deployed` command polls
# internally but doesn't emit progress. We emulate it with our
# own loop so the operator gets periodic feedback.

START_TS=$(date +%s)
POLL_INTERVAL=30
MAX_WAIT_SECONDS=1800   # 30 minutes — generous upper bound

step "Polling distribution status every ${POLL_INTERVAL}s"

while true; do
  STATUS=$(aws cloudfront get-distribution \
    --id "$CF_ID" \
    --query 'Distribution.Status' --output text 2>/dev/null || echo "UNKNOWN")

  NOW=$(date +%s)
  ELAPSED=$((NOW - START_TS))
  MINS=$((ELAPSED / 60))
  SECS=$((ELAPSED % 60))

  if [ "$STATUS" = "Deployed" ]; then
    printf "\r  Status: Deployed (after %dm %02ds)                 \n" "$MINS" "$SECS"
    break
  fi

  if [ "$ELAPSED" -ge "$MAX_WAIT_SECONDS" ]; then
    echo ""
    err "Distribution did not reach 'Deployed' within ${MAX_WAIT_SECONDS}s."
    err "Current status: ${STATUS}"
    echo "  This is unusual but not necessarily broken. Check the AWS"
    echo "  console for the distribution and rerun this script if needed."
    exit 1
  fi

  printf "\r  Status: %-12s  elapsed: %dm %02ds" "$STATUS" "$MINS" "$SECS"
  sleep "$POLL_INTERVAL"
done

info "Distribution is live at: https://${CF_DOMAIN}/"

# ── Quick connectivity sanity check ──────────────────────────
# At this point the distribution is deployed, but DNS may not
# yet point at it. A direct HEAD to the CloudFront domain
# confirms the distribution itself is responding.
step "Testing direct CloudFront domain"

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  --max-time 15 "https://${CF_DOMAIN}/" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  info "https://${CF_DOMAIN}/ → 200 (majikl-site served from edge)"
elif [ "$HTTP_CODE" = "403" ]; then
  warn "https://${CF_DOMAIN}/ → 403"
  echo "  This usually means the S3 bucket policy hasn't propagated"
  echo "  yet. Wait 60 seconds and curl the domain again. If it"
  echo "  persists, check: aws s3api get-bucket-policy --bucket ${S3_BUCKET_NAME}"
else
  warn "https://${CF_DOMAIN}/ → ${HTTP_CODE}"
  echo "  Unexpected response. Check the CloudFront distribution"
  echo "  configuration in the AWS console."
fi

# ── Instructions ─────────────────────────────────────────────
banner "ACTION REQUIRED: Update DNS"
echo "  The CloudFront distribution is live. Now point ${FQDN} at it."
echo ""
echo "  Go to your DNS provider and UPDATE the existing CNAME record:"
echo ""
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  Type:  CNAME                                           │"
echo "  │  Name:  ${SUBDOMAIN}                                   "
echo "  │  Value: ${CF_DOMAIN}                                   "
echo "  └─────────────────────────────────────────────────────────┘"
echo ""
echo "  This replaces the previous CNAME (which pointed at the ALB)."
echo "  DNS propagation typically takes 1–5 minutes."
echo ""
echo "  Verify with:  dig CNAME ${FQDN}"
echo "  Expected:     ${FQDN} → ${CF_DOMAIN}"
echo ""
echo "  After DNS propagates, verify the full stack:"
echo ""
echo "    bash 07-verify.sh"
echo ""
echo "  Once verification passes, optionally lock down the ALB SG:"
echo ""
echo "    bash 08c-lockdown-alb.sh"
echo ""
