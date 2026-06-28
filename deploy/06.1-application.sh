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
# Phase 6: Application Deployment — Repository Clone + .env Replace
# (06.1-application.sh)
# ═══════════════════════════════════════════════════════════════
# Clones (or updates) the application repository from GitHub onto
# the remote EC2 host over SSH, using a GitHub deploy key that is
# managed locally as the source of truth; optionally replaces the
# remote .env from a validated properties file; installs deps and
# builds; and gates on a real database connection (Node 'SELECT 1').
# Any failure after the code/.env changes rolls the remote back to
# its pre-deploy state. Remaining steps (PM2 start, S3 sync) are
# added in later increments.
#
# (Line count intentionally exceeds the usual 600-line cap for this
# script, per explicit instruction, to keep the .env writer and its
# REQUIRED_KEYS list in this single file.)
#
# Shared config (EIP_PUBLIC, KEY_PATH, SSH_USER, GITHUB_REPO,
# GITHUB_BRANCH, PROJECT) comes from config.sh and is consumed
# exactly as in the original script. The clone branch defaults to
# $GITHUB_BRANCH and can be overridden with -b / --branch.
#
# NOTE (deferred, by design): this step intentionally does NOT
# enable `set -e` or install the rollback trap. Fail-fast plus the
# code/.env rollback we designed is its own later increment, so
# that adding it can be tested in isolation. For now, the only
# hard-stop failures are the explicit `exit` checks below.
# ═══════════════════════════════════════════════════════════════

