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
# Teardown: Destroy All AWS Resources
# ═══════════════════════════════════════════════════════════════
# Destroys resources in reverse dependency order.
# Safe to run partially — skips resources that don't exist.
# ═══════════════════════════════════════════════════════════════
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

# Override set -e from config.sh — teardown must continue past errors
set +e

banner "TEARDOWN: Destroying All Resources"

echo "  ⚠  This will PERMANENTLY destroy all resources."
echo "  ⚠  The SQLite database on EC2 will be LOST."
echo ""
read -p "  Type 'destroy' to confirm: " CONFIRM
if [ "$CONFIRM" != "destroy" ]; then
  echo "  Aborted."
  exit 0
fi
echo ""

ERRORS=0

# ── Helper: try to delete, report result honestly ─────────────
try_delete() {
  local label="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    info "$label"
  else
    err "$label — FAILED (may already be deleted)"
    ERRORS=$((ERRORS + 1))
  fi
}

# ── CloudFront ────────────────────────────────────────────────
step "Removing CloudFront distribution"

CF_ID=$(load_state CF_ID)
OAC_ID=$(load_state OAC_ID)
S3_BUCKET=$(load_state S3_BUCKET)

if [ -n "$CF_ID" ]; then
  # Must disable before deleting
  ETAG=$(aws cloudfront get-distribution-config --id "$CF_ID" \
    --query 'ETag' --output text 2>/dev/null || echo "")
  if [ -n "$ETAG" ] && [ "$ETAG" != "None" ]; then
    # Get current config, set Enabled=false
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
        --distribution-config "$DISABLED_CONFIG" > /dev/null 2>&1 && info "Distribution disabled" || true

      echo "  Waiting for distribution to disable (this takes several minutes)..."
      aws cloudfront wait distribution-deployed --id "$CF_ID" 2>/dev/null || sleep 120

      # Get fresh ETag after disable
      ETAG=$(aws cloudfront get-distribution-config --id "$CF_ID" \
        --query 'ETag' --output text 2>/dev/null || echo "")
      try_delete "CloudFront distribution deleted" aws cloudfront delete-distribution --id "$CF_ID" --if-match "$ETAG"
    fi
  fi
fi

if [ -n "$OAC_ID" ]; then
  OAC_ETAG=$(aws cloudfront get-origin-access-control --id "$OAC_ID" \
    --query 'ETag' --output text 2>/dev/null || echo "")
  if [ -n "$OAC_ETAG" ] && [ "$OAC_ETAG" != "None" ]; then
    try_delete "Origin Access Control deleted" \
      aws cloudfront delete-origin-access-control --id "$OAC_ID" --if-match "$OAC_ETAG"
  else
    err "Origin Access Control $OAC_ID — could not retrieve ETag"
  fi
fi

# ── S3 Maintenance Folder (shared bucket — DO NOT delete bucket) ──
step "Removing maintenance folder from shared S3 bucket"

S3_PREFIX=$(load_state S3_PREFIX)
CF_POLICY_SID=$(load_state CF_POLICY_SID)

if [ -n "$S3_BUCKET" ] && [ -n "$S3_PREFIX" ]; then
  # Remove only the FQDN folder, not the entire bucket
  aws s3 rm "s3://${S3_BUCKET}/${S3_PREFIX}/" --recursive > /dev/null 2>&1 \
    && info "Folder ${S3_PREFIX}/ removed from ${S3_BUCKET}" || true
fi

if [ -n "$S3_BUCKET" ] && [ -n "$CF_POLICY_SID" ]; then
  # Remove only our policy statement, preserve all others
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
        && info "Policy statement '${CF_POLICY_SID}' removed (other statements preserved)" || true
    else
      # All statements removed — delete the policy entirely
      aws s3api delete-bucket-policy --bucket "$S3_BUCKET" > /dev/null 2>&1 \
        && info "Bucket policy removed (was the only statement)" || true
    fi
  fi
