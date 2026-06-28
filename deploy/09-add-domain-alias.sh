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
# Phase 9: Add an additional domain alias to the EXISTING
#          CloudFront distribution (no new distribution).
# (09-add-domain-alias.sh)
# ═══════════════════════════════════════════════════════════════
# Makes the SAME site/app reachable at a second hostname (e.g.
# beta.marketintelligence.majikl.com) by adding an alternate domain
# name to the distribution created in phase 8. No second CloudFront
# instance is created; the TLS implementation is unchanged (ACM +
# SNI-only + the distribution's existing MinimumProtocolVersion).
#
# Why a (possibly new) certificate is unavoidable:
#   ACM certificates are IMMUTABLE — you cannot add a name to an
#   already-issued cert, and a CloudFront distribution has exactly
#   one viewer certificate that must cover EVERY alias. So adding a
#   name means the viewer cert must be one whose SAN list includes
#   that name. This script reuses an existing ISSUED cert that
#   already covers everything, or requests a new multi-SAN cert.
#   The cert *mechanism* does not change — only its SAN list grows.
#
# Additive across runs:
#   The required name set is computed from the distribution's CURRENT
#   aliases PLUS the new one, so swapping the cert never strands an
#   alias added by a prior run.
#
# What it does:
#   1. Reads the distribution's current Aliases.
#   2. Builds the required name set: current aliases ∪ config FQDN ∪
#      the new alias ∪ any --san names (e.g. a wildcard).
#   3. Reuses an ISSUED us-east-1 cert that covers all of them, or
#      requests a new DNS-validated multi-SAN cert and waits.
#   4. Adds the new alias and swaps the viewer cert in ONE atomic
#      update-distribution (CloudFront validates coverage on apply).
#   5. Prints the registrar CNAME and the Auth0 / LinkedIn / app
#      changes required for authenticated login at the new host.
#
# Idempotent:
#   - Alias already on the distribution  → reports and exits 0.
#   - Covering cert(s) found             → lists them and lets you
#     REUSE one, create a NEW one (leaving the old), or REPLACE
#     (delete the not-in-use ones, then create new). Default is an
#     interactive prompt; --yes auto-reuses; --cert-mode forces a path.
#   - The original single-domain cert (state CERT_ARN, used by the
#     ALB listener) is NOT touched or deleted.
#
# Usage:
#   bash 09-add-domain-alias.sh --alias beta.marketintelligence.majikl.com
#   bash 09-add-domain-alias.sh --alias beta.majikl.com --san '*.majikl.com'
#   bash 09-add-domain-alias.sh --alias x.foo.majikl.com --cert-mode reuse --yes
#   bash 09-add-domain-alias.sh --alias x.foo.majikl.com --cert-mode replace
#
#   --revert     Undo a prior add of the SAME --alias: removes it from the
#                distribution, restores the original viewer cert (state
#                CERT_ARN) when it still covers the remaining aliases,
#                offers to delete the cert this tool created, and clears
#                09's state keys. DNS and IdP removal stay manual.
#     bash 09-add-domain-alias.sh --alias beta.marketintelligence.majikl.com --revert
#
#   --cert-mode  prompt (default) | reuse | new | replace
#                prompt : ask when covering cert(s) exist
#                reuse  : use an existing covering cert (else request new)
#                new    : request a fresh cert, leave existing ones alone
#                replace: delete not-in-use covering certs, then request new
#   --yes        non-interactive; treats prompt as 'reuse'
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"

# ── Arguments ─────────────────────────────────────────────────
ALIAS_FQDN=""
EXTRA_SANS=()
ASSUME_YES="no"
CERT_MODE="prompt"        # prompt | reuse | new | replace
REVERT="no"               # --revert: remove the given --alias and restore original cert
CERT_WAIT_MAX_ATTEMPTS="${CERT_WAIT_MAX_ATTEMPTS:-40}"   # 40 × 30s = 20 min
CERT_WAIT_INTERVAL="${CERT_WAIT_INTERVAL:-30}"

