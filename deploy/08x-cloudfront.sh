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
# Phase 8x: Remove CloudFront — Revert to ALB-Direct
# ═══════════════════════════════════════════════════════════════
# Undoes Phase 8 only. Removes CloudFront distribution, OAC,
# S3 maintenance folder, and bucket policy statement.
# Does NOT touch any other infrastructure.
#
# After this script, update DNS to point back to the ALB.
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"

# Override set -e — must continue past individual failures
set +e

banner "Phase 8x: Remove CloudFront"

ALB_DNS=$(require_state ALB_DNS)
CF_ID=$(load_state CF_ID)
OAC_ID=$(load_state OAC_ID)
S3_BUCKET=$(load_state S3_BUCKET)
S3_PREFIX=$(load_state S3_PREFIX)
CF_POLICY_SID=$(load_state CF_POLICY_SID)

if [ -z "$CF_ID" ]; then
  echo "  No CloudFront distribution found in state file."
  echo "  Phase 8 may not have been run. Nothing to undo."
  exit 0
fi

ERRORS=0

try_delete() {
  local label="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    info "$label"
  else
    err "$label — FAILED"
    ERRORS=$((ERRORS + 1))
  fi
}

# ── Disable CloudFront Distribution ───────────────────────────
step "Disabling CloudFront distribution ${CF_ID}"

ETAG=$(aws cloudfront get-distribution-config --id "$CF_ID" \
  --query 'ETag' --output text 2>/dev/null || echo "")

if [ -n "$ETAG" ] && [ "$ETAG" != "None" ]; then
  DIST_CONFIG=$(aws cloudfront get-distribution-config --id "$CF_ID" \
    --query 'DistributionConfig' 2>/dev/null)

  DISABLED_CONFIG=$(echo "$DIST_CONFIG" | python3 -c "
import sys, json
cfg = json.load(sys.stdin)
cfg['Enabled'] = False
print(json.dumps(cfg))
" 2>/dev/null || echo "")

  if [ -n "$DISABLED_CONFIG" ]; then
    aws cloudfront update-distribution --id "$CF_ID" \
      --if-match "$ETAG" \
      --distribution-config "$DISABLED_CONFIG" > /dev/null 2>&1 \
      && info "Distribution disabled" || err "Failed to disable distribution"

    step "Waiting for distribution to finish disabling"
    echo "  This typically takes 3-5 minutes..."
    aws cloudfront wait distribution-deployed --id "$CF_ID" 2>/dev/null || sleep 180
    info "Distribution disabled and deployed"
  else
    err "Could not parse distribution config"
  fi
else
  err "Could not retrieve distribution ETag — may already be deleted"
fi

# ── Delete CloudFront Distribution ────────────────────────────
step "Deleting CloudFront distribution"

ETAG=$(aws cloudfront get-distribution-config --id "$CF_ID" \
  --query 'ETag' --output text 2>/dev/null || echo "")

if [ -n "$ETAG" ] && [ "$ETAG" != "None" ]; then
  try_delete "CloudFront distribution deleted" \
    aws cloudfront delete-distribution --id "$CF_ID" --if-match "$ETAG"
else
  err "Could not retrieve ETag for deletion"
fi

# ── Delete OAC ────────────────────────────────────────────────
step "Deleting Origin Access Control"

if [ -n "$OAC_ID" ]; then
  OAC_ETAG=$(aws cloudfront get-origin-access-control --id "$OAC_ID" \
    --query 'ETag' --output text 2>/dev/null || echo "")
  if [ -n "$OAC_ETAG" ] && [ "$OAC_ETAG" != "None" ]; then
    try_delete "Origin Access Control deleted" \
      aws cloudfront delete-origin-access-control --id "$OAC_ID" --if-match "$OAC_ETAG"
  else
    err "OAC $OAC_ID — could not retrieve ETag"
  fi
fi

# ── Remove S3 Maintenance Folder ──────────────────────────────
step "Removing maintenance folder from S3"

if [ -n "$S3_BUCKET" ] && [ -n "$S3_PREFIX" ]; then
  aws s3 rm "s3://${S3_BUCKET}/${S3_PREFIX}/" --recursive > /dev/null 2>&1 \
    && info "Folder ${S3_PREFIX}/ removed from ${S3_BUCKET}" \
    || err "Failed to remove folder"
fi

# ── Remove Bucket Policy Statement ────────────────────────────
step "Removing CloudFront policy statement from bucket"

if [ -n "$S3_BUCKET" ] && [ -n "$CF_POLICY_SID" ]; then
  EXISTING_POLICY=$(aws s3api get-bucket-policy --bucket "$S3_BUCKET" \
    --query 'Policy' --output text 2>/dev/null || echo "")

  if [ -n "$EXISTING_POLICY" ]; then
    CLEANED_POLICY=$(echo "$EXISTING_POLICY" | python3 -c "
import sys, json
policy = json.loads(sys.stdin.read())
policy['Statement'] = [s for s in policy['Statement'] if s.get('Sid') != '${CF_POLICY_SID}']
if policy['Statement']:
    print(json.dumps(policy))
else:
    print('')
" 2>/dev/null || echo "")

    if [ -n "$CLEANED_POLICY" ]; then
      aws s3api put-bucket-policy --bucket "$S3_BUCKET" \
        --policy "$CLEANED_POLICY" > /dev/null 2>&1 \
        && info "Policy statement '${CF_POLICY_SID}' removed (other statements preserved)" \
        || err "Failed to update bucket policy"
    else
      aws s3api delete-bucket-policy --bucket "$S3_BUCKET" > /dev/null 2>&1 \
        && info "Bucket policy removed (was the only statement)" \
        || err "Failed to delete bucket policy"
    fi
  fi
fi

info "Bucket ${S3_BUCKET} preserved (shared resource)"

# ── Clean State File ──────────────────────────────────────────
step "Removing CloudFront entries from state file"

for KEY in CF_ID CF_DOMAIN OAC_ID S3_BUCKET S3_PREFIX CF_POLICY_SID; do
  if [ -f "$STATE_FILE" ]; then
    grep -v "^${KEY}=" "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null || true
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
  fi
done

info "State file cleaned"

# ── Summary ───────────────────────────────────────────────────
banner "Phase 8x Complete — CloudFront Removed"

if [ $ERRORS -gt 0 ]; then
  echo "  ⚠ ${ERRORS} step(s) had errors. Check above."
else
  echo "  ✓ All CloudFront resources removed."
fi

echo ""
echo "  ACTION REQUIRED: Update DNS Record"
echo ""
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  Type:  CNAME                                           │"
echo "  │  Name:  ${SUBDOMAIN}                                    │"
echo "  │  Value: ${ALB_DNS}                                      │"
echo "  └─────────────────────────────────────────────────────────┘"
echo ""
echo "  Change the CNAME back from CloudFront to the ALB."
echo "  After DNS propagates, traffic goes directly to the ALB."
echo "  502/503 errors will show the raw ALB error page."
echo ""
echo "  To re-enable CloudFront later: bash 08-cloudfront.sh"
