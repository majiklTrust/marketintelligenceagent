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
# Phase 8: CloudFront + S3 (Edge Delivery)
# ═══════════════════════════════════════════════════════════════
# Creates the CloudFront distribution that fronts both the alpha
# marketing site (S3 origin) and the dashboard application (ALB
# origin), and modifies the ALB port-80 listener to forward
# instead of redirect so CloudFront can talk to it over HTTP.
#
# After this script:
#   1. Run 08b-wait-cloudfront.sh   (waits for distribution to deploy)
#   2. Update DNS CNAME to CloudFront domain (script will print it)
#   3. Verify with 07-verify.sh
#   4. (Optional) Run 08c-lockdown-alb.sh to restrict ALB SG
#
# Architecture:
#   Viewer (HTTPS) → CloudFront → {
#     /, /styles/*, /scripts/*, /app/styles/*  → S3 (cached)
#     /app/*                                   → ALB:80 (no cache)
#     /api/*, /auth/*                          → ALB:80 (no cache)
#   }
#
# Origin protocol is HTTP (not HTTPS) because the ACM cert is
# scoped to ${FQDN} and the ALB DNS name cannot be added to it.
# All traffic between CloudFront and the ALB stays inside AWS
# network. The viewer-facing connection is always HTTPS.
# ═══════════════════════════════════════════════════════════════
source "$(dirname "$0")/config.sh"
banner "Phase 8: CloudFront + S3"

ALB_DNS=$(require_state ALB_DNS)
CERT_ARN=$(require_state CERT_ARN)
EIP_PUBLIC=$(require_state EIP_PUBLIC)
KEY_PATH=$(require_state KEY_PATH)
TG_ARN=$(require_state TG_ARN)
HTTP_LISTENER_ARN=$(require_state HTTP_LISTENER_ARN)

SCP="scp -i ${KEY_PATH} -o StrictHostKeyChecking=no"

# AWS-managed CloudFront cache and origin request policies.
# Hardcoded by AWS — these IDs are the same in every account.
CACHING_OPTIMIZED="658327ea-f89d-4fab-a63d-7e88639e58f6"
CACHING_DISABLED="4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
ALL_VIEWER_REQUEST_POLICY="216adef6-5c7f-47e4-b989-5492eafa07d3"

# ── Local tunables ───────────────────────────────────────────
# CloudFront origin read timeout for the ALB origin: how long
# the edge will wait for a response packet from the ALB before
# closing the connection. AWS default is 30s; the API maximum
# without a Service Quotas request is 120s. The dashboard's
# Preview New Post flow has 65-second sleeps for Anthropic
# rate limit cooldown — 120s gives ~55s of headroom over each
# silence window. Should match or exceed any per-packet pause
# in the application's slowest endpoint.
#
# NOTE: This is a hardcoded local default. It should move to
# config.sh as CF_ORIGIN_READ_TIMEOUT_SECONDS in a future
# cleanup so it lives alongside CF_HTTP_ORIGIN_PORT and the
# other CloudFront tunables.
CF_ORIGIN_READ_TIMEOUT_SECONDS=120

# ── Verify cert is issued and in us-east-1 ───────────────────
step "Verifying ACM certificate"

CERT_STATUS=$(aws acm describe-certificate \
  --certificate-arn "$CERT_ARN" \
  --query 'Certificate.Status' --output text)

if [ "$CERT_STATUS" != "ISSUED" ]; then
  err "Certificate status is '${CERT_STATUS}', expected 'ISSUED'."
  exit 1
fi

CERT_REGION=$(echo "$CERT_ARN" | awk -F: '{print $4}')
if [ "$CERT_REGION" != "us-east-1" ]; then
  err "Certificate is in ${CERT_REGION}, but CloudFront requires us-east-1."
  exit 1
fi
info "Certificate: ISSUED, in us-east-1"

# ── S3 bucket: create or reuse ───────────────────────────────
step "Checking S3 bucket: ${S3_BUCKET_NAME}"

if aws s3api head-bucket --bucket "$S3_BUCKET_NAME" --region "$S3_BUCKET_REGION" 2>/dev/null; then
  info "Bucket exists — reusing"
  BUCKET_OWNER_ACCOUNT=$(aws s3api get-bucket-acl --bucket "$S3_BUCKET_NAME" \
    --query 'Owner.ID' --output text 2>/dev/null || echo "")