while [ $# -gt 0 ]; do
  case "$1" in
    --alias)   ALIAS_FQDN="$2"; shift 2 ;;
    --alias=*) ALIAS_FQDN="${1#*=}"; shift ;;
    --san)     EXTRA_SANS+=("$2"); shift 2 ;;
    --san=*)   EXTRA_SANS+=("${1#*=}"); shift ;;
    --yes|-y)  ASSUME_YES="yes"; shift ;;
    --cert-mode)   CERT_MODE="$2"; shift 2 ;;
    --cert-mode=*) CERT_MODE="${1#*=}"; shift ;;
    --revert)  REVERT="yes"; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^#\{1,\} \{0,1\}//'; exit 0 ;;
    *) err "Unknown argument: $1"; echo "  Try: $(basename "$0") --help"; exit 1 ;;
  esac
done

banner "Phase 9: Add domain alias to CloudFront"

if [ -z "$ALIAS_FQDN" ]; then
  err "No alias supplied. Use --alias <fqdn>."
  echo "  Example: bash $(basename "$0") --alias beta.marketintelligence.${DOMAIN}"
  exit 1
fi

# Hostname sanity (concrete host; wildcards are cert-only, never aliases).
if ! echo "$ALIAS_FQDN" | grep -qE '^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$'; then
  err "Alias '${ALIAS_FQDN}' is not a valid hostname."
  exit 1
fi
case "$ALIAS_FQDN" in
  \**) err "A wildcard cannot be a concrete alias here. Pass it via --san instead."; exit 1 ;;
esac

case "$CERT_MODE" in
  prompt|reuse|new|replace) ;;
  *) err "Invalid --cert-mode '${CERT_MODE}' (use: prompt | reuse | new | replace)"; exit 1 ;;
esac

CF_ID=$(require_state CF_ID)
CF_DOMAIN=$(require_state CF_DOMAIN)
info "Distribution: $CF_ID ($CF_DOMAIN)"
info "Alias:        $ALIAS_FQDN"

# ── covers_all: wildcard-aware coverage test (used by apply + revert)
# A cert "name" covers a required name if equal, or if it is *.suffix
# and the required name has exactly one extra label before that suffix.
covers_all() {
  REQ="$1" COV="$2" python3 <<'PYEOF'
import os
req = [x for x in os.environ["REQ"].split("\n") if x]
cov = [x for x in os.environ["COV"].split("\n") if x]
def covers(name, pat):
    if name == pat:
        return True
    if pat.startswith("*."):
        suf = pat[1:]               # ".example.com"
        if name.endswith(suf):
            head = name[:-len(suf)]
            return bool(head) and "." not in head
    return False
missing = [n for n in req if not any(covers(n, c) for c in cov)]
print("OK" if not missing else "MISSING:" + ",".join(missing))
PYEOF
}