# ── Argument parsing ──────────────────────────────────────────
# Accepts both forms requested: `-b value` and `--branch=value`
# (plus `--branch value` for convenience). Unknown flags are a
# hard error rather than being silently ignored, so a typo can't
# quietly fall through to the config default.
BRANCH_OVERRIDE=""
ALLOW_BRANCH_SWITCH="no"
UPDATE_ENV="no"
RESTART_ONLY="no"
REDUCE_JS="no"
INVALIDATE_ONLY="no"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  -b, --branch <name>   Git branch to clone/update on the remote host.
                        Defaults to \$GITHUB_BRANCH from config.sh.

  --allow-branch-switch Permit replacing the code when the remote repo is
                        currently on a DIFFERENT branch than the one passed.
                        Without this flag, a branch mismatch is refused.
                        Has no effect on a same-branch update or a fresh clone.

  --update-env          Replace the remote .env from keys/.env-\${FQDN}.
                        The source is validated against REQUIRED_KEYS before
                        writing, the existing .env is backed up, and the new
                        file is re-validated on the remote; on any validation
                        error the .env is reverted to its predecessor.
                        Without this flag the remote .env is left untouched.

  --restart-app         Restart the PM2 app on the remote and exit, WITHOUT
                        deploying (no clone, no .env change, no build). Use it
                        to bounce the app or pick up an out-of-band .env edit.

                        Other deploy flags are ignored in this mode.
  --reduce-js           After the code is updated, strip whole-line // comments
                        from every src/*.js file. If that strip removes any
                        line that is NOT a blank line or a comment, the change
                        is treated as unsafe and the deploy is rolled back.

  --invalidate-cache    Invalidate the CloudFront cache and exit, WITHOUT
                        deploying or syncing S3. Scope defaults to
                        '/<S3_PREFIX>/*' (never the distribution root);
                        override with CF_INVALIDATION_PATHS in config.sh.

  -h, --help            Show this help and exit.
USAGE
}

# --allow-branch-switch and --update-env both guard destructive
# changes on the remote, so they are intentionally long-form only:
# you have to type them out in full, with no short alias to trip on.
while [ $# -gt 0 ]; do
  case "$1" in
    -b|--branch)
      [ $# -ge 2 ] || { echo "Error: $1 requires a value" >&2; exit 2; }
      BRANCH_OVERRIDE="$2"; shift 2 ;;
    --branch=*|-b=*)
      BRANCH_OVERRIDE="${1#*=}"; shift ;;
    --allow-branch-switch)
      ALLOW_BRANCH_SWITCH="yes"; shift ;;
    --update-env)
      UPDATE_ENV="yes"; shift ;;
    --restart-app)
      RESTART_ONLY="yes"; shift ;;
    --reduce-js)
      REDUCE_JS="yes"; shift ;;
    --invalidate-cache)
      INVALIDATE_ONLY="yes"; shift ;;
    -h|--help)
      usage; exit 0 ;;
    --)
      shift; break ;;
    *)
      echo "Error: unknown option '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

# ── Load shared config ────────────────────────────────────────
source "$(dirname "$0")/config.sh"
banner "Phase 6 — Step 1: Repository Clone"

EIP_PUBLIC=$(require_state EIP_PUBLIC)
KEY_PATH=$(require_state KEY_PATH)

# Same SSH/SCP construction as the original. StrictHostKeyChecking
# is disabled to match the original's behavior so a freshly created
# EIP connects without an interactive host-key prompt.
#   ── Zero Trust call-out ──
#   Disabling host-key verification exposes the first connection to
#   a man-in-the-middle. It is carried over for parity, but a later
#   hardening step should pin the host key (capture it once at EIP
#   allocation and write a known_hosts entry) instead of trusting
#   blindly. Flagging now; not changing behavior in this step.
SSH="ssh -i ${KEY_PATH} -o StrictHostKeyChecking=no ${SSH_USER}@${EIP_PUBLIC}"
SCP="scp -i ${KEY_PATH} -o StrictHostKeyChecking=no"

# Canonical remote .env locations (root + the nested app dir that
# dotenv reads from at runtime). Defined up front so the rollback
# function can reference them regardless of which step fails.
ENV_REMOTE="/home/${SSH_USER}/marketintelligence-agent/.env"
ENV_NESTED="/home/${SSH_USER}/marketintelligence-agent/marketintelligence-agent/.env"

# Nested app dir (PM2 cwd / dotenv root) and the PM2 process name.
# Defined up front so the restart helper AND the rollback can use them
# no matter where a failure occurs. PM2_APP_NAME is read from config.sh
# and falls back to the package name only if config.sh does not set it —
# it is intentionally NOT hardcoded. If `pm2 list` shows a different
# name on the box, set PM2_APP_NAME in config.sh.
APP_DIR="/home/${SSH_USER}/marketintelligence-agent/marketintelligence-agent"
PM2_APP_NAME="${PM2_APP_NAME:-marketintelligence-agent}"

# Node version every remote node/npm/pm2 step must run under. nvm's
# default on this box is v22, but the app's package.json pins a newer
# engine (e.g. 26.3.1), so `npm ci` under the default fails. NODE_VERSION
# from config.sh wins; if unset we read engines.node from the app's
# package.json at deploy time. REQ_NODE is the resolved value, filled in
# by resolve_node_version().
NODE_VERSION="${NODE_VERSION:-}"
REQ_NODE=""

# ── S3 / CloudFront (static marketing site) ───────────────────
# aws runs HERE on the deploy box (as the previous process did):
# content is pulled from EC2 into a staging dir, then synced up, so the
# deploy box's aws credentials/region are what's used. The bucket,
# prefix and distribution are read from config.sh — NOT hardcoded.
# CF_INVALIDATION_PATHS defaults to "/*" (a full expire, always correct
# no matter how the distribution maps the bucket prefix); narrow it in
# config.sh once you've confirmed the origin path mapping.
# CF_INVALIDATION_PATHS overrides the invalidation scope. Left empty,
# the invalidation is derived as "/<S3_PREFIX>/*" so it stays inside the
# project prefix and never expires the shared distribution root. Only
# set this in config.sh if your distribution's origin path differs.
S3_BUCKET_NAME="${S3_BUCKET_NAME:-}"
S3_PREFIX="${S3_PREFIX:-}"
CLOUDFRONT_DISTRIBUTION_ID="${CLOUDFRONT_DISTRIBUTION_ID:-}"
CF_INVALIDATION_PATHS="${CF_INVALIDATION_PATHS:-}"

# Non-zero if an S3/CloudFront step failed. S3 failures are surfaced as
# a non-zero EXIT at the very end but never trigger a rollback — a good
# code/.env/restart deploy stands even if the static-site push fails.
S3_EXIT=0

# Directory mounts: which EC2 source dir maps to which bucket location.
# Sustainable/directory-based (vs naming individual files): add a row to
# extend. Fields, pipe-separated:
#   SRC          path under APP_DIR on EC2 (the source DIRECTORY)
#   DEST         path under s3://BUCKET/PREFIX/  ("." = the prefix root)
#   MAXAGE       Cache-Control max-age (seconds) for uploaded objects
#   DELETE       yes = `aws s3 sync --delete` (mirror); no = additive
S3_MOUNTS=(
  "majikl-site|.|300|yes"
  "public/styles|app/styles|86400|no"
)

# ── Rollback bookkeeping (the deploy "savepoint") ─────────────
# These record how to put the remote back the way it was if a later
# validation fails. They are populated as the run progresses:
#   CODE_ROLLBACKABLE / ROLLBACK_SHA / ROLLBACK_BRANCH — captured
#     before the git update, only when a real repo already existed.
#   ENV_WRITTEN / PREDECESSOR_BACKUP — set when --update-env writes
#     a new .env (PREDECESSOR_BACKUP is the timestamped copy of the
#     .env that was there before).
CODE_ROLLBACKABLE="no"
ROLLBACK_SHA=""
ROLLBACK_BRANCH=""
ENV_WRITTEN="no"
PREDECESSOR_BACKUP=""
# Set to "yes" the moment a restart is attempted, so the rollback knows
# the live process may be running the new (about-to-be-reverted) state
# and must be restarted back onto the reverted files.
RESTART_ATTEMPTED="no"

# ── Unified rollback ──────────────────────────────────────────
# Called from every post-mutation failure point (the .env post-write
# validation, npm ci, build, and the DB connectivity gate) so that a
# failed deploy leaves the remote in its pre-deploy state instead of
# half-changed. It reverts the .env first, then the code.
#
# DESIGN NOTE: this reverts BOTH code and .env on ANY of those
# failures, not only on the DB-connection failure. A broken build or
# a bad .env is just as much a failed deploy as a bad DB credential,
# and "any failure rolls all the way back to the predecessor" is a
# simpler, more predictable contract than partial undo. Say the word
# if you want finer-grained behavior (e.g. revert only what failed).
rollback_deploy() {
  warn "Rolling back to pre-deploy state"

  # .env — only if this run wrote one
  if [ "$ENV_WRITTEN" = "yes" ]; then
    if [ -n "$PREDECESSOR_BACKUP" ]; then
      # chmod u+w first: the live .env is mode 400, so cp cannot open
      # it for writing without restoring the write bit (same trap that
      # bit the writer). cp -p then resets the mode from the backup.
      if $SSH "chmod u+w $ENV_REMOTE 2>/dev/null || true; cp -p '$PREDECESSOR_BACKUP' $ENV_REMOTE && chmod 400 $ENV_REMOTE && ln -f $ENV_REMOTE $ENV_NESTED"; then
        info "Reverted .env to predecessor ($(basename "$PREDECESSOR_BACKUP"))"
      else
        warn "Could not revert .env — manual check needed"
      fi
    else
      if $SSH "rm -f $ENV_REMOTE $ENV_NESTED"; then
        info "Removed newly written .env (no predecessor existed)"
      else
        warn "Could not remove new .env — manual check needed"
      fi
    fi
  else
    info ".env was not modified this run — leaving it as-is"
  fi

  # code — only if a real repo existed before the update
  if [ "$CODE_ROLLBACKABLE" = "yes" ] && [ -n "$ROLLBACK_SHA" ]; then
    if [ -n "$ROLLBACK_BRANCH" ]; then
      # -f discards any working-tree edits made this run (e.g. the
      # --reduce-js sed, or build output) so the checkout cannot be
      # blocked by "local changes would be overwritten". A clean tree
      # behaves identically, so this is safe for every caller.
      RESTORE_GIT="git checkout -f -B '$ROLLBACK_BRANCH' '$ROLLBACK_SHA'"
      RESTORE_LABEL="${ROLLBACK_BRANCH}@${ROLLBACK_SHA:0:12}"
    else
      # predecessor was a detached HEAD — restore the exact commit
      RESTORE_GIT="git checkout -f '$ROLLBACK_SHA'"
      RESTORE_LABEL="detached@${ROLLBACK_SHA:0:12}"
    fi
    if $SSH "cd /home/${SSH_USER}/marketintelligence-agent && ${RESTORE_GIT} >/dev/null 2>&1"; then
      info "Reverted code to ${RESTORE_LABEL}"
    else
      warn "Could not revert code to ${ROLLBACK_SHA:0:12} — manual check needed"
    fi
  else
    warn "Code has no recoverable predecessor (fresh clone) — left in place"
  fi

  # If a restart was already attempted this run, the live process may be
  # running the new (now-reverted) code/.env. Bring it back onto the
  # reverted files. If no restart was attempted, the running process
  # never left the pre-deploy state, so reverting the files is enough.
  if [ "$RESTART_ATTEMPTED" = "yes" ]; then
    restart_app "rollback" || warn "Post-rollback restart failed — run 'pm2 restart ${PM2_APP_NAME}' manually"
  fi
}

# ── Resolve the required Node version ─────────────────────────
# Fills REQ_NODE once. NODE_VERSION from config.sh wins; otherwise read
# engines.node from the app's package.json on the remote (using whatever
# node nvm currently has, just to parse JSON). Leading range operators
# (^ ~ >= = v) are stripped so `nvm use` receives a plain version. Empty
# REQ_NODE means "couldn't determine" and callers fall back to the nvm
# default rather than hard-failing.
resolve_node_version() {
  [ -n "$REQ_NODE" ] && return 0
  if [ -n "$NODE_VERSION" ]; then
    REQ_NODE="$NODE_VERSION"
    return 0
  fi
  local raw
  raw=$($SSH "source ~/.nvm/nvm.sh >/dev/null 2>&1; cd ${APP_DIR} 2>/dev/null && node -p \"(require('./package.json').engines||{}).node||''\" 2>/dev/null" | tr -d '[:space:]')
  raw="${raw#^}"; raw="${raw#\~}"; raw="${raw#>=}"; raw="${raw#=}"; raw="${raw#v}"
  REQ_NODE="$raw"
  if [ -n "$REQ_NODE" ]; then
    info "Required Node version (engines.node): ${REQ_NODE}"
  else
    warn "Could not determine required Node version — using nvm default (set NODE_VERSION in config.sh to pin it)"
  fi
  return 0
}

# ── Restart the application (PM2) ─────────────────────────────
# A .env (or code) change only takes effect when the Node process is
# re-executed: the app loads .env via dotenv at startup, so PM2 must
# re-run it to pick up new values. `pm2 restart` re-execs the process
# (re-reading .env); --update-env also refreshes any env PM2 injected at
# start. nvm MUST be sourced first — a non-interactive SSH heredoc does
# not load it, so pm2/node would resolve to system paths or fail.
# Restart is by NAME, so the remote cwd does not matter (PM2 remembers
# each process's own cwd). We do NOT auto-`pm2 start` an unregistered
# app — that would mean assuming the entrypoint/args — so we fail
# clearly and let the operator register it once (it should already be
# running in production).
restart_app() {
  resolve_node_version
  step "Restarting application (pm2 restart ${PM2_APP_NAME})"
  RESTART_ATTEMPTED="yes"
  local out
  out=$($SSH bash -s <<RESTART 2>&1
source ~/.nvm/nvm.sh >/dev/null 2>&1 || { echo "PM2_FAIL nvm-not-found"; exit 0; }
# pm2 may live under the required node OR under the nvm default (the old
# version). Prefer the required node; if pm2 isn't there, fall back to
# the default so a pm2 installed on v22 is still found — don't hide it
# behind 'nvm use 26'. (The app's runtime node is the interpreter PM2
# recorded for the process, independent of this shell's active node.)
{ [ -n "${REQ_NODE}" ] && nvm use "${REQ_NODE}" >/dev/null 2>&1 && command -v pm2 >/dev/null 2>&1; } || nvm use default >/dev/null 2>&1 || true
command -v pm2 >/dev/null 2>&1 || { echo "PM2_FAIL pm2-not-on-path (install it for the active node: npm i -g pm2)"; exit 0; }
if pm2 describe "${PM2_APP_NAME}" >/dev/null 2>&1; then
  if pm2 restart "${PM2_APP_NAME}" --update-env >/dev/null 2>&1; then
    echo "PM2_OK restarted"
  else
    echo "PM2_FAIL restart-error"
  fi
else
  echo "PM2_FAIL app-not-registered:${PM2_APP_NAME}"
fi
RESTART
)
  if printf '%s\n' "$out" | grep -q '^PM2_OK'; then
    info "Application restarted — ${PM2_APP_NAME}"
    return 0
  fi
  local reason
  reason=$(printf '%s\n' "$out" | grep '^PM2_FAIL' | head -n1)
  warn "Application restart FAILED: ${reason:-${out:-no-response}}"
  return 1
}

# ── Invalidate the CloudFront cache ───────────────────────────
# Pure AWS API call from the deploy box — no SSH/EC2 involved. Paths
# come from the args (space-separated) or fall back to
# CF_INVALIDATION_PATHS. Returns non-zero on any problem so callers can
# decide what to do (the deploy path only records it; it never rolls
# ── S3 prefix containment guard ───────────────────────────────
# THE invariant for this shared bucket: every object this script
# touches lives under S3_PREFIX, and the bucket root is NEVER touched.
# This is the single chokepoint that enforces it. It normalizes the
# prefix (strips surrounding slashes) and REFUSES anything that could
# resolve to the root or escape: empty, "/", ".", "..", traversal, or
# stray characters. On success it echoes the safe prefix; on failure it
# returns non-zero and the caller declines to touch S3 at all.
s3_safe_prefix() {
  local p="${S3_PREFIX}"
  p="${p#/}"; p="${p%/}"
  case "$p" in
    ''|.|..) return 1 ;;
    *..*) return 1 ;;
    *[!A-Za-z0-9._/-]*) return 1 ;;
  esac
  printf '%s' "$p"
  return 0
}

# ── Invalidate the CloudFront cache ───────────────────────────
# Pure AWS API call from the deploy box — no SSH/EC2 involved. If no
# explicit paths are passed and CF_INVALIDATION_PATHS is unset, the
# scope is derived as "/<prefix>/*" so it stays inside the project and
# never expires the shared distribution root. Returns non-zero on any
# problem; the deploy path only records it and never rolls back.
invalidate_cloudfront() {
  local paths="$*"
  if [ -z "$paths" ]; then
    if [ -n "$CF_INVALIDATION_PATHS" ]; then
      paths="$CF_INVALIDATION_PATHS"
    else
      local p
      if ! p=$(s3_safe_prefix); then
        warn "Cannot invalidate: S3_PREFIX is empty/unsafe and CF_INVALIDATION_PATHS is unset — refusing to default to '/*' on a shared distribution"
        return 1
      fi
      paths="/${p}/*"
    fi
  fi
  if ! command -v aws >/dev/null 2>&1; then
    warn "aws CLI not found on the deploy box — cannot invalidate CloudFront"
    return 1
  fi
  if [ -z "$CLOUDFRONT_DISTRIBUTION_ID" ]; then
    warn "CLOUDFRONT_DISTRIBUTION_ID is not set in config.sh — cannot invalidate"
    return 1
  fi
  step "Invalidating CloudFront cache (${CLOUDFRONT_DISTRIBUTION_ID})"
  # shellcheck disable=SC2086  # $paths is intentionally word-split
  if aws cloudfront create-invalidation \
       --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
       --paths $paths >/dev/null 2>&1; then
    info "CloudFront invalidation submitted: ${paths}"
    return 0
  fi
  warn "CloudFront invalidation failed (check aws credentials / distribution id)"
  return 1
}

# ── Sync S3-bound content IF it changed, then invalidate ──────
# Called on a successful deploy, after the restart. For each mount it
# asks git (on EC2) whether that source dir changed between the
# predecessor commit and the new HEAD; only CHANGED mounts are pulled
# and synced. CloudFront is invalidated once, and only if something was
# actually uploaded. No-ops cleanly (returns 0) when S3 is not
# configured. Failures warn + set S3_EXIT=1 but never roll back.
sync_s3_if_changed() {
  if ! command -v aws >/dev/null 2>&1; then
    info "aws CLI not found on deploy box — skipping S3 sync"
    return 0
  fi
  if [ -z "$S3_BUCKET_NAME" ]; then
    info "S3_BUCKET_NAME not set in config.sh — skipping S3 sync"
    return 0
  fi

  # CONTAINMENT: resolve the one safe base every object lives under. If
  # the prefix is empty/unsafe we touch NOTHING — this is what prevents
  # a --delete sync from ever aiming at the bucket root.
  local prefix s3_base
  if ! prefix=$(s3_safe_prefix); then
    warn "S3_PREFIX is empty or unsafe ('${S3_PREFIX}') — refusing ALL S3 operations so nothing outside the project prefix (and never the bucket root) is touched. Set e.g. S3_PREFIX=majikl-site in config.sh."
    S3_EXIT=1
    return 0
  fi
  s3_base="s3://${S3_BUCKET_NAME}/${prefix}"

  step "Checking for changed S3-bound content (confined to ${s3_base}/)"

  # Comparison base: the predecessor commit if we have one, else treat
  # every mount as changed (fresh clone / no baseline to diff against).
  local diff_base=""
  if [ "$CODE_ROLLBACKABLE" = "yes" ] && [ -n "$ROLLBACK_SHA" ]; then
    diff_base="$ROLLBACK_SHA"
  fi

  local staging
  staging=$(mktemp -d 2>/dev/null) || { warn "Could not create staging dir — skipping S3"; S3_EXIT=1; return 0; }

  local did_upload="no" entry src dest maxage del changed s3dest delete_flag out
  for entry in "${S3_MOUNTS[@]}"; do
    IFS='|' read -r src dest maxage del <<< "$entry"

    # Did this mount's source dir change in this deploy?
    changed="yes"
    if [ -n "$diff_base" ]; then
      if $SSH "cd ${APP_DIR} && git diff --quiet ${diff_base} HEAD -- '${src}'" >/dev/null 2>&1; then
        changed="no"   # git diff --quiet exits 0 => no change
      fi
    fi
    if [ "$changed" = "no" ]; then
      info "  ${src}: unchanged — skipping"
      continue
    fi
    info "  ${src}: changed — staging from EC2"

    # Pull the source dir from EC2 into staging, preserving structure.
    mkdir -p "${staging}/$(dirname "${src}")"
    if ! $SCP -r -q "${SSH_USER}@${EIP_PUBLIC}:${APP_DIR}/${src}" "${staging}/${src}" 2>/dev/null; then
      warn "  Failed to copy ${src} from EC2 — skipping this mount"
      S3_EXIT=1
      continue
    fi

    # Build the destination under the contained base ("." => base root)
    # and ASSERT it stays under the base before doing anything.
    s3dest="${s3_base}"
    [ "$dest" != "." ] && s3dest="${s3_base}/${dest#/}"
    s3dest="${s3dest%/}/"
    case "$s3dest" in
      "${s3_base}/"*) : ;;   # ok — strictly under the project base
      *)
        warn "  refusing ${src}: resolved ${s3dest} is not under ${s3_base}/"
        S3_EXIT=1
        continue ;;
    esac

    delete_flag=""
    [ "$del" = "yes" ] && delete_flag="--delete"

    # aws s3 sync is itself diff-based: it only uploads changed objects
    # and prints a line per transfer. Empty output => nothing changed in
    # the bucket, so we won't invalidate for this mount.
    # shellcheck disable=SC2086
    if ! out=$(aws s3 sync "${staging}/${src}/" "${s3dest}" \
                 ${delete_flag} \
                 --exclude ".*" --exclude "*/.*" \
                 --cache-control "max-age=${maxage}" 2>&1); then
      warn "  s3 sync failed: ${src} -> ${s3dest}"
      printf '%s\n' "$out" | tail -n 3 | while IFS= read -r l; do warn "    ${l}"; done
      S3_EXIT=1
      continue
    fi
    if [ -n "$out" ]; then
      did_upload="yes"
      info "  synced ${src} -> ${s3dest} (max-age=${maxage}${delete_flag:+, --delete})"
    else
      info "  ${src}: already current in S3 — nothing uploaded"
    fi
  done

  rm -rf "$staging" 2>/dev/null || true

  if [ "$did_upload" = "yes" ]; then
    invalidate_cloudfront || S3_EXIT=1
  else
    info "No S3 objects changed — skipping CloudFront invalidation"
  fi
  return 0
}

