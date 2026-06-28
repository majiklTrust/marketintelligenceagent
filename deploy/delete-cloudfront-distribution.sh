#!/usr/bin/env bash
#
# Copyright (c) 2026 majiklTrust Market Intelligence, LLC. All rights reserved.
#
# This file is part of Market Intelligence and contains proprietary and
# confidential information. Unauthorized copying, modification, distribution,
# or use of this file, via any medium, is strictly prohibited without the
# express written permission of the copyright holder.
#

# ═════════════════════════════════════════════════════════════
# delete-cloudfront-distribution.sh
# ═════════════════════════════════════════════════════════════
# DESTRUCTIVE. Disables, then deletes a CloudFront distribution
# and offers cleanup of resources that became orphaned by the
# deletion (OACs, custom policies, ACM cert).
#
# Usage:
#   bash delete-cloudfront-distribution.sh <DISTRIBUTION_ID> [--audit-report FILE]
#
# Required:
#   DISTRIBUTION_ID  the CloudFront distribution to delete (e.g. E28BNMI6YCHQ2O)
#
# Optional:
#   --audit-report FILE  path to a JSON report from audit-cloudfront-state.sh.
#                        If supplied, the script identifies dependencies that
#                        ONLY the target distribution referenced (i.e., became
#                        orphaned by its deletion) and offers to clean them.
#                        Without this flag, only the distribution is deleted.
#
# Behavior:
#   - Refuses to run without the audit report unless --no-audit is set.
#   - Asks for explicit confirmation before each destructive action.
#   - Logs each action to ./.cloudfront-deletion-<timestamp>.log.
#
# Requires: aws cli, jq.
# ═════════════════════════════════════════════════════════════

set -euo pipefail

# ── Args ─────────────────────────────────────────────────────
DIST_ID=""
AUDIT_REPORT=""
NO_AUDIT=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --audit-report)
            AUDIT_REPORT="$2"; shift 2 ;;
        --no-audit)
            NO_AUDIT=1; shift ;;
        --help|-h)
            sed -n '4,28p' "$0"; exit 0 ;;
        -*)
            echo "ERROR: unknown flag: $1" >&2; exit 1 ;;
        *)
            if [[ -z "$DIST_ID" ]]; then DIST_ID="$1"; else
                echo "ERROR: unexpected positional arg: $1" >&2; exit 1
            fi
            shift ;;
    esac
done

if [[ -z "$DIST_ID" ]]; then
    echo "ERROR: distribution ID is required" >&2
    echo "Usage: $0 <DISTRIBUTION_ID> [--audit-report FILE]" >&2
    exit 1
fi

if [[ -z "$AUDIT_REPORT" && "$NO_AUDIT" -eq 0 ]]; then
    echo "ERROR: --audit-report is required (or pass --no-audit to skip dependency cleanup)" >&2
    echo "Run audit-cloudfront-state.sh first to produce the report." >&2
    exit 1
fi

if [[ -n "$AUDIT_REPORT" && ! -f "$AUDIT_REPORT" ]]; then
    echo "ERROR: audit report not found: $AUDIT_REPORT" >&2
    exit 1
fi

for cmd in aws jq; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: required: $cmd" >&2; exit 1; }
done

TS=$(date -u +%Y%m%dT%H%M%SZ)
LOG="./.cloudfront-deletion-${TS}.log"
echo "==> Logging to: $LOG"
exec > >(tee -a "$LOG") 2>&1

# ── Helpers ──────────────────────────────────────────────────
confirm() {
    local prompt="$1"
    local reply
    read -r -p "${prompt} [y/N]: " reply
    [[ "$reply" =~ ^[Yy]$ ]]
}

# ── Verify the distribution exists and capture state ─────────
echo "==> Verifying distribution $DIST_ID exists..."
if ! aws cloudfront get-distribution --id "$DIST_ID" >/dev/null 2>&1; then
    echo "ERROR: distribution $DIST_ID not found in this account" >&2
    exit 1
fi

DIST_INFO=$(aws cloudfront get-distribution --id "$DIST_ID" \
    --query "Distribution.{Status:Status,Enabled:DistributionConfig.Enabled,DomainName:DomainName,Aliases:DistributionConfig.Aliases.Items,Origins:DistributionConfig.Origins.Items[].DomainName,Cert:DistributionConfig.ViewerCertificate.ACMCertificateArn,OACs:DistributionConfig.Origins.Items[].OriginAccessControlId}" \
    --output json)

echo
echo "Distribution to delete:"
echo "$DIST_INFO" | jq .
echo

if ! confirm "Proceed with disable + delete of $DIST_ID?"; then
    echo "Cancelled."; exit 0
fi

# ── Step 1: Disable ──────────────────────────────────────────
ENABLED=$(echo "$DIST_INFO" | jq -r '.Enabled')
if [[ "$ENABLED" == "true" ]]; then
    echo "==> Disabling distribution (this triggers a deploy that takes 5-10 min)..."
    aws cloudfront get-distribution-config --id "$DIST_ID" > /tmp/dist-${DIST_ID}.json
    ETAG=$(jq -r '.ETag' /tmp/dist-${DIST_ID}.json)
    jq '.DistributionConfig | .Enabled = false' /tmp/dist-${DIST_ID}.json > /tmp/dist-${DIST_ID}-disabled.json

    aws cloudfront update-distribution \
        --id "$DIST_ID" \
        --distribution-config "file:///tmp/dist-${DIST_ID}-disabled.json" \
        --if-match "$ETAG" >/dev/null

    echo "==> Waiting for distribution to fully deploy the disabled state..."
    aws cloudfront wait distribution-deployed --id "$DIST_ID"
    echo "==> Disabled and deployed."