# ══════════════════════════════════════════════════════════════
# REVERT MODE (--revert): undo a prior add of THIS --alias.
#   1. Remove the alias from the distribution.
#   2. Restore the original viewer cert (state CERT_ARN) when it still
#      covers every remaining alias; otherwise leave the cert as-is.
#   3. Optionally delete the multi-SAN cert THIS tool created
#      (state ALIAS_CERT_ARN) once it is no longer in use.
#   4. Clear 09's state keys; print the manual DNS / IdP reminders.
# Idempotent: if the alias is absent, the distribution is untouched and
# only cert/state cleanup runs. Nothing is hardcoded — the alias comes
# from --alias and the original cert from state.
# ══════════════════════════════════════════════════════════════
if [ "$REVERT" = "yes" ]; then
  banner "Phase 9: REVERT — removing alias ${ALIAS_FQDN}"

  if [ "$ALIAS_FQDN" = "$FQDN" ]; then
    err "Refusing to remove the primary FQDN (${FQDN}) — that would take the main site offline."
    exit 1
  fi

  ORIG_CERT_ARN=$(require_state CERT_ARN)
  DIST_UPDATED="no"
  CFG=$(aws cloudfront get-distribution-config --id "$CF_ID")
  ETAG=$(printf '%s' "$CFG" | python3 -c "import sys,json; print(json.load(sys.stdin)['ETag'])")
  CUR_ALIASES=$(printf '%s' "$CFG" | python3 -c "import sys,json; print('\n'.join(json.load(sys.stdin)['DistributionConfig'].get('Aliases',{}).get('Items',[])))")
  CUR_CERT=$(printf '%s' "$CFG" | python3 -c "import sys,json; print(json.load(sys.stdin)['DistributionConfig'].get('ViewerCertificate',{}).get('ACMCertificateArn',''))")

  if ! printf '%s\n' "$CUR_ALIASES" | grep -qxF "$ALIAS_FQDN"; then
    info "Alias '${ALIAS_FQDN}' is not on the distribution — no CloudFront change needed"
  else
    REMAIN_NL=$(printf '%s\n' "$CUR_ALIASES" | grep -vxF "$ALIAS_FQDN" | awk 'NF')

    # Restore the original cert only if it covers every remaining alias.
    ORIG_SANS=$(aws acm describe-certificate --certificate-arn "$ORIG_CERT_ARN" \
      --query 'Certificate.SubjectAlternativeNames' --output text 2>/dev/null | tr '\t' '\n')
    TARGET_CERT="$CUR_CERT"
    if [ -z "$REMAIN_NL" ] || [ "$(covers_all "$REMAIN_NL" "$ORIG_SANS")" = "OK" ]; then
      TARGET_CERT="$ORIG_CERT_ARN"
      info "Will restore original viewer cert: $ORIG_CERT_ARN"
    else
      warn "Original cert does not cover remaining alias(es): $(printf '%s ' $REMAIN_NL)"
      warn "Leaving the current viewer cert in place"
    fi

    echo "  Remove alias:  ${ALIAS_FQDN}"
    echo "  Viewer cert →  ${TARGET_CERT}"
    if [ "$ASSUME_YES" != "yes" ]; then
      read -p "  Type 'revert' to proceed: " CONFIRM
      [ "$CONFIRM" = "revert" ] || { echo "  Aborted."; exit 1; }
    fi

    R_IN=$(mktemp); R_OUT=$(mktemp)
    trap 'rm -f "$R_IN" "$R_OUT"' EXIT
    printf '%s' "$CFG" > "$R_IN"
    ALIAS="$ALIAS_FQDN" CERTARN="$TARGET_CERT" python3 - "$R_IN" <<'PYEOF' > "$R_OUT"
import os, sys, json
with open(sys.argv[1]) as f:
    cfg = json.load(f)["DistributionConfig"]