# ── On-demand restart (skip the entire deploy) ────────────────
# `--restart-app` bounces the PM2 process and exits — no clone, no
# .env change, no npm/build, no DB gate. Handy to pick up an
# out-of-band .env edit or just cycle the app. Nothing is mutated, so
# no rollback applies. This runs before any repo/branch handling, so it
# does not require GITHUB_REPO/GITHUB_BRANCH to be set.
if [ "$RESTART_ONLY" = "yes" ]; then
  if [ -n "$BRANCH_OVERRIDE" ] || [ "$ALLOW_BRANCH_SWITCH" = "yes" ] || [ "$UPDATE_ENV" = "yes" ]; then
    warn "--restart-app ignores deploy flags (-b/--branch, --allow-branch-switch, --update-env)"
  fi
  banner "On-demand restart — ${PM2_APP_NAME} on ${EIP_PUBLIC}"
  step "Testing SSH connectivity"
  if ! $SSH "echo ok" >/dev/null 2>&1; then
    err "Cannot SSH to ${SSH_USER}@${EIP_PUBLIC}"
    echo "  Check: security group allows port 22 from your IP"
    echo "  Check: key file exists at ${KEY_PATH}"
    exit 1
  fi
  info "SSH connected to $EIP_PUBLIC"
  if restart_app "on-demand"; then
    banner "Restart complete — ${PM2_APP_NAME}"
    exit 0
  fi
  err "On-demand restart failed"
  exit 1