else
  info "Bucket does not exist — creating"
  if [ "$S3_BUCKET_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$S3_BUCKET_NAME" --region us-east-1 > /dev/null
  else
    aws s3api create-bucket --bucket "$S3_BUCKET_NAME" --region "$S3_BUCKET_REGION" \
      --create-bucket-configuration "LocationConstraint=${S3_BUCKET_REGION}" > /dev/null
  fi

  # Block all public access — the bucket is private, accessed only
  # via CloudFront's Origin Access Control. This is the default for
  # new buckets but explicit is safer.
  aws s3api put-public-access-block --bucket "$S3_BUCKET_NAME" \
    --public-access-block-configuration \
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" > /dev/null

  # Tag the bucket so it's identifiable in the AWS console even
  # though it's a long-lived shared resource.
  aws s3api put-bucket-tagging --bucket "$S3_BUCKET_NAME" \
    --tagging "TagSet=[{Key=Project,Value=${PROJECT}},{Key=Purpose,Value=apex-frontend}]" > /dev/null

  info "Bucket created and locked down"
fi

save_state S3_BUCKET "$S3_BUCKET_NAME"
save_state S3_PREFIX "$S3_PREFIX"

# ── Stage files from EC2 ─────────────────────────────────────
step "Staging majikl-site files from EC2"

STAGING_DIR=$(mktemp -d)
trap "rm -rf '$STAGING_DIR'" EXIT

# Pull majikl-site directory from EC2 (the repo on EC2 has a
# nested layout: /home/${SSH_USER}/marketintelligence-agent/marketintelligence-agent/).
$SCP -r -q "${SSH_USER}@${EIP_PUBLIC}:/home/${SSH_USER}/marketintelligence-agent/marketintelligence-agent/majikl-site" \
  "$STAGING_DIR/majikl-site"

if [ ! -d "$STAGING_DIR/majikl-site" ] || [ ! -f "$STAGING_DIR/majikl-site/index.html" ]; then
  err "Failed to fetch majikl-site/index.html from EC2."
  err "Check that phase 6 has run and the repo is at:"
  err "  /home/${SSH_USER}/marketintelligence-agent/marketintelligence-agent/majikl-site/"
  exit 1
fi
info "majikl-site/ staged ($(ls "$STAGING_DIR/majikl-site" | wc -l | tr -d ' ') items at top level)"

mkdir -p "$STAGING_DIR/app/styles"
$SCP -q "${SSH_USER}@${EIP_PUBLIC}:/home/${SSH_USER}/marketintelligence-agent/marketintelligence-agent/public/styles/app.css" \
  "$STAGING_DIR/app/styles/app.css"

if [ ! -f "$STAGING_DIR/app/styles/app.css" ]; then
  err "Failed to fetch dashboard app.css from EC2."
  err "Expected at: /home/${SSH_USER}/marketintelligence-agent/marketintelligence-agent/public/styles/app.css"
  exit 1
fi
info "Dashboard app.css staged"

# ── Initial S3 upload ────────────────────────────────────────
step "Uploading static assets to S3"

# Marketing site files: short cache (5 minutes). They change with
# every deploy and the invalidation step ensures fresh delivery.
aws s3 sync "${STAGING_DIR}/majikl-site/" \
  "s3://${S3_BUCKET_NAME}/${S3_PREFIX}/" \
  --delete \
  --exclude ".*" \
  --exclude "*/.*" \
  --cache-control "max-age=300" > /dev/null
info "majikl-site/ uploaded to s3://${S3_BUCKET_NAME}/${S3_PREFIX}/"

# Dashboard CSS: longer cache (1 day). Changes only on dashboard
# CSS releases, which are rare. Invalidation still flushes on
# deploy, so the long cache is just a default-when-not-flushed.
aws s3 cp "${STAGING_DIR}/app/styles/app.css" \
  "s3://${S3_BUCKET_NAME}/${S3_PREFIX}/app/styles/app.css" \
  --cache-control "max-age=86400" > /dev/null
info "Dashboard app.css uploaded to ${S3_PREFIX}/app/styles/app.css"

# ── Origin Access Control ────────────────────────────────────
step "Creating CloudFront Origin Access Control"

# OAC name is identified by PROJECT alone. PROJECT already
# encodes the FQDN (via FQDSHORT in config.sh), so appending
# SUBDOMAIN here would be redundant — for example, project
# mjagt-alph-maji-com would yield mjagt-alph-maji-com-alpha-oac,
# repeating "alph"/"alpha". OAC names only need to be unique
# within an account, and the project-derived name satisfies
# that.
OAC_NAME="${PROJECT}-oac"
OAC_CONFIG=$(cat <<EOF
{
  "Name": "${OAC_NAME}",
  "Description": "OAC for ${FQDN} → s3://${S3_BUCKET_NAME}/${S3_PREFIX}",
  "SigningProtocol": "sigv4",
  "SigningBehavior": "always",
  "OriginAccessControlOriginType": "s3"
}
EOF
)

OAC_ID=$(aws cloudfront create-origin-access-control \
  --origin-access-control-config "$OAC_CONFIG" \
  --query 'OriginAccessControl.Id' --output text)

save_state OAC_ID "$OAC_ID"
info "OAC created: $OAC_ID"

# ── Build CloudFront distribution config ─────────────────────
step "Building CloudFront distribution configuration"

# Generated via Python heredoc for readability — building this
# JSON inline in bash would be unreadable and error-prone. The
# config has 7 cache behaviors (6 explicit + 1 default), 2
# origins (S3 + ALB custom), and a viewer cert from ACM.
DIST_CONFIG_FILE="${STAGING_DIR}/dist-config.json"

python3 - <<PYEOF > "$DIST_CONFIG_FILE"
import json, time

caller_ref = f"${PROJECT}-${FQDN}-{int(time.time())}"

s3_domain = f"${S3_BUCKET_NAME}.s3.${S3_BUCKET_REGION}.amazonaws.com"
alb_domain = "${ALB_DNS}"
fqdn = "${FQDN}"
cert_arn = "${CERT_ARN}"
oac_id = "${OAC_ID}"
prefix = "${S3_PREFIX}"
http_port = ${CF_HTTP_ORIGIN_PORT}
price_class = "${CF_PRICE_CLASS}"
cf_origin_read_timeout = ${CF_ORIGIN_READ_TIMEOUT_SECONDS}

CACHING_OPTIMIZED = "${CACHING_OPTIMIZED}"
CACHING_DISABLED = "${CACHING_DISABLED}"
ALL_VIEWER = "${ALL_VIEWER_REQUEST_POLICY}"

s3_origin = {
    "Id": "s3-majikl-site",
    "DomainName": s3_domain,
    "OriginPath": f"/{prefix}",
    "CustomHeaders": {"Quantity": 0},
    "S3OriginConfig": {"OriginAccessIdentity": ""},
    "OriginAccessControlId": oac_id,
    "ConnectionAttempts": 3,
    "ConnectionTimeout": 10,
    "OriginShield": {"Enabled": False},
}

alb_origin = {
    "Id": "alb-dashboard",
    "DomainName": alb_domain,
    "OriginPath": "",
    "CustomHeaders": {"Quantity": 0},
    "CustomOriginConfig": {
        "HTTPPort": http_port,
        "HTTPSPort": 443,
        "OriginProtocolPolicy": "http-only",
        "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
        "OriginReadTimeout": cf_origin_read_timeout,
        "OriginKeepaliveTimeout": 5,
    },
    "ConnectionAttempts": 3,
    "ConnectionTimeout": 10,
    "OriginShield": {"Enabled": False},
}

def s3_behavior(path_pattern):
    return {
        "PathPattern": path_pattern,
        "TargetOriginId": "s3-majikl-site",
        "TrustedSigners": {"Enabled": False, "Quantity": 0},
        "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {
            "Quantity": 2,
            "Items": ["GET", "HEAD"],
            "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
        },
        "SmoothStreaming": False,
        "Compress": True,
        "LambdaFunctionAssociations": {"Quantity": 0},
        "FunctionAssociations": {"Quantity": 0},
        "FieldLevelEncryptionId": "",
        "CachePolicyId": CACHING_OPTIMIZED,
    }