alias = os.environ["ALIAS"]
cert  = os.environ["CERTARN"]
al = cfg.setdefault("Aliases", {"Quantity": 0, "Items": []})
al["Items"] = [a for a in al.get("Items", []) if a != alias]
al["Quantity"] = len(al["Items"])
vc = cfg.setdefault("ViewerCertificate", {})
vc["ACMCertificateArn"] = cert
vc["Certificate"] = cert
vc["CertificateSource"] = "acm"
vc.pop("CloudFrontDefaultCertificate", None)
vc.pop("IAMCertificateId", None)
json.dump(cfg, sys.stdout)
PYEOF
    aws cloudfront update-distribution --id "$CF_ID" --if-match "$ETAG" \
      --distribution-config "file://${R_OUT}" > /dev/null
    info "Removed alias; viewer cert set to ${TARGET_CERT}"
    DIST_UPDATED="yes"
  fi

  # Wait for the distribution to finish propagating BEFORE deleting any
  # cert. ACM's in-use flag clears when the config association updates,
  # but edge locations keep serving the OLD cert until propagation
  # completes — deleting it during that window causes TLS failures (the
  # alpha outage). Gate deletion on Status=Deployed, not ACM in-use.
  SKIP_CERT_DELETE="no"
  if [ "$DIST_UPDATED" = "yes" ]; then
    step "Waiting for CloudFront to redeploy before any cert cleanup"
    DA=0
    while [ "$DA" -lt "${DIST_WAIT_MAX_ATTEMPTS:-30}" ]; do
      DSTATUS=$(aws cloudfront get-distribution --id "$CF_ID" --query 'Distribution.Status' --output text 2>/dev/null || echo "Unknown")
      [ "$DSTATUS" = "Deployed" ] && { info "Distribution Deployed"; break; }
      DA=$((DA + 1))
      echo "  [$DA/${DIST_WAIT_MAX_ATTEMPTS:-30}] Status: $DSTATUS — waiting ${DIST_WAIT_INTERVAL:-30}s..."
      sleep "${DIST_WAIT_INTERVAL:-30}"
    done
    DSTATUS=$(aws cloudfront get-distribution --id "$CF_ID" --query 'Distribution.Status' --output text 2>/dev/null || echo "Unknown")
    if [ "$DSTATUS" != "Deployed" ]; then
      warn "Distribution still ${DSTATUS}; SKIPPING cert deletion to avoid a propagation-window outage"
      warn "Once it reaches Deployed, delete the old cert manually"
      SKIP_CERT_DELETE="yes"
    fi
  fi

  # Optionally delete the multi-SAN cert THIS tool created — but only
  # after the distribution reached Deployed (SKIP_CERT_DELETE gate), so
  # we never delete a cert that edges may still be serving.
  ALIAS_CERT_ARN=$(load_state ALIAS_CERT_ARN 2>/dev/null || true)
  CERT_DELETED="no"
  if [ -n "$ALIAS_CERT_ARN" ] && [ "$ALIAS_CERT_ARN" != "$ORIG_CERT_ARN" ]; then
    if [ "$SKIP_CERT_DELETE" = "yes" ]; then
      warn "Not Deployed yet — leaving created cert in place: $ALIAS_CERT_ARN"
    else
      INUSE=$(aws acm describe-certificate --certificate-arn "$ALIAS_CERT_ARN" \
        --query 'length(Certificate.InUseBy)' --output text 2>/dev/null || echo "0")
      if [ "$INUSE" != "0" ] && [ "$INUSE" != "None" ]; then
        warn "Created cert still shows in use (${INUSE}); leaving it: $ALIAS_CERT_ARN"
      else
        DODEL="$ASSUME_YES"
        if [ "$DODEL" != "yes" ]; then
          read -p "  Delete the cert this tool created (${ALIAS_CERT_ARN##*/})? [y/N]: " D
          case "$D" in [Yy]*) DODEL="yes" ;; *) DODEL="no" ;; esac
        fi
        if [ "$DODEL" = "yes" ]; then
          if aws acm delete-certificate --certificate-arn "$ALIAS_CERT_ARN" > /dev/null 2>&1; then
            info "Deleted certificate $ALIAS_CERT_ARN"
            CERT_DELETED="yes"
          else
            warn "Could not delete (try again shortly): $ALIAS_CERT_ARN"
          fi
        fi
      fi
    fi
  fi

  # Clear 09's state keys. Always drop CF_VIEWER_CERT_ARN; keep
  # ALIAS_CERT_ARN if the cert still exists so it stays discoverable.
  if [ -n "${STATE_FILE:-}" ] && [ -f "$STATE_FILE" ]; then
    sed -i '/^CF_VIEWER_CERT_ARN=/d' "$STATE_FILE" 2>/dev/null || true
    if [ "$CERT_DELETED" = "yes" ] || [ -z "$ALIAS_CERT_ARN" ]; then
      sed -i '/^ALIAS_CERT_ARN=/d' "$STATE_FILE" 2>/dev/null || true
    fi
    info "Updated deploy state"
  fi

  banner "Revert complete"
  exit 0
fi

# ── Fetch current distribution config + ETag ──────────────────
step "Reading current distribution configuration"