fi

# ── On-demand CloudFront invalidation (skip the entire deploy) ─
# `--invalidate-cache` expires the CDN and exits — no SSH, no S3 sync,
# no deploy. It invalidates CF_INVALIDATION_PATHS (default "/*").
if [ "$INVALIDATE_ONLY" = "yes" ]; then
  banner "CloudFront invalidation — ${CLOUDFRONT_DISTRIBUTION_ID:-<unset>}"
  if invalidate_cloudfront; then
    exit 0
  fi
  err "CloudFront invalidation failed"
  exit 1
fi

# ── Resolve effective branch (flag overrides config) ──────────
# The flag, when present, overrides the config value; downstream
# git commands then use $GITHUB_BRANCH exactly as the original did,
# so the override is transparent to the rest of the script.
if [ -n "$BRANCH_OVERRIDE" ]; then
  info "Branch override from command line: $BRANCH_OVERRIDE"
  GITHUB_BRANCH="$BRANCH_OVERRIDE"
fi

# ── Validate config ───────────────────────────────────────────
step "Validating deployment configuration"

if [ -z "$GITHUB_REPO" ]; then
  err "GITHUB_REPO is not set in config.sh"
  echo "  Set it to your repository URL, e.g.:"
  echo "  GITHUB_REPO=\"git@github.com:youruser/marketintelligence-agent.git\""
  exit 1
fi

if [ -z "$GITHUB_BRANCH" ]; then
  err "No branch resolved: GITHUB_BRANCH is unset in config.sh and no --branch was given"
  echo "  Set GITHUB_BRANCH in config.sh, or pass: --branch <name>"
  exit 1
fi

info "Target repo:   $GITHUB_REPO"
info "Target branch: $GITHUB_BRANCH"

# ── Verify SSH connectivity ──────────────────────────────────
step "Testing SSH connectivity"

if ! $SSH "echo ok" >/dev/null 2>&1; then
  err "Cannot SSH to ${SSH_USER}@${EIP_PUBLIC}"
  echo "  Check: security group allows port 22 from your IP"
  echo "  Check: key file exists at ${KEY_PATH}"
  exit 1
fi
info "SSH connected to $EIP_PUBLIC"

# ── Detect existing repository ────────────────────────────────
# HARDCODED PATH CALL-OUT: the remote clone directory name
# "marketintelligence-agent" (and the nested marketintelligence-agent/marketintelligence-agent
# layout the app uses) is hardcoded here, carried over verbatim
# from the original. A later step should parameterize it via a
# config.sh value (e.g. REMOTE_APP_DIR) to remove this literal.
REPO_EXISTS=$($SSH "test -d /home/${SSH_USER}/marketintelligence-agent/.git && echo yes || echo no" 2>/dev/null)

# ── Branch-mismatch guard (pre-check) ─────────────────────────
# Only meaningful when a git repo already exists on the remote.
# We read the remote's currently checked-out branch and compare it
# to the target. If they match, this is a same-branch update and
# proceeds normally. If they differ, replacing the code switches
# branches and hard-resets the working tree — a destructive change
# the operator must opt into with --allow-branch-switch.
#
# This check runs BEFORE deploy-key work and fetch so that a
# refusal happens without mutating anything on the remote.
#
# A detached HEAD reports "HEAD" here; since that is not the target
# branch name, it is treated as a mismatch and guarded the same way.
DO_BRANCH_SWITCH="no"
if [ "$REPO_EXISTS" = "yes" ]; then
  REMOTE_BRANCH=$($SSH "cd /home/${SSH_USER}/marketintelligence-agent 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null" 2>/dev/null)
  REMOTE_BRANCH="${REMOTE_BRANCH//[$'\r\n']/}"   # strip stray CR/LF

  if [ -z "$REMOTE_BRANCH" ]; then
    REMOTE_BRANCH="(unknown)"
  fi

  # Capture the current commit as the code-rollback savepoint. If the
  # remote is on a normal branch, remember it so rollback restores the
  # branch; if detached or unknown, leave ROLLBACK_BRANCH empty and
  # rollback will restore the exact commit instead.
  ROLLBACK_SHA=$($SSH "cd /home/${SSH_USER}/marketintelligence-agent 2>/dev/null && git rev-parse HEAD 2>/dev/null" 2>/dev/null)
  ROLLBACK_SHA="${ROLLBACK_SHA//[$'\r\n']/}"
  if [ -n "$ROLLBACK_SHA" ]; then
    CODE_ROLLBACKABLE="yes"
    case "$REMOTE_BRANCH" in
      "HEAD"|"(unknown)") ROLLBACK_BRANCH="" ;;
      *) ROLLBACK_BRANCH="$REMOTE_BRANCH" ;;
    esac
  fi

  if [ "$REMOTE_BRANCH" != "$GITHUB_BRANCH" ]; then
    if [ "$ALLOW_BRANCH_SWITCH" = "yes" ]; then
      DO_BRANCH_SWITCH="yes"
      warn "Remote is on '${REMOTE_BRANCH}', target is '${GITHUB_BRANCH}'"
      info "--allow-branch-switch given: code will be replaced with '${GITHUB_BRANCH}'"
    else
      err "Branch mismatch on remote — refusing to replace code"
      echo "  Remote currently on: ${REMOTE_BRANCH}"
      echo "  Requested branch:    ${GITHUB_BRANCH}"
      echo ""
      echo "  Switching branches hard-resets the working tree and discards"
      echo "  whatever is checked out now. To allow it, re-run with:"
      echo "    $(basename "$0") --branch ${GITHUB_BRANCH} --allow-branch-switch"
      exit 1
    fi
  else
    info "Remote already on target branch '${GITHUB_BRANCH}' — same-branch update"
  fi
fi

# ── GitHub deploy key management ──────────────────────────────
step "GitHub deploy key management"

# The local keys/ directory (the same one phase 2 uses for the EC2
# SSH key) is the source of truth for the GitHub deploy key:
#   - the key survives EC2 teardowns
#   - the same key is registered on GitHub once and reused
#   - it is backed up alongside the SSH key in the same dir
KEY_DIR=$(dirname "$KEY_PATH")
LOCAL_DEPLOY_KEY="${KEY_DIR}/${PROJECT}-deploy-key"
LOCAL_DEPLOY_PUB="${LOCAL_DEPLOY_KEY}.pub"
NEW_KEY="no"

EC2_HAS_KEY=$($SSH "test -f ~/.ssh/github_deploy_key && echo yes || echo no" 2>/dev/null)

if [ -f "$LOCAL_DEPLOY_KEY" ]; then
  # Path A: local key is source of truth. Always push to EC2 so a
  # stale remote copy is replaced by the authoritative local one.
  info "Local deploy key found: $LOCAL_DEPLOY_KEY"
  $SSH "mkdir -p ~/.ssh && chmod 700 ~/.ssh"
  $SCP -q "$LOCAL_DEPLOY_KEY" "${SSH_USER}@${EIP_PUBLIC}:~/.ssh/github_deploy_key"
  $SCP -q "$LOCAL_DEPLOY_PUB" "${SSH_USER}@${EIP_PUBLIC}:~/.ssh/github_deploy_key.pub"
  $SSH "chmod 600 ~/.ssh/github_deploy_key && chmod 644 ~/.ssh/github_deploy_key.pub"
  info "Local deploy key synced to EC2"

