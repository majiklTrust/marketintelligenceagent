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
# Phase 7: Deployment Verification
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"
banner "Phase 7: Deployment Verification"

EIP_PUBLIC=$(require_state EIP_PUBLIC)
KEY_PATH=$(require_state KEY_PATH)
ALB_DNS=$(require_state ALB_DNS)
TG_ARN=$(require_state TG_ARN)

PASS=0
FAIL=0

run_check() {
  local label="$1" result="$2"
  if [ "$result" = "pass" ]; then
    info "$label"
    PASS=$((PASS + 1))
  else
    err "$label"
    FAIL=$((FAIL + 1))
  fi
}

# ── DNS Resolution (pre-check, must pass) ────────────────────
# This is the first check on purpose. If DNS for ${FQDN} does
# not resolve to something that looks like our load balancer or
# CloudFront distribution, every downstream check will fail with
# a confusing error (TLS CN mismatch, HTTP 000, etc.) that does
# not clearly point at DNS as the root cause. Abort early with
# a single actionable message instead of cascading false fails.
step "DNS resolution (pre-check)"

# `dig +short ${FQDN}` returns the full resolution chain — any
# CNAMEs followed by their resolved A records. Empty output
# means NXDOMAIN or no answer. Using `dig` without CNAME-only
# filtering tolerates DNS providers that flatten CNAMEs to A
# records (e.g., Cloudflare apex CNAME flattening).
DIG_OUTPUT=$(dig +short "${FQDN}" 2>/dev/null)

if [ -z "$DIG_OUTPUT" ]; then
  err "${FQDN} does not resolve in DNS."
  echo ""
  echo "  This usually means one of:"
  echo "    - The CNAME record at your DNS provider has not been"
  echo "      created yet. Check phase 5's output for the value."
  echo "    - The CNAME was created but DNS has not yet propagated"
  echo "      (typically 1-5 minutes, occasionally longer)."
  echo "    - The DNS provider's TTL is unusually long."
  echo ""
  echo "  Verify with:"
  echo "    dig +short ${FQDN}"
  echo ""
  echo "  Expected output: one or more lines, ending with an IP"
  echo "  address. If empty, DNS is not ready. Wait and retry."
  echo ""
  echo "  No other checks were run."
  exit 1
fi

# Detect whether the resolution chain points at our ALB or
# at CloudFront. Some DNS providers (e.g., Cloudflare) flatten
# CNAMEs at the apex and return A records only, so we cannot
# rely on seeing 'elb.amazonaws.com' or 'cloudfront.net' in
# dig output. In that case we fall back to resolving the known
# target hostnames and checking whether their IP sets overlap
# with ${FQDN}'s IP set.
DNS_TARGET="unknown"

# Path 1: CNAME chain visible in dig output (non-flattening DNS).
if echo "$DIG_OUTPUT" | grep -qi "cloudfront.net"; then
  DNS_TARGET="cloudfront"
elif echo "$DIG_OUTPUT" | grep -qi "elb.amazonaws.com"; then
  DNS_TARGET="alb"
fi