def alb_behavior(path_pattern):
    return {
        "PathPattern": path_pattern,
        "TargetOriginId": "alb-dashboard",
        "TrustedSigners": {"Enabled": False, "Quantity": 0},
        "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {
            "Quantity": 7,
            "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
            "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
        },
        "SmoothStreaming": False,
        "Compress": True,
        "LambdaFunctionAssociations": {"Quantity": 0},
        "FunctionAssociations": {"Quantity": 0},
        "FieldLevelEncryptionId": "",
        "CachePolicyId": CACHING_DISABLED,
        "OriginRequestPolicyId": ALL_VIEWER,
    }

# Behavior order is significant: CloudFront evaluates in order
# and uses the FIRST match. /app/styles/* must come before /app/*.
# The literal /app entry catches bare /app requests (no trailing
# slash) which /app/* does not match — Auth0 post-login redirects
# to /app would otherwise fall through to the S3 default origin
# and return AccessDenied.
behaviors = [
    s3_behavior("/app/styles/*"),
    alb_behavior("/app"),
    alb_behavior("/app/*"),
    alb_behavior("/api/*"),
    alb_behavior("/auth/*"),
    s3_behavior("/styles/*"),
    s3_behavior("/scripts/*"),
]

# Default behavior: serve the majikl-site index.html from S3.
# DefaultRootObject below handles the path "/" → "/index.html"
# rewrite at the CloudFront layer, before the request reaches S3.
default_behavior = {
    "TargetOriginId": "s3-majikl-site",
    "TrustedSigners": {"Enabled": False, "Quantity": 0},
    "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
        "Quantity": 2,
        "Items": ["GET", "HEAD"],
        "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
    },
    "SmoothStreaming": False,
    "Compress": True,
    "LambdaFunctionAssociations": {"Quantity": 0},
    "FunctionAssociations": {"Quantity": 0},
    "FieldLevelEncryptionId": "",
    "CachePolicyId": CACHING_OPTIMIZED,
}