elif [ "$EC2_HAS_KEY" = "yes" ]; then
  # Path B: EC2 has a key but the local filesystem does not. Pull it
  # down so subsequent runs take Path A, then verify GitHub access.
  info "No local deploy key, but EC2 has one from a prior run"
  echo "  Pulling EC2 key into local keys/ directory"
  $SCP -q "${SSH_USER}@${EIP_PUBLIC}:~/.ssh/github_deploy_key" "$LOCAL_DEPLOY_KEY"
  $SCP -q "${SSH_USER}@${EIP_PUBLIC}:~/.ssh/github_deploy_key.pub" "$LOCAL_DEPLOY_PUB"
  chmod 600 "$LOCAL_DEPLOY_KEY"
  chmod 644 "$LOCAL_DEPLOY_PUB"
  info "Saved to: $LOCAL_DEPLOY_KEY"

else
  # Path C: nothing exists anywhere. Generate locally, push to EC2,
  # and the user registers the new public key on GitHub.
  info "No deploy key found — generating new ed25519 key pair"
  ssh-keygen -t ed25519 -f "$LOCAL_DEPLOY_KEY" -N "" -C "${PROJECT}-deploy" -q
  chmod 600 "$LOCAL_DEPLOY_KEY"
  chmod 644 "$LOCAL_DEPLOY_PUB"
  info "Generated: $LOCAL_DEPLOY_KEY"
  $SSH "mkdir -p ~/.ssh && chmod 700 ~/.ssh"
  $SCP -q "$LOCAL_DEPLOY_KEY" "${SSH_USER}@${EIP_PUBLIC}:~/.ssh/github_deploy_key"
  $SCP -q "$LOCAL_DEPLOY_PUB" "${SSH_USER}@${EIP_PUBLIC}:~/.ssh/github_deploy_key.pub"
  $SSH "chmod 600 ~/.ssh/github_deploy_key && chmod 644 ~/.ssh/github_deploy_key.pub"
  info "New deploy key uploaded to EC2"
  NEW_KEY="yes"
fi

# Write the SSH config on EC2 regardless of path so git over SSH
# always resolves github.com to the deploy key. Piped over stdin to
# a remote `cat > file` to avoid heredoc nesting issues.
$SSH 'cat > ~/.ssh/config' <<'SSHCFG'
Host github.com
  IdentityFile ~/.ssh/github_deploy_key
  StrictHostKeyChecking no
SSHCFG
$SSH "chmod 600 ~/.ssh/config"

DEPLOY_PUB=$(cat "$LOCAL_DEPLOY_PUB")

show_deploy_key_banner() {
  banner "ACTION REQUIRED: Add Deploy Key to GitHub"
  echo "  Go to your GitHub repository → Settings → Deploy keys → Add deploy key"
  echo ""
  echo "  Title: ${PROJECT}-deploy"
  echo "  Key:"
  echo "  $DEPLOY_PUB"
  echo ""
  echo "  ☐  Allow write access: UNCHECKED (read-only is sufficient)"
  echo ""
  echo "  The private key is saved locally at:"
  echo "    $LOCAL_DEPLOY_KEY"
  echo ""
}

# A brand-new key must be registered before the first auth test can
# pass. (Only NEW_KEY or an auth failure ever blocks on input; if the
# key is already registered, this step is fully non-interactive.)
if [ "$NEW_KEY" = "yes" ]; then
  show_deploy_key_banner
  read -p "  Press Enter after adding the deploy key to GitHub... " _
else
  info "Deploy key public key (for GitHub reference):"
  echo "  $DEPLOY_PUB"
fi

# ── Verify GitHub access (with one remediation retry) ─────────
# A key on disk is not proof of GitHub registration. If the first
# test fails, show the banner, wait for registration, retry once.
step "Testing GitHub access from EC2"

gh_auth_test() {
  GH_LAST_RESPONSE=$($SSH "ssh -T git@github.com 2>&1" || true)
  echo "$GH_LAST_RESPONSE" | grep -qi "successfully authenticated\|You've successfully"
}

if gh_auth_test; then
  info "GitHub authentication successful"
else
  warn "GitHub response: $GH_LAST_RESPONSE"
  echo ""
  echo "  The deploy key on EC2 is not being accepted by GitHub."
  echo "  Most likely cause: the public key below is not registered"
  echo "  in the repository's Deploy keys (or was removed from it)."
  echo ""
  show_deploy_key_banner
  read -p "  Press Enter after adding the deploy key to GitHub to retry... " _

  if gh_auth_test; then
    info "GitHub authentication successful"
  else
    warn "GitHub response: $GH_LAST_RESPONSE"
    echo "  Still failing after retry. Double-check:"
    echo "    - The public key above matches the one in Deploy keys"
    echo "    - Write-access is UNCHECKED on the deploy key"
    echo "    - The deploy key is on the correct repository"
    read -p "  Press Enter to continue anyway, or Ctrl+C to abort... " _
  fi
fi

# ── Clone / Update ────────────────────────────────────────────
# Three cases, all preserving an existing .env across the git op:
#   1. real git repo present →
#        same branch  → fetch + hard reset to the branch
#        switch (only with --allow-branch-switch) → fetch +
#          `checkout -B` to land cleanly ON the target branch.
#          (A plain `reset --hard origin/<other>` would move the
#          content but leave HEAD on the old branch name, so a
#          true switch uses checkout -B.)
#   2. directory present but not a git repo → wipe and fresh clone
#   3. nothing present → fresh clone
# .env is gitignored; neither reset --hard nor checkout -B removes
# untracked files, but a fresh clone after `rm -rf` would destroy
# it, so it is saved to /tmp and restored. The hardlink mirrors
# .env into the nested app dir where dotenv (process.cwd) looks.
step "Updating code on remote (origin/${GITHUB_BRANCH})"

if [ "$REPO_EXISTS" = "yes" ]; then
  # Pick the landing command locally; it expands into the (unquoted)
  # heredoc and then runs on the remote.
  if [ "$DO_BRANCH_SWITCH" = "yes" ]; then
    GIT_LAND="git fetch origin && git checkout -B ${GITHUB_BRANCH} origin/${GITHUB_BRANCH}"
  else
    GIT_LAND="git fetch origin && git reset --hard origin/${GITHUB_BRANCH}"
  fi
  $SSH << CLONECMD
cd /home/${SSH_USER}
[ -f marketintelligence-agent/.env ] && cp marketintelligence-agent/.env /tmp/saved-env
cd marketintelligence-agent
${GIT_LAND}
cd ..
if [ -f /tmp/saved-env ]; then
  mv /tmp/saved-env marketintelligence-agent/.env
  ln -f marketintelligence-agent/.env marketintelligence-agent/marketintelligence-agent/.env
fi
echo "Landed on origin/${GITHUB_BRANCH}"
CLONECMD
  if [ "$DO_BRANCH_SWITCH" = "yes" ]; then
    info "Repository switched and reset to origin/${GITHUB_BRANCH}"
  else
    info "Repository updated to origin/${GITHUB_BRANCH}"
  fi

elif $SSH "test -d /home/${SSH_USER}/marketintelligence-agent" 2>/dev/null; then
  $SSH << CLONECMD
cd /home/${SSH_USER}
[ -f marketintelligence-agent/.env ] && cp marketintelligence-agent/.env /tmp/saved-env
rm -rf marketintelligence-agent
git clone --branch ${GITHUB_BRANCH} ${GITHUB_REPO} marketintelligence-agent
if [ -f /tmp/saved-env ]; then
  mv /tmp/saved-env marketintelligence-agent/.env
  ln -f marketintelligence-agent/.env marketintelligence-agent/marketintelligence-agent/.env
fi
echo "Replaced non-git directory with fresh clone"
CLONECMD
  info "Repository cloned (replaced non-git directory)"

else
  $SSH "cd /home/${SSH_USER} && git clone --branch ${GITHUB_BRANCH} ${GITHUB_REPO} marketintelligence-agent"
  $SSH << ENVINIT
cd /home/${SSH_USER}/marketintelligence-agent
touch .env
ls -Alh
cd marketintelligence-agent && git status
ENVINIT
  info "Repository cloned fresh"
fi