# Path 2: flattened DNS — compare IP sets. Extract the IPv4
# addresses from the FQDN resolution, then resolve the known
# target hostnames and look for any address in common. A single
# overlap is proof the FQDN is pointing at that target.
if [ "$DNS_TARGET" = "unknown" ]; then
  FQDN_IPS=$(echo "$DIG_OUTPUT" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')

  if [ -n "$FQDN_IPS" ]; then
    # Compare against ALB's IPs
    ALB_IPS=$(dig +short "$ALB_DNS" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
    if [ -n "$ALB_IPS" ]; then
      for ip in $FQDN_IPS; do
        if echo "$ALB_IPS" | grep -qxF "$ip"; then
          DNS_TARGET="alb-by-ip"
          break
        fi
      done
    fi

    # Compare against CloudFront distribution's IPs if we have one
    if [ "$DNS_TARGET" = "unknown" ]; then
      CF_DOMAIN_STATE=$(load_state CF_DOMAIN || true)
      if [ -n "$CF_DOMAIN_STATE" ]; then
        CF_IPS=$(dig +short "$CF_DOMAIN_STATE" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
        if [ -n "$CF_IPS" ]; then
          for ip in $FQDN_IPS; do
            if echo "$CF_IPS" | grep -qxF "$ip"; then
              DNS_TARGET="cloudfront-by-ip"
              break
            fi
          done
        fi
      fi
    fi
  fi
fi

case "$DNS_TARGET" in
  cloudfront)
    run_check "${FQDN} resolves via CloudFront edge (CNAME chain visible)" "pass"
    ;;
  cloudfront-by-ip)
    run_check "${FQDN} resolves via CloudFront edge (IPs match distribution, flattened DNS)" "pass"
    ;;
  alb)
    run_check "${FQDN} resolves via ALB (CNAME chain visible, CloudFront not yet in front)" "pass"
    ;;
  alb-by-ip)
    run_check "${FQDN} resolves via ALB (IPs match, flattened DNS, CloudFront not yet in front)" "pass"
    ;;
  unknown)
    err "${FQDN} resolves but the target does not look like our infrastructure."
    echo ""
    echo "  dig output for ${FQDN}:"
    echo "$DIG_OUTPUT" | sed 's/^/    /'
    echo ""
    echo "  Neither the CNAME text ('elb.amazonaws.com' / 'cloudfront.net')"
    echo "  nor the resolved IPs match the ALB ($ALB_DNS) or any known"
    echo "  CloudFront distribution for this deployment."
    echo ""
    echo "  Likely causes:"
    echo "    - A CNAME record at your DNS provider points somewhere else"
    echo "      (stale record from a prior deployment, or a typo)."
    echo "    - The ALB was replaced and DNS is still pointing at the"
    echo "      old one."
    echo ""
    echo "  No other checks were run."
    exit 1
    ;;
esac

# ── ALB Target Health ─────────────────────────────────────────
step "Target group health"

TG_HEALTH=$(aws elbv2 describe-target-health \
  --target-group-arn "$TG_ARN" \
  --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text)

if [ "$TG_HEALTH" = "healthy" ]; then
  run_check "Target group: healthy" "pass"
else
  run_check "Target group: ${TG_HEALTH} (expected: healthy)" "fail"
  if [ "$TG_HEALTH" = "initial" ]; then
    echo "    Target may still be registering. Wait 30s and rerun."
  fi
fi

# ── HTTPS Connectivity ────────────────────────────────────────
step "HTTPS endpoint checks"

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  --max-time 10 "https://${FQDN}/api/status" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  run_check "GET https://${FQDN}/api/status → 200" "pass"
else
  run_check "GET https://${FQDN}/api/status → ${HTTP_CODE} (expected 200)" "fail"
fi

# ── TLS Certificate ───────────────────────────────────────────
step "TLS certificate verification"

CERT_CN=$(echo | openssl s_client -servername "${FQDN}" -connect "${FQDN}:443" 2>/dev/null \
  | openssl x509 -noout -subject 2>/dev/null | grep -oP "CN\s*=\s*\K.*" || echo "FAILED")

if echo "$CERT_CN" | grep -q "${FQDN}"; then
  run_check "TLS certificate CN matches ${FQDN}" "pass"
else
  run_check "TLS certificate CN: ${CERT_CN} (expected ${FQDN})" "fail"
fi

# ── HTTP → HTTPS Redirect ────────────────────────────────────
step "HTTP → HTTPS redirect"

REDIRECT_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  --max-time 10 "http://${FQDN}/" 2>/dev/null || echo "000")

if [ "$REDIRECT_CODE" = "301" ]; then
  run_check "HTTP → HTTPS redirect (301)" "pass"
else
  run_check "HTTP redirect: ${REDIRECT_CODE} (expected 301)" "fail"
fi

# ── Security Headers ──────────────────────────────────────────
step "Security headers"

HEADERS=$(curl -s -I --max-time 10 "https://${FQDN}/api/status" 2>/dev/null)