config = {
    "CallerReference": caller_ref,
    "Aliases": {"Quantity": 1, "Items": [fqdn]},
    "DefaultRootObject": "index.html",
    "Origins": {"Quantity": 2, "Items": [s3_origin, alb_origin]},
    "OriginGroups": {"Quantity": 0},
    "DefaultCacheBehavior": default_behavior,
    "CacheBehaviors": {"Quantity": len(behaviors), "Items": behaviors},
    "CustomErrorResponses": {"Quantity": 0},
    "Comment": f"marketintelligence-agent {fqdn} (S3 + ALB origins)",
    "Logging": {"Enabled": False, "IncludeCookies": False, "Bucket": "", "Prefix": ""},
    "PriceClass": price_class,
    "Enabled": True,
    "ViewerCertificate": {
        "ACMCertificateArn": cert_arn,
        "SSLSupportMethod": "sni-only",
        "MinimumProtocolVersion": "TLSv1.2_2021",
        "Certificate": cert_arn,
        "CertificateSource": "acm",
    },
    "Restrictions": {"GeoRestriction": {"RestrictionType": "none", "Quantity": 0}},
    "WebACLId": "",
    "HttpVersion": "http2and3",
    "IsIPV6Enabled": True,
    "Staging": False,
}

print(json.dumps(config, indent=2))
PYEOF

info "Distribution config built ($(wc -l < "$DIST_CONFIG_FILE" | tr -d ' ') lines)"

# ── Create CloudFront distribution ───────────────────────────
step "Creating CloudFront distribution (this takes a few seconds)"

CREATE_RESULT=$(aws cloudfront create-distribution-with-tags \
  --distribution-config-with-tags "$(python3 - <<PYEOF
import json
with open("${DIST_CONFIG_FILE}") as f:
    cfg = json.load(f)
wrapped = {
    "DistributionConfig": cfg,
    "Tags": {
        "Items": [
            {"Key": "Name", "Value": "${PROJECT}-cf"},
            {"Key": "Project", "Value": "${PROJECT}"},
            {"Key": "Environment", "Value": "${ENV_TAG}"}
        ]
    }
}
print(json.dumps(wrapped))
PYEOF
)")

CF_ID=$(echo "$CREATE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['Distribution']['Id'])")
CF_DOMAIN=$(echo "$CREATE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['Distribution']['DomainName'])")
CF_ARN=$(echo "$CREATE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['Distribution']['ARN'])")

save_state CF_ID "$CF_ID"
save_state CF_DOMAIN "$CF_DOMAIN"
save_state CF_ARN "$CF_ARN"

info "Distribution: $CF_ID"
info "Domain: $CF_DOMAIN"

# ── Update S3 bucket policy with OAC permission ──────────────
step "Updating S3 bucket policy for OAC access"

# The SID is unique per FQDN so multiple CloudFront distributions
# can share this bucket. Teardown removes only the matching SID.
# SID must be unique within the bucket policy across all
# tenants sharing this bucket. SUBDOMAIN alone (e.g., "alpha")
# would collide if you ever deployed alpha.someotherapex.com
# to the same bucket — both would generate AllowCloudFrontOAC-
# alpha and the merge logic would silently overwrite. FQDSHORT
# encodes the full hostname (e.g., alph-maji-com), so the SID
# is uniquely tied to this FQDN. Dashes are tolerated by S3
# resource policy SIDs.
CF_POLICY_SID="AllowCloudFrontOAC-${FQDSHORT}"
save_state CF_POLICY_SID "$CF_POLICY_SID"

ACCOUNT_ID=$(aws sts get-caller-identity --query 'Account' --output text)