# ══════════════════════════════════════════════════════════════
# JS reduction (optional, --reduce-js)
# ══════════════════════════════════════════════════════════════
# Runs immediately after the code is updated (any clone/fetch path),
# before .env/npm/build. Two commands, in sequence, on the remote:
#   1. strip whole-line // comments from every src/*.js (sed -i), then
#   2. count how many REMOVED lines were NOT a blank line or comment.
# If (2) is greater than 0 the strip touched real code, so the deploy
# is rolled back (the -f in rollback's checkout discards the sed edits).
# A quoted heredoc + $1=APP_DIR runs the two commands exactly as given
# ($(which grep) and the regex resolve on the remote, not locally).
if [ "$REDUCE_JS" = "yes" ]; then
  step "Reducing JS (strip whole-line // comments under src)"
  REDUCE_OUT=$($SSH bash -s "${APP_DIR}" <<'REDUCE'
cd "$1" 2>/dev/null || { echo "REDUCE_FAIL app-dir-missing"; exit 0; }
[ -d src ] || { echo "REDUCE_FAIL no-src-dir"; exit 0; }
find src -type f -name '*.js' -exec sed -i '/^[[:space:]]*\/\//d' {} +
CNT=$(git diff -- src | $(which grep) '^-' | $(which grep) -v '^---' | cut -c2- | $(which grep) -Ev '^[[:space:]]*(//|$)' | wc -l)
echo "REDUCE_COUNT=$CNT"
REDUCE
)
  if printf '%s\n' "$REDUCE_OUT" | grep -q '^REDUCE_FAIL'; then
    warn "JS reduction precheck failed: $(printf '%s\n' "$REDUCE_OUT" | grep '^REDUCE_FAIL' | head -n1)"
    rollback_deploy
    err "Deploy aborted: --reduce-js precheck failed"
    exit 1
  fi
  REDUCE_COUNT=$(printf '%s\n' "$REDUCE_OUT" | sed -n 's/^REDUCE_COUNT=//p' | tail -n1)
  case "$REDUCE_COUNT" in
    ''|*[!0-9]*)
      warn "JS reduction returned a non-numeric count: '${REDUCE_COUNT:-<empty>}'"
      rollback_deploy
      err "Deploy aborted: --reduce-js verification produced no usable count"
      exit 1 ;;
  esac
  if [ "$REDUCE_COUNT" -gt 0 ]; then
    warn "JS reduction removed ${REDUCE_COUNT} non-comment/non-blank line(s) — treating as unsafe"
    rollback_deploy
    err "Deploy aborted: --reduce-js altered real code (count=${REDUCE_COUNT})"
    exit 1
  fi
  info "JS reduction OK — only comment/blank lines removed (non-comment removals: 0)"
fi

# ══════════════════════════════════════════════════════════════
# .env replacement (optional, --update-env)
# ══════════════════════════════════════════════════════════════
# Models the original script's REQUIRED_KEYS-driven .env creation,
# with one added guarantee: the written file is validated ON THE
# REMOTE after the write, and on any validation error the .env is
# reverted to its predecessor (the timestamped backup taken just
# before the write). A first-time write with no predecessor is
# rolled back by removing the invalid file instead.
#
# (ENV_REMOTE / ENV_NESTED are defined near the top so the rollback
# function can reach them.)

