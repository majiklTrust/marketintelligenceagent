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
# Phase 6a: Application Runtime Validation
# ═══════════════════════════════════════════════════════════════
# Lightweight pass/fail checks of the application on EC2, run
# between phase 6 (deploy) and phase 7 (full verify). Uses the
# caller's `ec2-cmd` wrapper to execute commands on the instance.
#
# REQUIRES: `ec2-cmd` available in the calling shell. Since it
# is typically a bash function, either export it first:
#
#     export -f ec2-cmd
#     bash 06a-validation.sh
#
# or source this script:
#
#     . 06a-validation.sh
# ═══════════════════════════════════════════════════════════════

set -uo pipefail

# ── Configuration ────────────────────────────────────────────
APP_NAME="marketintelligence-agent"
APP_PORT=3001
STATUS_PATH="/api/status"

# ── Sourced vs subprocess detection ──────────────────────────
# `return` at script top level only works when sourced; this
# lets `finish` use the right termination primitive so sourcing
# the script does not kill the caller's interactive shell.
(return 0 2>/dev/null) && SOURCED=1 || SOURCED=0
finish() {
  if [ "$SOURCED" = "1" ]; then return "$1"; else exit "$1"; fi
}

# ── ec2-cmd: run a command on the EC2 instance ───────────────
# Reads EIP_PUBLIC from the local .deploy-state file and runs
# the supplied command via SSH using the project's key pair.
# Must be invoked from the deploy/ directory (paths are relative).
ec2-cmd() { EIP=$(grep EIP_PUBLIC ./.deploy-state | tail -1 | cut -d= -f2) && ssh -i ./keys/mjagt-alph-maji-com-key ${SSH_USER}@$EIP $*; }

# ── Require ec2-cmd ──────────────────────────────────────────
if ! type ec2-cmd > /dev/null 2>&1; then
  echo "ERROR: ec2-cmd is not available in this shell." >&2
  echo "" >&2
  echo "  If ec2-cmd is a bash function, export it first:" >&2
  echo "    export -f ec2-cmd" >&2
  echo "    bash 06a-validation.sh" >&2
  echo "" >&2
  echo "  Or source this script instead of running it:" >&2
  echo "    . 06a-validation.sh" >&2
  finish 1
fi

PASS=0
FAIL=0
pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
step() { echo ""; echo "── $* ──"; }

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Phase 6a: Application Runtime Validation"
echo "═══════════════════════════════════════════════════════════"

# ── 1. PM2 process status ────────────────────────────────────
# pm2 jlist returns a JSON array of managed processes. We find
# the entry whose name matches $APP_NAME and read its status.
step "PM2 process status"
PM2_JSON=$(ec2-cmd "pm2 jlist" 2>/dev/null || echo "[]")
PM2_STATUS=$(echo "$PM2_JSON" | python3 -c "
import sys, json
try:
    apps = json.load(sys.stdin)
except Exception:
    print('PARSE_ERROR'); sys.exit(0)
match = [a for a in apps if a.get('name') == '$APP_NAME']
if not match:
    print('NOT_FOUND')
else:
    print(match[0].get('pm2_env', {}).get('status', 'UNKNOWN'))
" 2>/dev/null || echo "PARSE_ERROR")

case "$PM2_STATUS" in
  online)      pass "PM2: $APP_NAME is online" ;;
  NOT_FOUND)   fail "PM2: $APP_NAME not in process list" ;;
  PARSE_ERROR) fail "PM2: could not parse 'pm2 jlist' output" ;;
  *)           fail "PM2: $APP_NAME status is '$PM2_STATUS' (expected: online)" ;;
esac

# ── 2. Recent error log scan ─────────────────────────────────
# Count lines in the last 50 log entries that match error-like
# keywords. The pm2 --nostream header prints the log file paths
# (e.g., "/home/${SSH_USER}/.pm2/logs/marketintelligence-agent-error.log
# last 50 lines:") which would otherwise match 'error' and
# cause a false positive. Strip those header lines before
# counting. False positives from app log content are still
# possible (e.g., "no errors") — a zero count is a strong
# signal the app is not throwing, a non-zero count is a cue
# to inspect manually.
step "Recent error log scan (last 50 lines)"
ERR_COUNT=$(ec2-cmd "pm2 logs $APP_NAME --lines 50 --nostream 2>&1 | grep -vE 'last [0-9]+ lines:|^\[TAILING\]' | grep -ciE 'error|exception|fatal' || true" 2>/dev/null | tr -dc '0-9')
ERR_COUNT=${ERR_COUNT:-0}
if [ "$ERR_COUNT" = "0" ]; then
  pass "No error/exception/fatal strings in recent logs"
else
  fail "$ERR_COUNT error-like line(s) in recent logs — run 'ec2-cmd \"pm2 logs $APP_NAME\"' to inspect"
fi

# ── 3. Port listener ─────────────────────────────────────────
# Extract the local-address column from ss -tln for listeners
# on the app port. The address must not be loopback-only or
# the ALB health check (coming from the VPC subnet) will fail.
step "Port $APP_PORT listener"
LISTEN_LINE=$(ec2-cmd "ss -tln | awk '\$4 ~ /:$APP_PORT\$/ {print \$4}'" 2>/dev/null | tr -d '\r' | head -1)
if [ -z "$LISTEN_LINE" ]; then
  fail "Nothing listening on port $APP_PORT"
elif echo "$LISTEN_LINE" | grep -qE '^127\.0\.0\.1|^\[::1\]'; then
  fail "Port $APP_PORT is bound to loopback only ($LISTEN_LINE) — ALB health checks will fail"
else
  pass "Port $APP_PORT listener: $LISTEN_LINE"
fi

# ── 4. HTTP probe ────────────────────────────────────────────
# Same curl you validated by hand, wrapped for pass/fail parsing.
step "HTTP probe: http://localhost:$APP_PORT$STATUS_PATH"
HTTP_CODE=$(ec2-cmd "curl -sS -o /dev/null -w '%{http_code}' http://localhost:$APP_PORT$STATUS_PATH" 2>/dev/null | tr -dc '0-9')
if [ "$HTTP_CODE" = "200" ]; then
  pass "$STATUS_PATH → 200"
else
  fail "$STATUS_PATH → ${HTTP_CODE:-no response} (expected 200)"
fi

# ── Summary ──────────────────────────────────────────────────
echo ""
echo "────────────────────────────"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "────────────────────────────"
echo ""

if [ $FAIL -eq 0 ]; then
  echo "  Application is running correctly on the instance."
  echo "  Safe to proceed to phase 7 (bash 07-verify.sh)."
  finish 0
else
  echo "  Fix the failures above before running phase 7."
  finish 1
fi
