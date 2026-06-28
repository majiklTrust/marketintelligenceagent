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
# Phase 3b: Wait for ACM Certificate Validation
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"
banner "Phase 3b: Waiting for Certificate Validation"

CERT_ARN=$(require_state CERT_ARN)

echo "  Certificate: $CERT_ARN"
echo "  Polling every 30 seconds... (Ctrl+C to stop, rerun later)"
echo ""

MAX_ATTEMPTS=40  # 20 minutes
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  STATUS=$(aws acm describe-certificate \
    --certificate-arn "$CERT_ARN" \
    --query 'Certificate.Status' --output text)

  if [ "$STATUS" = "ISSUED" ]; then
    info "Certificate validated and issued!"
    save_state CERT_STATUS "ISSUED"
    echo ""
    echo "  Next: bash 04-compute.sh"
    exit 0
  fi

  ATTEMPT=$((ATTEMPT + 1))
  echo "  [$ATTEMPT/$MAX_ATTEMPTS] Status: $STATUS — waiting 30s..."
  sleep 30
done

err "Certificate did not validate within 20 minutes."
echo "  Verify the CNAME record is correct:"
echo "    Name:  $(load_state CERT_CNAME_NAME)"
echo "    Value: $(load_state CERT_CNAME_VALUE)"
echo ""
echo "  Check with:  dig CNAME $(load_state CERT_CNAME_NAME)"
echo "  Rerun this script after fixing the DNS record."
exit 1