else
    echo "==> Distribution already disabled."
fi

# ── Step 2: Delete ───────────────────────────────────────────
echo "==> Deleting distribution..."
DEL_ETAG=$(aws cloudfront get-distribution --id "$DIST_ID" --query 'ETag' --output text)
aws cloudfront delete-distribution --id "$DIST_ID" --if-match "$DEL_ETAG"
echo "==> Distribution $DIST_ID deleted."

# Capture references for the orphan-cleanup phase before the
# in-memory snapshot becomes stale (the distribution is gone now,
# but DIST_INFO still has its origin/cert/OAC associations).
DELETED_OAC_IDS=$(echo "$DIST_INFO" | jq -r '.OACs[]? // empty' | sort -u | grep -v '^$' || true)
DELETED_CERT_ARN=$(echo "$DIST_INFO" | jq -r '.Cert // empty')

# ── Step 3: Optional dependency cleanup ──────────────────────
if [[ -z "$AUDIT_REPORT" ]]; then
    echo "==> Skipping dependency cleanup (--no-audit set)."
    echo "==> Done."
    exit 0
fi

echo
echo "============================================================"
echo "  Dependency cleanup"
echo "============================================================"
echo "Listing CloudFront resources that may have become orphaned."
echo "Each prompt is independent — answer N to keep, Y to delete."
echo

# OACs that were attached to the deleted distribution
if [[ -n "$DELETED_OAC_IDS" ]]; then
    echo "==> OACs that were attached to the deleted distribution:"
    for OAC_ID in $DELETED_OAC_IDS; do
        OAC_NAME=$(jq -r --arg id "$OAC_ID" '.oacs[] | select(.Id == $id) | .Name' "$AUDIT_REPORT")
        echo "    $OAC_ID  ($OAC_NAME)"

        # Verify nothing else still references it
        STILL_USED=$(aws cloudfront list-distributions \
            --query "DistributionList.Items[?Origins.Items[?OriginAccessControlId=='${OAC_ID}']].Id" \
            --output text)
        if [[ -n "$STILL_USED" ]]; then
            echo "    SKIPPING — still referenced by: $STILL_USED"
            continue
        fi

        if confirm "    Delete OAC $OAC_ID?"; then
            ETAG=$(aws cloudfront get-origin-access-control --id "$OAC_ID" --query 'ETag' --output text)
            aws cloudfront delete-origin-access-control --id "$OAC_ID" --if-match "$ETAG"
            echo "    Deleted."
        fi
    done
fi

# ACM cert (us-east-1) that was attached
if [[ -n "$DELETED_CERT_ARN" && "$DELETED_CERT_ARN" != "null" ]]; then
    echo
    echo "==> ACM cert that was attached to the deleted distribution:"
    echo "    $DELETED_CERT_ARN"

    # Re-check InUseBy after the distribution deletion. ACM updates this
    # asynchronously; if it still lists the deleted distribution, we
    # report and skip rather than guess.
    CERT_USED_BY=$(aws acm describe-certificate --region us-east-1 \
        --certificate-arn "$DELETED_CERT_ARN" \
        --query 'Certificate.InUseBy' --output json 2>/dev/null || echo "[]")
    USED_COUNT=$(echo "$CERT_USED_BY" | jq 'length')

    if [[ "$USED_COUNT" -gt 0 ]]; then
        echo "    Still listed as in-use by:"
        echo "$CERT_USED_BY" | jq -r '.[]' | sed 's/^/      /'
        echo "    SKIPPING — ACM may not have refreshed yet, or another resource uses this cert."
        echo "    Re-run this script's --no-audit cert-only prompt later, or delete manually."
    else
        if confirm "    Delete ACM cert $DELETED_CERT_ARN?"; then
            aws acm delete-certificate --region us-east-1 --certificate-arn "$DELETED_CERT_ARN"
            echo "    Deleted."
        fi
    fi
fi

# Custom policies — only show ones that aren't referenced anywhere.
# We don't know which custom policies the deleted distribution used
# (the audit report's distribution snapshot didn't capture policy IDs);
# instead, we list ALL custom policies in the account for manual review.
echo
echo "==> Custom CloudFront policies (account-wide, informational):"
echo "    These are not necessarily orphaned by THIS deletion;"
echo "    listed for manual review. This script does NOT auto-delete"
echo "    policies because verifying non-reference across every"
echo "    distribution is fragile and easy to get wrong."
echo

echo "  ── Response headers policies (custom) ──"
RESP=$(aws cloudfront list-response-headers-policies --type custom --output json 2>/dev/null \
    | jq -r '.ResponseHeadersPoliciesList.Items[]?.ResponseHeadersPolicy | "    \(.Id)  \(.ResponseHeadersPolicyConfig.Name)"')
[[ -n "$RESP" ]] && echo "$RESP" || echo "    (none)"

echo "  ── Cache policies (custom) ──"
CACHE=$(aws cloudfront list-cache-policies --type custom --output json 2>/dev/null \
    | jq -r '.CachePolicyList.Items[]?.CachePolicy | "    \(.Id)  \(.CachePolicyConfig.Name)"')
[[ -n "$CACHE" ]] && echo "$CACHE" || echo "    (none)"

echo "  ── Origin request policies (custom) ──"
ORIG=$(aws cloudfront list-origin-request-policies --type custom --output json 2>/dev/null \
    | jq -r '.OriginRequestPolicyList.Items[]?.OriginRequestPolicy | "    \(.Id)  \(.OriginRequestPolicyConfig.Name)"')
[[ -n "$ORIG" ]] && echo "$ORIG" || echo "    (none)"

echo
echo "============================================================"
echo "Distribution deletion complete. Log: $LOG"