for HEADER in "x-content-type-options" "x-frame-options" "content-security-policy" \
  "referrer-policy" "strict-transport-security"; do
  if echo "$HEADERS" | grep -qi "$HEADER"; then
    run_check "Header: $HEADER present" "pass"
  else
    run_check "Header: $HEADER MISSING" "fail"
  fi
done

# ── HSTS (production only) ────────────────────────────────────
HSTS_VAL=$(echo "$HEADERS" | grep -i "strict-transport-security" | head -1)
if echo "$HSTS_VAL" | grep -q "max-age=31536000"; then
  run_check "HSTS max-age=31536000" "pass"
else
  run_check "HSTS max-age check (got: ${HSTS_VAL:-MISSING})" "fail"
fi

# ── Auth0 Login Flow ─────────────────────────────────────────
step "Auth0 login redirect"

AUTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  --max-time 10 \
  "https://${FQDN}/auth/login" 2>/dev/null || echo "000")

if [ "$AUTH_CODE" = "302" ]; then
  AUTH_LOCATION=$(curl -s -I --max-time 10 \
    "https://${FQDN}/auth/login" 2>/dev/null \
    | grep -i "^location:" | head -1)
  if echo "$AUTH_LOCATION" | grep -qi "auth0.com"; then
    run_check "Auth0 login redirect → auth0.com" "pass"
  else
    run_check "Auth0 login redirect target (got: ${AUTH_LOCATION})" "fail"
  fi
else
  run_check "Auth0 login redirect (status: ${AUTH_CODE}, expected 302)" "fail"
fi

# ── Application Status ────────────────────────────────────────
step "Application status response"

STATUS_JSON=$(curl -s --max-time 10 "https://${FQDN}/api/status" 2>/dev/null)

AUTH_REQ=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('authRequired','MISSING'))" 2>/dev/null || echo "PARSE_ERROR")
if [ "$AUTH_REQ" = "True" ] || [ "$AUTH_REQ" = "true" ]; then
  run_check "authRequired: true (production mode)" "pass"
else
  run_check "authRequired: ${AUTH_REQ} (expected true in production)" "fail"
fi

# ── PM2 Process ───────────────────────────────────────────────
step "PM2 process status"