fi
info "Bucket ${S3_BUCKET} preserved (shared resource — not deleted)"

# ── Load Balancer ─────────────────────────────────────────────
step "Removing load balancer"

HTTPS_LISTENER_ARN=$(load_state HTTPS_LISTENER_ARN)
HTTP_LISTENER_ARN=$(load_state HTTP_LISTENER_ARN)
ALB_ARN=$(load_state ALB_ARN)
TG_ARN=$(load_state TG_ARN)

if [ -n "$HTTPS_LISTENER_ARN" ]; then
  try_delete "HTTPS listener deleted" aws elbv2 delete-listener --listener-arn "$HTTPS_LISTENER_ARN"
fi
if [ -n "$HTTP_LISTENER_ARN" ]; then
  try_delete "HTTP listener deleted" aws elbv2 delete-listener --listener-arn "$HTTP_LISTENER_ARN"
fi
if [ -n "$ALB_ARN" ]; then
  try_delete "ALB deleted" aws elbv2 delete-load-balancer --load-balancer-arn "$ALB_ARN"
  echo "  Waiting for ALB deletion to complete..."
  aws elbv2 wait load-balancers-deleted --load-balancer-arns "$ALB_ARN" 2>/dev/null || sleep 30
fi
if [ -n "$TG_ARN" ]; then
  try_delete "Target group deleted" aws elbv2 delete-target-group --target-group-arn "$TG_ARN"
fi

# ── EC2 Instance ──────────────────────────────────────────────
step "Terminating EC2 instance"

INSTANCE_ID=$(load_state INSTANCE_ID)
EIP_ALLOC=$(load_state EIP_ALLOC)

if [ -n "$EIP_ALLOC" ]; then
  EIP_ASSOC=$(aws ec2 describe-addresses \
    --allocation-ids "$EIP_ALLOC" \
    --query 'Addresses[0].AssociationId' --output text 2>/dev/null || echo "")
  if [ -n "$EIP_ASSOC" ] && [ "$EIP_ASSOC" != "None" ]; then
    try_delete "Elastic IP disassociated" aws ec2 disassociate-address --association-id "$EIP_ASSOC"
  fi
  try_delete "Elastic IP released" aws ec2 release-address --allocation-id "$EIP_ALLOC"
fi

if [ -n "$INSTANCE_ID" ]; then
  try_delete "Instance terminating" aws ec2 terminate-instances --instance-ids "$INSTANCE_ID"
  echo "  Waiting for termination..."
  aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID" 2>/dev/null || sleep 60
  info "Instance terminated"
fi

# ── Certificate ───────────────────────────────────────────────
step "Deleting ACM certificate"

CERT_ARN=$(load_state CERT_ARN)
if [ -n "$CERT_ARN" ]; then
  try_delete "Certificate deleted" aws acm delete-certificate --certificate-arn "$CERT_ARN"
fi

# ── Key Pair ──────────────────────────────────────────────────
step "Removing key pair"

if aws ec2 describe-key-pairs --key-names "$KEY_NAME" > /dev/null 2>&1; then
  try_delete "Key pair deleted from AWS" aws ec2 delete-key-pair --key-name "$KEY_NAME"
else
  info "Key pair not found in AWS (already deleted)"
fi
info "Local key files preserved in keys/ (delete manually if desired)"

# ── IAM ───────────────────────────────────────────────────────
step "Removing IAM role and instance profile"

aws iam remove-role-from-instance-profile \
  --instance-profile-name "${PROJECT}-ec2-profile" \
  --role-name "${PROJECT}-ec2-role" > /dev/null 2>&1 && info "Role removed from instance profile" || true

aws iam delete-instance-profile \
  --instance-profile-name "${PROJECT}-ec2-profile" > /dev/null 2>&1 && info "Instance profile deleted" || true

aws iam detach-role-policy \
  --role-name "${PROJECT}-ec2-role" \
  --policy-arn "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" > /dev/null 2>&1 && info "SSM policy detached" || true