CONFIG_JSON=$(aws cloudfront get-distribution-config --id "$CF_ID")
ETAG=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['ETag'])")

# Current aliases (may be just the alpha FQDN).
CURRENT_ALIASES=$(echo "$CONFIG_JSON" | python3 -c "
import sys, json
cfg = json.load(sys.stdin)['DistributionConfig']
items = cfg.get('Aliases', {}).get('Items', [])
print('\n'.join(items))
")

# Idempotency: alias already present?
if printf '%s\n' "$CURRENT_ALIASES" | grep -qxF "$ALIAS_FQDN"; then
  info "Alias '${ALIAS_FQDN}' is already on the distribution — nothing to do."
  banner "Phase 9: No change needed"
  exit 0
fi

# ── Build the required certificate name set ───────────────────
# current aliases ∪ config FQDN ∪ new alias ∪ extra SANs, de-duped.
step "Computing required certificate coverage"

REQUIRED_NAMES=()
while IFS= read -r a; do [ -n "$a" ] && REQUIRED_NAMES+=("$a"); done <<< "$CURRENT_ALIASES"
REQUIRED_NAMES+=("$FQDN" "$ALIAS_FQDN")
if [ "${#EXTRA_SANS[@]}" -gt 0 ]; then
  for s in "${EXTRA_SANS[@]}"; do REQUIRED_NAMES+=("$s"); done
fi
readarray -t REQUIRED_NAMES < <(printf '%s\n' "${REQUIRED_NAMES[@]}" | awk 'NF && !seen[$0]++')
info "Viewer cert must cover: ${REQUIRED_NAMES[*]}"

REQ_NL=$(printf '%s\n' "${REQUIRED_NAMES[@]}")

# ── Find existing ISSUED certs that cover all required names ──
step "Looking for existing certificates that cover all names"

VIEWER_CERT_ARN=""
CERT_ARNS=$(aws acm list-certificates \
  --certificate-statuses ISSUED \
  --query 'CertificateSummaryList[].CertificateArn' --output text 2>/dev/null || echo "")

CERT_COUNT=$(printf '%s\n' $CERT_ARNS | awk 'NF' | wc -l | tr -d ' ')
info "Scanning ${CERT_COUNT} ISSUED certificate(s)"

# Collect every covering cert (not just the first) so duplicates from a
# prior partial run are surfaced rather than silently picked.
CANDIDATES=()
for arn in $CERT_ARNS; do
  # SubjectAlternativeNames already includes the primary DomainName,
  # so a single describe call yields the full covered-name set.
  COV_NL=$(aws acm describe-certificate --certificate-arn "$arn" \
    --query 'Certificate.SubjectAlternativeNames' --output text 2>/dev/null | tr '\t' '\n')
  if [ "$(covers_all "$REQ_NL" "$COV_NL")" = "OK" ]; then
    CANDIDATES+=("$arn")
  fi
done

# ── Decide: reuse / new / replace ─────────────────────────────
# CERT_MODE resolves the choice:
#   reuse   → use a covering cert (falls back to 'new' if none found)
#   new     → request a fresh cert, leave any existing covering ones
#   replace → delete the NOT-in-use covering certs, then request fresh
#   prompt  → ask interactively; with --yes, 'prompt' behaves as 'reuse'
DECISION="$CERT_MODE"

if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  info "No existing certificate covers all names — a new one is required"
  DECISION="new"
else
  step "Found ${#CANDIDATES[@]} certificate(s) covering all required names"
  idx=0
  for arn in "${CANDIDATES[@]}"; do
    idx=$((idx + 1))
    INUSE=$(aws acm describe-certificate --certificate-arn "$arn" \
      --query 'length(Certificate.InUseBy)' --output text 2>/dev/null || echo "0")
    SANS=$(aws acm describe-certificate --certificate-arn "$arn" \
      --query 'join(`, `, Certificate.SubjectAlternativeNames)' --output text 2>/dev/null || echo "")
    if [ "$INUSE" != "0" ] && [ "$INUSE" != "None" ]; then USESTR="IN USE (${INUSE} association(s))"; else USESTR="not in use"; fi
    echo "    ${idx}) ${arn}"
    echo "         SANs: ${SANS}"
    echo "         ${USESTR}"
  done

  if [ "$DECISION" = "prompt" ]; then
    if [ "$ASSUME_YES" = "yes" ]; then
      DECISION="reuse"
      info "--yes given: reusing the first covering certificate"
    else
      echo ""
      echo "    [r] Reuse an existing certificate (default)"
      echo "    [n] Create a NEW certificate, leave existing one(s) in place"
      echo "    [x] Delete the not-in-use covering certificate(s), then create new"
      echo "    [a] Abort"
      echo ""
      read -p "  Choice [R/n/x/a]: " CHOICE
      CHOICE=${CHOICE:-r}
      case "$CHOICE" in
        [Rr]*) DECISION="reuse" ;;
        [Nn]*) DECISION="new" ;;
        [Xx]*) DECISION="replace" ;;
        [Aa]*) echo "  Aborted."; exit 0 ;;
        *) err "Invalid choice: $CHOICE"; exit 1 ;;
      esac
    fi
  fi