SSH="ssh -i ${KEY_PATH} -o StrictHostKeyChecking=no ${SSH_USER}@${EIP_PUBLIC}"
# Source nvm before invoking pm2: non-interactive SSH skips ~/.bashrc,
# so the nvm-managed Node binary directory isn't on PATH and `pm2` is
# not found. Sourcing nvm.sh adds the right path. The trailing '|| true'
# on the inner command keeps the pipe alive even if pm2 errors, so the
# python parser gets a deterministic empty input rather than a SIGPIPE.
PM2_STATUS=$($SSH 'source ~/.nvm/nvm.sh && pm2 jlist 2>/dev/null || true' | python3 -c \
  "import sys,json
try:
    apps = json.load(sys.stdin)
    print(apps[0]['pm2_env']['status'] if apps else 'NONE')
except Exception:
    print('UNKNOWN')" 2>/dev/null || echo "UNKNOWN")

if [ "$PM2_STATUS" = "online" ]; then
  run_check "PM2 process: online" "pass"
else
  run_check "PM2 process: ${PM2_STATUS} (expected online)" "fail"
fi

# ── CloudFront Edge Verification (if CloudFront is in front) ─
CF_ID_SAVED=$(load_state CF_ID || true)
if [ -n "$CF_ID_SAVED" ]; then
  step "CloudFront edge delivery verification"

  # Each static asset should:
  #   (a) return 200 OK
  #   (b) include the x-cache or via header proving it came from
  #       CloudFront (not directly from the ALB)
  # The X-Cache header values "Hit from cloudfront" or
  # "Miss from cloudfront" both prove edge involvement.
  for ASSET in "/" "/styles/alpha.css" "/scripts/site.js" "/app/styles/app.css"; do
    RESP_HEADERS=$(curl -s -I --max-time 10 "https://${FQDN}${ASSET}" 2>/dev/null || echo "")
    HTTP_CODE=$(echo "$RESP_HEADERS" | head -1 | awk '{print $2}')
    HAS_CF=$(echo "$RESP_HEADERS" | grep -i -E "^(x-cache|via):" | grep -i "cloudfront" | head -1)

    if [ "$HTTP_CODE" = "200" ] && [ -n "$HAS_CF" ]; then
      run_check "Edge: GET ${ASSET} → 200 (via CloudFront)" "pass"
    elif [ "$HTTP_CODE" = "200" ]; then
      run_check "Edge: GET ${ASSET} → 200 (no CloudFront header — DNS may still point at ALB)" "fail"
    else
      run_check "Edge: GET ${ASSET} → ${HTTP_CODE:-no-response}" "fail"
    fi
  done

  # Dashboard SPA shell should reach the ALB origin (not S3). The /app
  # route is auth-protected: unauthenticated callers (like this script)
  # receive a 301/302 redirect to the auth flow. That's the correct
  # behavior — receiving a redirect proves the route exists and auth
  # middleware is wired. 200/304 cover authenticated cache outcomes
  # (none expected here, but kept for completeness).
  SPA_HEADERS=$(curl -s -I --max-time 10 "https://${FQDN}/app" 2>/dev/null || echo "")
  SPA_CODE=$(echo "$SPA_HEADERS" | head -1 | awk '{print $2}')
  case "$SPA_CODE" in
    200|304)
      run_check "Edge: GET /app → ${SPA_CODE} (dashboard SPA shell from origin)" "pass" ;;
    301|302)
      run_check "Edge: GET /app → ${SPA_CODE} (auth redirect, route protected)" "pass" ;;
    *)
      run_check "Edge: GET /app → ${SPA_CODE:-no-response}" "fail" ;;
  esac

  # API endpoint should reach the ALB origin and not be cached
  API_HEADERS=$(curl -s -I --max-time 10 "https://${FQDN}/api/status" 2>/dev/null || echo "")
  API_CODE=$(echo "$API_HEADERS" | head -1 | awk '{print $2}')
  API_CACHE=$(echo "$API_HEADERS" | grep -i "^x-cache:" | head -1)
  if [ "$API_CODE" = "200" ]; then
    run_check "Edge: GET /api/status → 200 (proxied to ALB)" "pass"
    if echo "$API_CACHE" | grep -qi "Hit from cloudfront"; then
      run_check "API caching disabled (got: ${API_CACHE})" "fail"
    fi
  fi
fi

# ── Summary ───────────────────────────────────────────────────
banner "Verification Results"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo ""

if [ $FAIL -eq 0 ]; then
  echo "  ✓ All checks passed. Deployment is live at:"
  echo "    https://${FQDN}"
  echo ""
  # echo "  Update Auth0 dashboard if not already done:"
  # echo "    Allowed Callback URLs: https://${FQDN}/auth/callback"
  # echo "    Allowed Logout URLs:   https://${FQDN}"
  # echo "    Allowed Web Origins:   https://${FQDN}"
else
  echo "  ⚠ ${FAIL} check(s) failed. Review above and fix before going live."
fi

# echo ""
# echo "  Useful commands:"
# echo "    SSH:       ssh -i ${KEY_PATH} ${SSH_USER}@${EIP_PUBLIC}"
# echo "    PM2 logs:  ssh -i ${KEY_PATH} ${SSH_USER}@${EIP_PUBLIC} 'pm2 logs'"
# echo "    Restart:   ssh -i ${KEY_PATH} ${SSH_USER}@${EIP_PUBLIC} 'cd marketintelligence-agent && pm2 restart marketintelligence-agent'"
# echo "    Redeploy:  ssh -i ${KEY_PATH} ${SSH_USER}@${EIP_PUBLIC} 'cd marketintelligence-agent && git pull && npm ci && npm run build_js && pm2 restart marketintelligence-agent'"