if [ "$UPDATE_ENV" = "yes" ]; then
  step "Environment configuration (.env replace)"

  # FQDN drives both the source filename and many of the URLs in
  # the written file, so it must be present in config.sh.
  if [ -z "${FQDN:-}" ]; then
    err "FQDN is not set in config.sh — required for --update-env"
    exit 1
  fi

  # ── Required keys (ported verbatim from the original script) ──
  REQUIRED_KEYS=(
    ENCRYPTION_SECRET
    AUTH0_DOMAIN
    AUTH0_CLIENT_ID
    AUTH0_CLIENT_SECRET
    AUTH0_AUDIENCE
    AUTH0_SCOPES
    AUTH0_PUBLIC_ORIGIN
    SESSION_SECRET
    LINKEDIN_CLIENT_ID
    LINKEDIN_CLIENT_SECRET
    ANTHROPIC_MODEL
    MIN_HOURS_BETWEEN_POSTS
    MAX_POSTS_PER_10_DAYS
    PREFERRED_POST_HOUR
    PLATFORM_ADMIN_DB_ROLE
    PLATFORM_ADMIN_SUBS
    PLATFORM_ANTHROPIC_API_KEY
    REGISTRATION_INVITE_TTL_MINUTES
    BRAND_NAME
    APP_NAME
    SESSION_MAX_AGE_MS
    SESSION_MAX_AGE_REFRESH_RATIO
    DASHBOARD_FEED_LIMIT
    MIN_INDEPENDENT_SOURCES
    MAX_AGE_DAYS
    MAX_AGE_DAYS_PRUNE
    MAX_RESEARCH_ARTICLES
    LINKEDIN_PUBLISH_MODE
    LINKEDIN_VERSION
    LINKEDIN_IMAGE_MAX_BYTES
    LINKEDIN_IMAGE_POLL_MAX
    LINKEDIN_IMAGE_POLL_INTERVAL_MS
    API_COOLDOWN_MS
    ANTHROPIC_WEB_SEARCH_TOOL
    FEEDS_MANAGER_VERSION
    AUTH0_AUDIENCE
    AUTH0_SCOPES
    PGHOST
    PGPORT
    PGUSER
    PGPASSWORD
  )

  ENV_FILE="$(dirname "$0")/keys/.env-${FQDN}"
  ENV_FILE_ABS="$ENV_FILE"
  if [ -d "$(dirname "$ENV_FILE")" ]; then
    ENV_FILE_ABS="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
  fi

  # ── Pre-write validation (on the local source file) ──────────
  # Fails before anything is touched on the remote, so a bad source
  # never gets written and there is nothing to revert.
  if [ ! -f "$ENV_FILE" ]; then
    err "Properties file not found: $ENV_FILE_ABS"
    echo "  Create it with one KEY=value per line for every REQUIRED_KEYS entry."
    echo "  (Interactive prompting from the original script is not ported here;"
    echo "   the file is the single source for --update-env.)"
    exit 1
  fi
  info "Source properties file: $ENV_FILE_ABS"

  MISSING=()
  EMPTY=()
  for KEY in "${REQUIRED_KEYS[@]}"; do
    line=$(grep "^${KEY}=" "$ENV_FILE" | head -n1)
    if [ -z "$line" ]; then
      MISSING+=("$KEY"); continue
    fi
    val="${line#*=}"
    # Treat empty and "" / '' as empty for validation purposes.
    case "$val" in '""'|"''"|'') EMPTY+=("$KEY") ;; esac
  done

  if [ ${#MISSING[@]} -gt 0 ] || [ ${#EMPTY[@]} -gt 0 ]; then
    err "Source .env failed pre-write validation — not writing"
    [ ${#MISSING[@]} -gt 0 ] && { echo "  Absent keys (${#MISSING[@]}):"; for k in "${MISSING[@]}"; do echo "    - $k"; done; }
    [ ${#EMPTY[@]}   -gt 0 ] && { echo "  Empty keys (${#EMPTY[@]}):";  for k in "${EMPTY[@]}";  do echo "    - $k"; done; }
    exit 1
  fi
  info "All ${#REQUIRED_KEYS[@]} required keys present and non-empty in source"

  # ── Safe parse of the source file (printf -v, never `source`) ─
  # `source` would let bash interpret quotes, *, $, <, >, &, ;, and
  # backticks in secret values as shell metacharacters. We instead
  # split on the first '=' and assign each value as a literal string.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in [a-zA-Z_]*) ;; *) continue ;; esac
    case "$key" in *[!a-zA-Z0-9_]*) continue ;; esac
    if [ "${#value}" -ge 2 ]; then
      first="${value:0:1}"; last="${value: -1}"
      if [ "$first" = '"' ] && [ "$last" = '"' ]; then value="${value:1:${#value}-2}"
      elif [ "$first" = "'" ] && [ "$last" = "'" ]; then value="${value:1:${#value}-2}"; fi
    fi
    printf -v "$key" '%s' "$value"
  done < "$ENV_FILE"

  # ── Back up the predecessor .env (so we can revert) ──────────
  PREDECESSOR_BACKUP=""
  if $SSH "test -f $ENV_REMOTE" 2>/dev/null; then
    TS=$(date -u +%Y%m%d-%H%M%S)
    PREDECESSOR_BACKUP="${ENV_REMOTE}.bak-${TS}"
    $SSH "cp -p $ENV_REMOTE '$PREDECESSOR_BACKUP' && chmod 400 '$PREDECESSOR_BACKUP'"
    info "Existing .env backed up → $(basename "$PREDECESSOR_BACKUP")"
  else
    info "No existing .env on remote — first write (nothing to back up)"
  fi

  # ── Write the new .env via printf streaming ──────────────────
  # printf interpolates values as literal strings: no heredoc
  # expansion locally and no shell interpretation remotely (the
  # remote just runs `cat > file`), so secret bytes are preserved
  # exactly regardless of which characters they contain.
  #
  # The previous run leaves .env at mode 400 (read-only), so we must
  # restore write permission before `cat >` can truncate it — without
  # this the overwrite dies with "Permission denied". (|| true keeps
  # the no-file first-write case from tripping config.sh's `set -e`.)
  $SSH "chmod u+w $ENV_REMOTE 2>/dev/null || true"

  # Mark the .env as at-risk BEFORE the write so that if anything from
  # here on fails, rollback_deploy restores the predecessor backup.
  ENV_WRITTEN="yes"

  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  ENV_WRITE_RC=0
  {
    printf '# ═══════════════════════════════════════════════════════════════\n'
    printf '# LinkedIn AI Agent — Production Configuration\n'
    printf '# Generated by 06.1-application.sh on %s\n' "$TIMESTAMP"
    printf '# Source: %s\n' "$ENV_FILE_ABS"
    printf '# ═══════════════════════════════════════════════════════════════\n\n'

    printf '# ── Application ───────────────────────────────────────────────\n'
    printf 'NODE_ENV=production\n'
    printf 'APP_BASE_URL=https://%s\n' "$FQDN"
    printf 'DASHBOARD_PORT=%s\n' "$APP_PORT"
    printf 'AGENT_MODE=manual\n\n'

    printf '# ── CORS / Origins ────────────────────────────────────────────\n'
    printf 'ALLOWED_ORIGINS=https://%s\n\n' "$FQDN"

    printf '# ── Encryption (API key at rest) ──────────────────────────────\n'
    printf 'ENCRYPTION_SECRET=%s\n\n' "$ENCRYPTION_SECRET"

    printf '# ── Auth0 ─────────────────────────────────────────────────────\n'
    printf 'AUTH0_DOMAIN=%s\n' "$AUTH0_DOMAIN"
    printf 'AUTH0_CLIENT_ID=%s\n' "$AUTH0_CLIENT_ID"
    printf 'AUTH0_CLIENT_SECRET=%s\n' "$AUTH0_CLIENT_SECRET"
    printf 'AUTH0_AUDIENCE=%s\n' "$AUTH0_AUDIENCE"
    printf 'AUTH0_SCOPES=%s\n' "$AUTH0_SCOPES"
    printf 'AUTH0_REDIRECT_URI=https://%s/auth/callback\n' "$FQDN"
    printf 'AUTH0_LOGOUT_URI=https://%s\n\n' "$FQDN"
    printf 'AUTH0_PUBLIC_ORIGIN=%s\n' "$AUTH0_PUBLIC_ORIGIN"

    printf '# ── Session ───────────────────────────────────────────────────\n'
    printf 'SESSION_SECRET=%s\n\n' "$SESSION_SECRET"

    printf '# ── LinkedIn OAuth ────────────────────────────────────────────\n'
    printf 'LINKEDIN_CLIENT_ID=%s\n' "$LINKEDIN_CLIENT_ID"
    printf 'LINKEDIN_CLIENT_SECRET=%s\n' "$LINKEDIN_CLIENT_SECRET"
    printf 'LINKEDIN_REDIRECT_URI=https://%s/auth/linkedin/callback\n\n' "$FQDN"

    printf '# ── LLM Variables ─────────────────────────────────────────────\n'
    printf 'ANTHROPIC_MODEL=%s\n' "$ANTHROPIC_MODEL"
    printf 'ANTHROPIC_WEB_SEARCH_TOOL=%s\n' "$ANTHROPIC_WEB_SEARCH_TOOL"
    printf 'API_COOLDOWN_MS=%s\n\n' "$API_COOLDOWN_MS"

    printf '# ── Scheduler ─────────────────────────────────────────────────\n'
    printf 'MIN_HOURS_BETWEEN_POSTS=%s\n' "$MIN_HOURS_BETWEEN_POSTS"
    printf 'MAX_POSTS_PER_10_DAYS=%s\n' "$MAX_POSTS_PER_10_DAYS"
    printf 'PREFERRED_POST_HOUR=%s\n\n' "$PREFERRED_POST_HOUR"

    printf '# ── PostgreSQL ────────────────────────────────────────────────\n'
    printf 'PGHOST=%s\n' "$PGHOST"
    printf 'PGPORT=%s\n' "$PGPORT"
    printf 'PGUSER=%s\n' "$PGUSER"
    printf 'PGPASSWORD=%s\n' "$PGPASSWORD"
    printf 'PGDATABASE=%s\n\n' "$PGDATABASE"

    printf '# ── New Tenant Registration ───────────────────────────────────\n'
    printf 'REGISTRATION_INVITE_TTL_MINUTES=%s\n' "$REGISTRATION_INVITE_TTL_MINUTES"
    printf 'BRAND_NAME=%s\n' "$BRAND_NAME"
    printf 'APP_NAME=%s\n' "$APP_NAME"
    printf 'PLATFORM_ADMIN_SUBS=%s\n' "$PLATFORM_ADMIN_SUBS"
    printf 'PLATFORM_ADMIN_DB_ROLE=%s\n' "$PLATFORM_ADMIN_DB_ROLE"
    printf 'PLATFORM_ANTHROPIC_API_KEY=%s\n\n' "$PLATFORM_ANTHROPIC_API_KEY"

    printf '# ── Feeds / Session Variables ─────────────────────────────────\n'
    printf 'SESSION_MAX_AGE_MS=%s\n' "$SESSION_MAX_AGE_MS"
    printf 'SESSION_MAX_AGE_REFRESH_RATIO=%s\n' "$SESSION_MAX_AGE_REFRESH_RATIO"
    printf 'MIN_INDEPENDENT_SOURCES=%s\n' "$MIN_INDEPENDENT_SOURCES"
    printf 'DASHBOARD_FEED_LIMIT=%s\n' "$DASHBOARD_FEED_LIMIT"
    printf 'MAX_AGE_DAYS=%s\n' "$MAX_AGE_DAYS"
    printf 'MAX_AGE_DAYS_PRUNE=%s\n' "$MAX_AGE_DAYS_PRUNE"
    printf 'MAX_RESEARCH_ARTICLES=%s\n' "$MAX_RESEARCH_ARTICLES"
    printf 'FEEDS_MANAGER_VERSION=%s\n\n' "$FEEDS_MANAGER_VERSION"

    printf '# ── Image Variables ───────────────────────────────────────────\n'
    printf 'LINKEDIN_PUBLISH_MODE=%s\n' "$LINKEDIN_PUBLISH_MODE"
    printf 'LINKEDIN_VERSION=%s\n' "$LINKEDIN_VERSION"
    printf 'LINKEDIN_IMAGE_MAX_BYTES=%s\n' "$LINKEDIN_IMAGE_MAX_BYTES"
    printf 'LINKEDIN_IMAGE_POLL_MAX=%s\n' "$LINKEDIN_IMAGE_POLL_MAX"
    printf 'LINKEDIN_IMAGE_POLL_INTERVAL_MS=%s\n' "$LINKEDIN_IMAGE_POLL_INTERVAL_MS"
  } | $SSH "cat > $ENV_REMOTE && chmod 400 $ENV_REMOTE" || ENV_WRITE_RC=$?

  # The trailing `|| ENV_WRITE_RC=$?` captures the pipeline's exit
  # status (the remote `cat`/`chmod`) AND prevents `set -e` from
  # aborting before we can roll back. $? here is the pipeline status.
  if [ "$ENV_WRITE_RC" -ne 0 ]; then
    warn "Writing .env to remote failed (rc=${ENV_WRITE_RC})"
    rollback_deploy
    err "Deploy aborted: could not write new .env"
    exit 1
  fi
  info "New .env written to remote"

  # ── Post-write validation (ON THE REMOTE) ────────────────────
  # The written file is re-checked in place so secrets are never
  # pulled back to this machine. Each REQUIRED_KEYS entry must be
  # present and non-empty; the file itself must be non-empty.
  KEYS_STR="${REQUIRED_KEYS[*]}"
  VALIDATION=$($SSH bash -s <<RVAL
ENVF="$ENV_REMOTE"
if [ ! -s "\$ENVF" ]; then echo "VALIDATION_FAIL file-missing-or-empty"; exit 0; fi
fails=""
for k in ${KEYS_STR}; do
  l=\$(grep "^\${k}=" "\$ENVF" | head -n1)
  if [ -z "\$l" ]; then fails="\$fails \${k}(absent)"; continue; fi
  v="\${l#*=}"
  if [ -z "\$v" ]; then fails="\$fails \${k}(empty)"; fi
done
if [ -n "\$fails" ]; then echo "VALIDATION_FAIL\$fails"; else echo "VALIDATION_OK"; fi
RVAL
)

  if echo "$VALIDATION" | grep -q "^VALIDATION_OK"; then
    # Mirror .env into the nested app dir where dotenv (process.cwd) reads it.
    $SSH "ln -f $ENV_REMOTE $ENV_NESTED"
    info ".env validated on remote and hardlinked into the app directory"
    [ -n "$PREDECESSOR_BACKUP" ] && info "Predecessor retained: $(basename "$PREDECESSOR_BACKUP")"
    ENV_RESULT="updated"
  else
    warn "Post-write .env validation FAILED: ${VALIDATION#VALIDATION_FAIL}"
    rollback_deploy
    err "Deploy aborted: new .env failed key validation"
    exit 1
  fi
else
  info "--update-env not given — remote .env left unchanged"
  ENV_RESULT="unchanged"
fi

# ══════════════════════════════════════════════════════════════
# Install, build, and DB connectivity gate
# ══════════════════════════════════════════════════════════════
# These always run (not flag-gated): after the code and .env are in
# place, dependencies are installed, the app is built, and the DB
# gate confirms the active .env can actually reach the database.
# Any failure here rolls back to the pre-deploy state.
#
# NOTE: paths use ${SSH_USER} rather than a hardcoded /home/ubuntu
# (the original quoted-heredoc steps hardcoded the username). The
# remote commands `source ~/.nvm/nvm.sh` first, because nvm is not
# sourced in non-interactive SSH heredocs and node/npm would
# otherwise resolve to the wrong (or no) binary.
# (APP_DIR / PM2_APP_NAME are defined near the top so the rollback and
#  restart helpers can use them regardless of where a failure occurs.)

# ── Install dependencies ──────────────────────────────────────
# Pin the Node version the app requires BEFORE installing — the box's
# nvm default (v22) doesn't satisfy package.json engines, which is what
# made `npm ci` fail. resolve_node_version reads engines.node now (after
# the code update, so it reflects the just-deployed package.json).
resolve_node_version
step "Installing npm dependencies (npm ci --ignore-scripts --omit=dev)"
# The remote script exits non-zero on failure; ssh propagates that
# exit code, so `if ! $SSH ...` detects it. (The original piped npm
# to `tail`, which masked the exit code — fixed here.)
if ! $SSH bash -s <<NPMINST
source ~/.nvm/nvm.sh >/dev/null 2>&1 || { echo "nvm not found"; exit 1; }
[ -n "${REQ_NODE}" ] && { nvm use "${REQ_NODE}" >/dev/null 2>&1 || { echo "node ${REQ_NODE} not installed on remote (nvm install ${REQ_NODE})"; exit 1; }; }
cd "${APP_DIR}" || exit 1
npm ci --ignore-scripts --omit=dev || exit 1
NPMINST
then
  warn "npm ci failed on the remote"
  rollback_deploy
  err "Deploy aborted: dependency install failed"
  exit 1
fi
info "Dependencies installed"

# ── Build ─────────────────────────────────────────────────────
step "Running build (npm run build_js)"
if ! $SSH bash -s <<BUILD
source ~/.nvm/nvm.sh >/dev/null 2>&1 || { echo "nvm not found"; exit 1; }
[ -n "${REQ_NODE}" ] && { nvm use "${REQ_NODE}" >/dev/null 2>&1 || { echo "node ${REQ_NODE} not installed on remote"; exit 1; }; }
cd "${APP_DIR}" || exit 1
npm run build_js || exit 1
BUILD
then
  warn "build_js failed on the remote"
  rollback_deploy
  err "Deploy aborted: build failed"
  exit 1
fi
info "Build complete"

# ── Database connectivity gate (app's own dbshell verify) ────
# The four PG connection values (PGHOST/PGPORT/PGUSER/PGPASSWORD) are
# ENCRYPTED at rest in .env; only PGDATABASE is plaintext. The app
# decrypts them in memory at startup. A standalone pg connect therefore
# CANNOT work — it would hand ciphertext to pg (that was the
# ERR_SOCKET_BAD_PORT: the "port" was the encrypted PGPORT string).
# The app ships scripts/dbshell.mjs whose `verify` mode decrypts with
# the app's own crypto (src/services/platform-secret.js) and does a
# real connect — the intended deploy gate. We call it rather than
# re-implementing AES-256-GCM/PBKDF2 here (single source of truth).
# It exits 0 and prints "[dbshell] verify OK ..." on success, non-zero
# with "[dbshell] verify FAILED — ..." otherwise. Requires pg + dotenv,
# both of which are runtime deps installed by npm ci --ignore-scripts --omit=dev.
step "Testing database connectivity (dbshell verify)"
DB_RESULT=$($SSH bash -s <<DBTEST
source ~/.nvm/nvm.sh >/dev/null 2>&1 || { echo "[dbshell] PRECHECK FAILED — nvm not found"; echo "DBSHELL_RC=97"; exit 0; }
[ -n "${REQ_NODE}" ] && { nvm use "${REQ_NODE}" >/dev/null 2>&1 || { echo "[dbshell] PRECHECK FAILED — node ${REQ_NODE} not installed"; echo "DBSHELL_RC=96"; exit 0; }; }
cd "${APP_DIR}" 2>/dev/null || { echo "[dbshell] PRECHECK FAILED — app dir ${APP_DIR} missing"; echo "DBSHELL_RC=98"; exit 0; }
[ -f scripts/dbshell.mjs ] || { echo "[dbshell] PRECHECK FAILED — scripts/dbshell.mjs not found"; echo "DBSHELL_RC=99"; exit 0; }
node scripts/dbshell.mjs verify 2>&1
echo "DBSHELL_RC=\$?"
DBTEST
)

DBSHELL_LINE=$(printf '%s\n' "$DB_RESULT" | grep -E '^\[dbshell\]' | tail -n1)
DBSHELL_RC=$(printf '%s\n' "$DB_RESULT" | sed -n 's/^DBSHELL_RC=//p' | tail -n1)

if [ "$DBSHELL_RC" = "0" ]; then
  info "Database connectivity OK — ${DBSHELL_LINE:-dbshell verify passed}"
else
  warn "Database connectivity FAILED: ${DBSHELL_LINE:-rc=${DBSHELL_RC:-no-response}}"
  rollback_deploy
  err "Deploy aborted: database connectivity gate failed"
  exit 1
fi

# ── Activate: restart so the new code + .env take effect ──────
# The deploy has updated the code (always) and, with --update-env, the
# .env. Neither is live until the process is re-executed, so we restart
# here — AFTER the DB gate has confirmed the active .env is good, so we
# never restart onto a config that can't reach the database. A failed
# restart rolls everything back; the rollback then restarts again onto
# the reverted files.
if ! restart_app "activate"; then
  rollback_deploy
  err "Deploy aborted: application restart failed"
  exit 1
fi

# ── Push changed static content to S3, then expire the CDN ────
# Successful deploy → sync S3-bound dirs that changed in this update,
# then invalidate CloudFront if anything was uploaded. S3 problems set
# S3_EXIT (surfaced at the end) but never roll back a good deploy.
sync_s3_if_changed

# ── Summary ───────────────────────────────────────────────────
banner "06.1 Complete — ${EIP_PUBLIC}"
echo "  Repo:   ${GITHUB_REPO}"
echo "  Branch: ${GITHUB_BRANCH}"
echo "  Path:   /home/${SSH_USER}/marketintelligence-agent"
echo "  .env:   ${ENV_RESULT}"
echo "  DB:     reachable (SELECT 1 passed)"
echo "  App:    restarted (${PM2_APP_NAME})"
if [ "$S3_EXIT" -eq 0 ]; then
  echo "  S3:     ok"
else
  echo "  S3:     FAILED (see warnings above; deploy itself stands)"
fi
echo ""
echo "  Inspect: ssh -i ${KEY_PATH} ${SSH_USER}@${EIP_PUBLIC} \\"
echo "           'cd marketintelligence-agent && git log -1 --oneline'"

# Exit non-zero if any S3/CloudFront step failed, so automation sees it.
# The code/.env/restart deploy already succeeded and is NOT rolled back.
exit "${S3_EXIT:-0}"