fi

# Resolve DECISION into VIEWER_CERT_ARN (empty ⇒ request a new one below).
case "$DECISION" in
  reuse)
    if [ "${#CANDIDATES[@]}" -le 1 ] || [ "$ASSUME_YES" = "yes" ] || [ "$CERT_MODE" = "reuse" ]; then
      VIEWER_CERT_ARN="${CANDIDATES[0]}"
    else
      read -p "  Reuse which # [1]: " PICK
      PICK=${PICK:-1}
      if ! echo "$PICK" | grep -qE '^[0-9]+$' || [ "$PICK" -lt 1 ] || [ "$PICK" -gt "${#CANDIDATES[@]}" ]; then
        err "Invalid selection: $PICK"; exit 1
      fi
      VIEWER_CERT_ARN="${CANDIDATES[$((PICK - 1))]}"
    fi
    info "Reusing certificate: $VIEWER_CERT_ARN"
    ;;
  new)
    [ "${#CANDIDATES[@]}" -gt 0 ] && info "Leaving existing covering cert(s) in place; requesting a new one"
    VIEWER_CERT_ARN=""
    ;;
  replace)
    step "Deleting not-in-use covering certificate(s)"
    for arn in "${CANDIDATES[@]}"; do
      INUSE=$(aws acm describe-certificate --certificate-arn "$arn" \
        --query 'length(Certificate.InUseBy)' --output text 2>/dev/null || echo "0")
      if [ "$INUSE" != "0" ] && [ "$INUSE" != "None" ]; then
        warn "Skipping $arn — in use (${INUSE} association(s)); ACM will not delete an attached cert"
        continue
      fi
      if aws acm delete-certificate --certificate-arn "$arn" > /dev/null 2>&1; then
        info "Deleted $arn"
      else
        warn "Could not delete $arn (often a just-detached cert; retry shortly)"
      fi
    done
    VIEWER_CERT_ARN=""
    ;;
esac