aws iam detach-role-policy \
  --role-name "${PROJECT}-ec2-role" \
  --policy-arn "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy" > /dev/null 2>&1 && info "CloudWatch policy detached" || true

aws iam delete-role \
  --role-name "${PROJECT}-ec2-role" > /dev/null 2>&1 && info "IAM role deleted" || true

# ── Security Groups ───────────────────────────────────────────
step "Removing security groups"

EC2_SG_ID=$(load_state EC2_SG_ID)
ALB_SG_ID=$(load_state ALB_SG_ID)

# Must delete EC2 SG first (it references ALB SG)
if [ -n "$EC2_SG_ID" ]; then
  try_delete "EC2 SG deleted" aws ec2 delete-security-group --group-id "$EC2_SG_ID"
fi
if [ -n "$ALB_SG_ID" ]; then
  try_delete "ALB SG deleted" aws ec2 delete-security-group --group-id "$ALB_SG_ID"
fi

# ── Network ───────────────────────────────────────────────────
step "Removing network infrastructure"

RTB_ID=$(load_state RTB_ID)
SUBNET_1_ID=$(load_state SUBNET_1_ID)
SUBNET_2_ID=$(load_state SUBNET_2_ID)
IGW_ID=$(load_state IGW_ID)
VPC_ID=$(load_state VPC_ID)

if [ -n "$RTB_ID" ]; then
  ASSOCS=$(aws ec2 describe-route-tables --route-table-ids "$RTB_ID" \
    --query 'RouteTables[0].Associations[?!Main].RouteTableAssociationId' --output text 2>/dev/null || echo "")
  for ASSOC in $ASSOCS; do
    aws ec2 disassociate-route-table --association-id "$ASSOC" > /dev/null 2>&1 && info "Route table association removed" || true
  done
  try_delete "Route table deleted" aws ec2 delete-route-table --route-table-id "$RTB_ID"
fi

if [ -n "$SUBNET_1_ID" ]; then
  try_delete "Subnet 1 deleted" aws ec2 delete-subnet --subnet-id "$SUBNET_1_ID"
fi
if [ -n "$SUBNET_2_ID" ]; then
  try_delete "Subnet 2 deleted" aws ec2 delete-subnet --subnet-id "$SUBNET_2_ID"
fi

if [ -n "$IGW_ID" ] && [ -n "$VPC_ID" ]; then
  aws ec2 detach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID" > /dev/null 2>&1 && info "IGW detached" || true
  try_delete "Internet gateway deleted" aws ec2 delete-internet-gateway --internet-gateway-id "$IGW_ID"
fi

if [ -n "$VPC_ID" ]; then
  try_delete "VPC deleted" aws ec2 delete-vpc --vpc-id "$VPC_ID"
fi

# ── CloudWatch ────────────────────────────────────────────────
step "Removing CloudWatch log group"

aws logs delete-log-group --log-group-name "/marketintelligence-agent/app" > /dev/null 2>&1 && info "Log group deleted" || true

# ── State File ────────────────────────────────────────────────
step "Cleaning up state file"

if [ -f "$STATE_FILE" ]; then
  mv "$STATE_FILE" "${STATE_FILE}.destroyed-$(date +%Y%m%d-%H%M%S)"
  info "State file archived"
fi

# ── Summary ───────────────────────────────────────────────────
banner "Teardown Complete"
if [ $ERRORS -gt 0 ]; then
  echo "  ⚠ ${ERRORS} resource(s) may not have been deleted."
  echo "  Check the AWS console for remaining resources tagged Project=${PROJECT}"
else
  echo "  All AWS resources destroyed."
fi
echo ""
echo "  Manual cleanup needed:"
echo "  • Remove the CNAME record for ${FQDN} from your DNS provider"
echo "  • Remove the ACM validation CNAME record"
echo "  • Remove the GitHub deploy key from your repository settings"
echo "  • Delete local key files: rm -rf $(dirname "${BASH_SOURCE[0]}")/keys/"