NEW_STATEMENT=$(cat <<EOF
{
  "Sid": "${CF_POLICY_SID}",
  "Effect": "Allow",
  "Principal": {"Service": "cloudfront.amazonaws.com"},
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::${S3_BUCKET_NAME}/${S3_PREFIX}/*",
  "Condition": {
    "StringEquals": {
      "AWS:SourceArn": "arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${CF_ID}"
    }
  }
}
EOF
)

# Read existing policy if any. Merge our statement into the
# Statement array (replacing any prior entry with the same SID).
EXISTING_POLICY=$(aws s3api get-bucket-policy --bucket "$S3_BUCKET_NAME" \
  --query 'Policy' --output text 2>/dev/null || echo "")

# Pass both the new statement and the existing policy via env
# vars (NOT stdin) — combining a heredoc script with a stdin
# here-string in one python3 invocation silently drops the
# here-string, which would cause this script to wipe out any
# OTHER tenant statements in the shared bucket policy. Env
# vars are unambiguous.
MERGED_POLICY=$(NEW_STMT="$NEW_STATEMENT" EXISTING_RAW="$EXISTING_POLICY" python3 <<'PYEOF'
import json, os, sys

new_stmt = json.loads(os.environ["NEW_STMT"])
sid = new_stmt["Sid"]
existing_raw = os.environ.get("EXISTING_RAW", "").strip()

if existing_raw:
    policy = json.loads(existing_raw)
    # Drop any prior statement with the same SID, then append.
    # This preserves all OTHER tenants' statements untouched.
    policy["Statement"] = [s for s in policy.get("Statement", []) if s.get("Sid") != sid]
    policy["Statement"].append(new_stmt)
else:
    policy = {"Version": "2012-10-17", "Statement": [new_stmt]}

print(json.dumps(policy))
PYEOF
)

aws s3api put-bucket-policy --bucket "$S3_BUCKET_NAME" \
  --policy "$MERGED_POLICY" > /dev/null

info "Bucket policy updated (statement SID: ${CF_POLICY_SID})"

# ── Modify ALB port-80 listener: redirect → forward ──────────
step "Modifying ALB port-80 listener (redirect → forward)"

# CloudFront talks to the ALB over HTTP on port 80. The existing
# listener redirects HTTP to HTTPS, which CloudFront cannot follow.
# We change the action to forward to the same target group as 443.
# Direct HTTP access from the internet will then return real
# content, but the SG lockdown step (08c) restricts the ALB to
# CloudFront's prefix list so direct access is blocked anyway.
aws elbv2 modify-listener \
  --listener-arn "$HTTP_LISTENER_ARN" \
  --default-actions "Type=forward,TargetGroupArn=${TG_ARN}" > /dev/null

info "Port-80 listener now forwards to target group"

# ── Initial CloudFront invalidation (no-op but clean state) ──
step "Issuing initial cache invalidation"

INVALIDATION_ID=$(aws cloudfront create-invalidation \
  --distribution-id "$CF_ID" \
  --paths "/*" \
  --query 'Invalidation.Id' --output text)
info "Invalidation: $INVALIDATION_ID"

# ── Instructions ─────────────────────────────────────────────
banner "Phase 8 In Progress"
echo "  CloudFront distribution is CREATED but still DEPLOYING."
echo "  Status will become 'Deployed' in 10–20 minutes."
echo ""
echo "  ┌─────────────────────────────────────────────────────────┐"
echo "  │  Distribution ID:   ${CF_ID}"
echo "  │  Distribution domain: ${CF_DOMAIN}"
echo "  └─────────────────────────────────────────────────────────┘"
echo ""
echo "  Next steps in order:"
echo ""
echo "    1. Run: bash 08b-wait-cloudfront.sh"
echo "       (polls until distribution status is 'Deployed')"
echo ""
echo "    2. After 08b reports 'Deployed', update DNS:"
echo ""
echo "       ┌────────────────────────────────────────────────┐"
echo "       │  Type:  CNAME                                  │"
echo "       │  Name:  ${SUBDOMAIN}                          "
echo "       │  Value: ${CF_DOMAIN}                          "
echo "       └────────────────────────────────────────────────┘"
echo ""
echo "       The previous CNAME (pointing at the ALB) is replaced."
echo "       Direct ALB access still works during the transition"
echo "       because the ALB security group is open."
echo ""
echo "    3. After DNS propagates (1–5 minutes), verify:"
echo "       bash 07-verify.sh"
echo ""
echo "    4. (Optional but recommended) Lock down the ALB security"
echo "       group so the ALB is only reachable via CloudFront:"
echo "       bash 08c-lockdown-alb.sh"
echo ""