# ── Request a new multi-SAN cert and wait (if none chosen) ────
if [ -z "$VIEWER_CERT_ARN" ]; then
  step "Requesting a new multi-SAN certificate (DNS validation, us-east-1)"

  # Primary = config FQDN (alpha); SANs = every other required name.
  SAN_ARGS=()
  for n in "${REQUIRED_NAMES[@]}"; do
    [ "$n" = "$FQDN" ] && continue
    SAN_ARGS+=("$n")
  done

  if [ "${#SAN_ARGS[@]}" -gt 0 ]; then
    VIEWER_CERT_ARN=$(aws acm request-certificate \
      --domain-name "$FQDN" \
      --subject-alternative-names "${SAN_ARGS[@]}" \
      --validation-method DNS \
      --query 'CertificateArn' --output text \
      --tags "Key=Name,Value=${PROJECT}-multi-cert" "Key=Project,Value=${PROJECT}")
  else
    VIEWER_CERT_ARN=$(aws acm request-certificate \
      --domain-name "$FQDN" \
      --validation-method DNS \
      --query 'CertificateArn' --output text \
      --tags "Key=Name,Value=${PROJECT}-multi-cert" "Key=Project,Value=${PROJECT}")
  fi
  save_state ALIAS_CERT_ARN "$VIEWER_CERT_ARN"
  info "Requested: $VIEWER_CERT_ARN"

  # Print the DNS validation record(s). ACM normally reuses the
  # existing per-domain CNAME, so usually only the NEW name needs one.
  sleep 5
  banner "ACTION REQUIRED: Add ACM validation CNAME(s)"
  echo "  Create any record below that is not already in your DNS zone."
  echo "  (Records for names you already validated — e.g. ${FQDN} — are"
  echo "   typically reused unchanged.)"
  echo ""
  aws acm describe-certificate --certificate-arn "$VIEWER_CERT_ARN" \
    --query 'Certificate.DomainValidationOptions[].{Name:ResourceRecord.Name,Value:ResourceRecord.Value,For:DomainName}' \
    --output text 2>/dev/null | while IFS=$'\t' read -r FOR NAME VALUE; do
      echo "  • for ${FOR}"
      echo "      Type:  CNAME"
      echo "      Name:  ${NAME}"
      echo "      Value: ${VALUE}"
      echo ""
    done

  step "Waiting for certificate to validate (ISSUED)"
  ATTEMPT=0
  while [ "$ATTEMPT" -lt "$CERT_WAIT_MAX_ATTEMPTS" ]; do
    STATUS=$(aws acm describe-certificate --certificate-arn "$VIEWER_CERT_ARN" \
      --query 'Certificate.Status' --output text 2>/dev/null || echo "UNKNOWN")
    if [ "$STATUS" = "ISSUED" ]; then
      info "Certificate ISSUED"
      break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    echo "  [$ATTEMPT/$CERT_WAIT_MAX_ATTEMPTS] Status: $STATUS — waiting ${CERT_WAIT_INTERVAL}s..."
    sleep "$CERT_WAIT_INTERVAL"
  done

  STATUS=$(aws acm describe-certificate --certificate-arn "$VIEWER_CERT_ARN" \
    --query 'Certificate.Status' --output text 2>/dev/null || echo "UNKNOWN")
  if [ "$STATUS" != "ISSUED" ]; then
    err "Certificate did not reach ISSUED (status: ${STATUS})."
    echo "  Add the validation CNAME(s) above, then re-run this script —"
    echo "  it will find the now-ISSUED cert and reuse it."
    exit 1
  fi
fi

# ── Confirm the distribution mutation ─────────────────────────
banner "Ready to update distribution ${CF_ID}"
echo "  ADD alias:        ${ALIAS_FQDN}"
echo "  Viewer cert →     ${VIEWER_CERT_ARN}"
echo "  Existing aliases: $(printf '%s ' $CURRENT_ALIASES)"
echo "  TLS settings (SSLSupportMethod / MinimumProtocolVersion) are left"
echo "  exactly as phase 8 set them — only the certificate ARN changes."
echo ""
if [ "$ASSUME_YES" != "yes" ]; then
  read -p "  Type 'add' to proceed: " CONFIRM
  if [ "$CONFIRM" != "add" ]; then echo "  Aborted."; exit 1; fi
fi

# ── Re-fetch fresh config + ETag, edit, and apply atomically ──
step "Applying alias + certificate update"

CONFIG_JSON=$(aws cloudfront get-distribution-config --id "$CF_ID")
ETAG=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['ETag'])")

CONFIG_IN_FILE=$(mktemp)
NEW_CONFIG_FILE=$(mktemp)
trap 'rm -f "$CONFIG_IN_FILE" "$NEW_CONFIG_FILE"' EXIT

