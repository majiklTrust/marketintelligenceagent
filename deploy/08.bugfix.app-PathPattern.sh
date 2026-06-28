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
# Phase 8d: Add literal /app behavior to CloudFront distribution
# ═══════════════════════════════════════════════════════════════
# Fixes the /app no-trailing-slash routing bug. The existing
# /app/* pattern does not match a bare /app request — it falls
# through to the default behavior (S3) and returns AccessDenied.
# This script adds a new cache behavior with the literal pattern
# /app, pointing at the ALB origin, so post-login redirects from
# Auth0 to /app reach the dashboard correctly.
#
# Idempotent: if the behavior already exists, the script reports
# that and exits cleanly without modifying the distribution.
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"
banner "Phase 8d: Add /app behavior to CloudFront"

CF_ID=$(require_state CF_ID)
info "Distribution: $CF_ID"

# ── Fetch current config + ETag ──────────────────────────────
step "Fetching current distribution config"

CONFIG_JSON=$(aws cloudfront get-distribution-config --id "$CF_ID")
ETAG=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['ETag'])")
info "ETag: $ETAG"

# ── Build updated config via Python ──────────────────────────
# We extract the DistributionConfig, check whether a behavior
# with PathPattern='/app' already exists, and if not, insert a
# new one cloned from the /app/* behavior (so the cache policy,
# origin request policy, and method list stay consistent).
step "Injecting /app behavior"

CONFIG_IN_FILE=$(mktemp)
NEW_CONFIG_FILE=$(mktemp)
trap "rm -f '$CONFIG_IN_FILE' '$NEW_CONFIG_FILE'" EXIT

echo "$CONFIG_JSON" > "$CONFIG_IN_FILE"

python3 - "$CONFIG_IN_FILE" "$NEW_CONFIG_FILE" <<'PYEOF'
import json, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

config = data["DistributionConfig"]
behaviors = config["CacheBehaviors"]["Items"]

# Already present? Exit 2 to signal "no change needed".
if any(b.get("PathPattern") == "/app" for b in behaviors):
    print("ALREADY_PRESENT")
    sys.exit(2)

# Find the /app/* behavior and clone it. This inherits the
# CachePolicyId, OriginRequestPolicyId, AllowedMethods, and
# TargetOriginId we want without hardcoding them.
template = next((b for b in behaviors if b.get("PathPattern") == "/app/*"), None)
if template is None:
    print("ERROR: /app/* behavior not found — distribution is unexpected")
    sys.exit(3)

new_behavior = json.loads(json.dumps(template))  # deep copy
new_behavior["PathPattern"] = "/app"

# Insert right before /app/* so the two app behaviors group
# together in the listing. Order doesn't affect matching since
# /app and /app/* are mutually exclusive patterns.
insert_at = next(i for i, b in enumerate(behaviors) if b.get("PathPattern") == "/app/*")
behaviors.insert(insert_at, new_behavior)
config["CacheBehaviors"]["Quantity"] = len(behaviors)

with open(sys.argv[2], "w") as f:
    json.dump(config, f)
print("INJECTED")
PYEOF

PY_EXIT=$?

case $PY_EXIT in
  0)
    info "New /app behavior injected"
    ;;
  2)
    info "/app behavior is already present — no changes needed"
    banner "Phase 8d: Nothing to do"
    exit 0
    ;;
  *)
    err "Config edit failed"
    exit 1
    ;;
esac

# ── Push updated config ──────────────────────────────────────
step "Updating distribution"

aws cloudfront update-distribution \
  --id "$CF_ID" \
  --if-match "$ETAG" \
  --distribution-config "file://${NEW_CONFIG_FILE}" > /dev/null

info "Distribution update accepted"

# ── Issue invalidation so cached 403s for /app clear ─────────
step "Invalidating cached /app responses"

INV_ID=$(aws cloudfront create-invalidation \
  --distribution-id "$CF_ID" \
  --paths "/app" \
  --query 'Invalidation.Id' --output text)
info "Invalidation: $INV_ID"

banner "Phase 8d Complete"
echo "  The distribution is now propagating the new behavior."
echo "  Status will return to 'Deployed' in ~5 minutes."
echo ""
echo "  Watch status with:"
echo "    aws cloudfront get-distribution --id $CF_ID --query 'Distribution.Status' --output text"
echo ""
echo "  Or wait for deployment (same polling script as phase 8b):"
echo "    bash 08b-wait-cloudfront.sh"
echo ""
echo "  Once Deployed, log in again and confirm /app loads the dashboard."