# Stage the fetched config to a file and pass its PATH to python via
# argv. Do NOT pipe the JSON into a heredoc-driven python: the heredoc
# (<<PYEOF) redirects stdin to the program text and overrides the pipe,
# so python runs the heredoc as its script and json.load(sys.stdin)
# reads empty input — "Expecting value: line 1 column 1 (char 0)".
printf '%s' "$CONFIG_JSON" > "$CONFIG_IN_FILE"

ALIAS="$ALIAS_FQDN" CERTARN="$VIEWER_CERT_ARN" python3 - "$CONFIG_IN_FILE" <<'PYEOF' > "$NEW_CONFIG_FILE"
import os, sys, json
with open(sys.argv[1]) as f:
    data = json.load(f)
cfg = data["DistributionConfig"]
alias = os.environ["ALIAS"]
cert  = os.environ["CERTARN"]

aliases = cfg.setdefault("Aliases", {"Quantity": 0, "Items": []})
items = aliases.setdefault("Items", [])
if alias not in items:
    items.append(alias)
aliases["Quantity"] = len(items)

vc = cfg.setdefault("ViewerCertificate", {})
# Swap only the certificate identity. Leave SSLSupportMethod and
# MinimumProtocolVersion untouched so the TLS posture is unchanged.
vc["ACMCertificateArn"] = cert
vc["Certificate"] = cert
vc["CertificateSource"] = "acm"
vc.pop("CloudFrontDefaultCertificate", None)
vc.pop("IAMCertificateId", None)
vc.setdefault("SSLSupportMethod", "sni-only")
vc.setdefault("MinimumProtocolVersion", "TLSv1.2_2021")

json.dump(cfg, sys.stdout)
PYEOF

aws cloudfront update-distribution \
  --id "$CF_ID" \
  --if-match "$ETAG" \
  --distribution-config "file://${NEW_CONFIG_FILE}" > /dev/null

info "Distribution updated — alias added, viewer cert swapped"
save_state CF_VIEWER_CERT_ARN "$VIEWER_CERT_ARN"

# ── Manual follow-up instructions ─────────────────────────────
banner "Phase 9 applied — remaining manual steps"
echo "  The distribution is now propagating (status returns to"
echo "  'Deployed' in ~5 min). Poll with: bash 08b-wait-cloudfront.sh"
echo ""
echo "  1) DNS (registrar / Enom) — point the new host at CloudFront:"
echo "       Type:  CNAME"
echo "       Name:  ${ALIAS_FQDN}"
echo "       Value: ${CF_DOMAIN}"
echo "     (Enter only the host portion relative to the ${DOMAIN} zone.)"
echo ""
echo "  Marketing pages (S3 origin) will work at the new host as soon as"
echo "  DNS resolves. The AUTHENTICATED dashboard will NOT until you also:"
echo ""
echo "  2) Auth0 application settings — ADD (do not replace):"
echo "       Allowed Callback URLs: https://${ALIAS_FQDN}/auth/callback"
echo "       Allowed Logout URLs:   https://${ALIAS_FQDN}"
echo "       Allowed Web Origins:   https://${ALIAS_FQDN}"
echo ""
echo "  3) LinkedIn app — ADD authorized redirect URL:"
echo "       https://${ALIAS_FQDN}/auth/linkedin/callback"
echo ""
echo "  4) Application config/code — the app currently pins these to"
echo "     ${FQDN}. For an identical login at ${ALIAS_FQDN}, the app must"
echo "     derive its callback/base URLs from the request Host and accept"
echo "     the new origin:"
echo "       - ALLOWED_ORIGINS must include https://${ALIAS_FQDN}"
echo "       - AUTH0_REDIRECT_URI / AUTH0_LOGOUT_URI per-host"
echo "       - LINKEDIN_REDIRECT_URI per-host"
echo "     Until that ships, login initiated at ${ALIAS_FQDN} will bounce"
echo "     back to ${FQDN}."
echo ""
echo "  Note: the original single-domain cert (state CERT_ARN) is still"
echo "  used by the ALB listener — it was left in place. Do not delete it."
