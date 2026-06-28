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
# Utility: In-Place EC2 Instance Resize
# ═══════════════════════════════════════════════════════════════
# Resizes a STOPPED EC2 instance to a new instance type.
# Does NOT start the instance — leaves it stopped for you to
# start on your own schedule.
#
# Preserves: EBS volume, Elastic IP, security groups, IAM role,
#            target group registration, CloudFront, ALB, ACM cert.
#
# Usage:
#   bash resize-instance.sh              # uses TARGET_TYPE below
#   bash resize-instance.sh t3.medium    # override via argument
# ═══════════════════════════════════════════════════════════════
source "$(dirname "${BASH_SOURCE[0]}")/config.sh"

# ── Target Instance Type ──────────────────────────────────────
# Override from command line argument, or fall back to default
TARGET_TYPE="${1:-t3.small}"

banner "In-Place EC2 Instance Resize"

INSTANCE_ID=$(require_state INSTANCE_ID)
EIP_PUBLIC=$(require_state EIP_PUBLIC)
EIP_ALLOC=$(require_state EIP_ALLOC)
TG_ARN=$(require_state TG_ARN)

PASS=0
FAIL=0
WARN=0

run_check() {
  local label="$1" result="$2"
  if [ "$result" = "pass" ]; then
    info "$label"
    PASS=$((PASS + 1))
  elif [ "$result" = "warn" ]; then
    warn "$label"
    WARN=$((WARN + 1))
  else
    err "$label"
    FAIL=$((FAIL + 1))
  fi
}

# ══════════════════════════════════════════════════════════════
# PRE-FLIGHT CHECKS
# ══════════════════════════════════════════════════════════════

step "Pre-flight: Instance state"

INSTANCE_INFO=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].[State.Name,InstanceType,Placement.AvailabilityZone,RootDeviceType,VirtualizationType,Architecture]' \
  --output text 2>/dev/null)

if [ -z "$INSTANCE_INFO" ] || [ "$INSTANCE_INFO" = "None" ]; then
  err "Instance $INSTANCE_ID not found. It may have been terminated."
  exit 1
fi

CURRENT_STATE=$(echo "$INSTANCE_INFO" | awk '{print $1}')
CURRENT_TYPE=$(echo "$INSTANCE_INFO" | awk '{print $2}')
CURRENT_AZ=$(echo "$INSTANCE_INFO" | awk '{print $3}')
ROOT_DEVICE=$(echo "$INSTANCE_INFO" | awk '{print $4}')
VIRT_TYPE=$(echo "$INSTANCE_INFO" | awk '{print $5}')
ARCH=$(echo "$INSTANCE_INFO" | awk '{print $6}')

echo "  Instance:          $INSTANCE_ID"
echo "  Current type:      $CURRENT_TYPE"
echo "  Target type:       $TARGET_TYPE"
echo "  State:             $CURRENT_STATE"
echo "  AZ:                $CURRENT_AZ"
echo "  Architecture:      $ARCH"
echo "  Virtualization:    $VIRT_TYPE"
echo "  Root device:       $ROOT_DEVICE"

# ── Must be stopped ───────────────────────────────────────────
if [ "$CURRENT_STATE" != "stopped" ]; then
  err "Instance must be stopped. Current state: $CURRENT_STATE"
  echo "  Stop the instance first:"
  echo "    aws ec2 stop-instances --instance-ids $INSTANCE_ID"
  echo "    aws ec2 wait instance-stopped --instance-ids $INSTANCE_ID"
  exit 1
fi
run_check "Instance is stopped" "pass"

# ── Same type check ──────────────────────────────────────────
if [ "$CURRENT_TYPE" = "$TARGET_TYPE" ]; then
  warn "Instance is already $TARGET_TYPE. Nothing to do."
  exit 0
fi
run_check "Type change: $CURRENT_TYPE → $TARGET_TYPE" "pass"

# ── Architecture compatibility ────────────────────────────────
# t3 is x86_64. If the current AMI is x86_64, t3 is compatible.
# Guard against accidentally targeting ARM (t4g, m7g, etc.)
TARGET_FAMILY=$(echo "$TARGET_TYPE" | sed 's/\..*//')
ARM_FAMILIES="t4g m6g m7g c6g c7g r6g r7g"

if echo "$ARM_FAMILIES" | grep -qw "$TARGET_FAMILY"; then
  if [ "$ARCH" = "x86_64" ]; then
    err "Target $TARGET_TYPE is ARM (Graviton) but the AMI is x86_64."
    echo "  An in-place resize to a different CPU architecture is not possible."
    echo "  This requires a new instance with an ARM-compatible AMI."
    exit 1
  fi
fi
run_check "Architecture compatible ($ARCH)" "pass"

# ── Virtualization compatibility ──────────────────────────────
# Both m7i-flex and t3 use HVM/Nitro — but guard against paravirtual
if [ "$VIRT_TYPE" != "hvm" ]; then
  err "Instance uses $VIRT_TYPE virtualization. Target requires HVM."
  exit 1
fi
run_check "HVM virtualization confirmed" "pass"

# ── EBS check ────────────────────────────────────────────────
if [ "$ROOT_DEVICE" != "ebs" ]; then
  err "Root device is $ROOT_DEVICE (expected: ebs). Instance-store volumes do not persist."
  exit 1
fi
run_check "EBS-backed root volume" "pass"

# ── EBS volume details ───────────────────────────────────────
step "Pre-flight: EBS volume"

ROOT_VOL_ID=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' \
  --output text)

VOL_INFO=$(aws ec2 describe-volumes \
  --volume-ids "$ROOT_VOL_ID" \
  --query 'Volumes[0].[Size,VolumeType,State]' --output text)

VOL_SIZE=$(echo "$VOL_INFO" | awk '{print $1}')
VOL_TYPE=$(echo "$VOL_INFO" | awk '{print $2}')
VOL_STATE=$(echo "$VOL_INFO" | awk '{print $3}')

echo "  Volume:  $ROOT_VOL_ID"
echo "  Size:    ${VOL_SIZE}GB ($VOL_TYPE)"
echo "  State:   $VOL_STATE"

run_check "Root volume: ${VOL_SIZE}GB $VOL_TYPE ($VOL_STATE)" "pass"

# ── Elastic IP ───────────────────────────────────────────────
step "Pre-flight: Elastic IP"

EIP_STATUS=$(aws ec2 describe-addresses \
  --allocation-ids "$EIP_ALLOC" \
  --query 'Addresses[0].[PublicIp,InstanceId]' --output text 2>/dev/null || echo "NOT_FOUND")

EIP_IP=$(echo "$EIP_STATUS" | awk '{print $1}')
EIP_ATTACHED_TO=$(echo "$EIP_STATUS" | awk '{print $2}')

if [ "$EIP_IP" = "NOT_FOUND" ]; then
  run_check "Elastic IP $EIP_ALLOC not found" "fail"
elif [ "$EIP_ATTACHED_TO" = "$INSTANCE_ID" ]; then
  run_check "Elastic IP $EIP_IP attached to $INSTANCE_ID" "pass"
elif [ "$EIP_ATTACHED_TO" = "None" ] || [ -z "$EIP_ATTACHED_TO" ]; then
  # EIP disassociates when instance stops — this is normal
  run_check "Elastic IP $EIP_IP allocated (will re-associate on start)" "pass"
else
  run_check "Elastic IP $EIP_IP attached to different instance: $EIP_ATTACHED_TO" "warn"
fi

# ── Target group registration ────────────────────────────────
step "Pre-flight: Target group"

TG_HEALTH=$(aws elbv2 describe-target-health \
  --target-group-arn "$TG_ARN" \
  --query 'TargetHealthDescriptions[0].[Target.Id,TargetHealth.State]' --output text 2>/dev/null)

TG_INSTANCE=$(echo "$TG_HEALTH" | awk '{print $1}')
TG_STATE=$(echo "$TG_HEALTH" | awk '{print $2}')

if [ "$TG_INSTANCE" = "$INSTANCE_ID" ]; then
  run_check "Target group registered: $INSTANCE_ID (state: $TG_STATE)" "pass"
else
  run_check "Target group references $TG_INSTANCE (expected: $INSTANCE_ID)" "warn"
fi

# ── Pre-flight summary ───────────────────────────────────────
step "Pre-flight summary"
echo "  Passed: $PASS"
echo "  Warnings: $WARN"
echo "  Failed: $FAIL"

if [ $FAIL -gt 0 ]; then
  err "Pre-flight checks failed. Aborting resize."
  exit 1
fi

# ══════════════════════════════════════════════════════════════
# CREATE EBS SNAPSHOT (safety net)
# ══════════════════════════════════════════════════════════════

step "Creating EBS snapshot (safety net before resize)"

SNAP_ID=$(aws ec2 create-snapshot \
  --volume-id "$ROOT_VOL_ID" \
  --description "${PROJECT} pre-resize snapshot $(date +%Y%m%d-%H%M%S)" \
  --query 'SnapshotId' --output text \
  --tag-specifications "$(make_tags snapshot pre-resize)")

echo "  Snapshot: $SNAP_ID (creating in background)"
echo "  This does NOT block the resize — snapshots are incremental."
save_state PRE_RESIZE_SNAPSHOT "$SNAP_ID"

# ══════════════════════════════════════════════════════════════
# RESIZE
# ══════════════════════════════════════════════════════════════

step "Resizing instance: $CURRENT_TYPE → $TARGET_TYPE"

echo ""
echo "  This will change the instance type. The instance stays stopped."
echo "  No data, networking, or DNS changes are made."
echo ""
read -p "  Type 'resize' to confirm: " CONFIRM
if [ "$CONFIRM" != "resize" ]; then
  echo "  Aborted. Snapshot $SNAP_ID was still created (safe to delete)."
  exit 0
fi

aws ec2 modify-instance-attribute \
  --instance-id "$INSTANCE_ID" \
  --instance-type "{\"Value\":\"${TARGET_TYPE}\"}"

info "Instance type changed to $TARGET_TYPE"

# ── Verify the change stuck ──────────────────────────────────
NEW_TYPE=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].InstanceType' --output text)

if [ "$NEW_TYPE" = "$TARGET_TYPE" ]; then
  info "Verified: instance type is now $NEW_TYPE"
else
  err "Verification failed. Expected $TARGET_TYPE, got $NEW_TYPE"
  echo "  Check the AWS console. The snapshot $SNAP_ID is available for rollback."
  exit 1
fi

# ══════════════════════════════════════════════════════════════
# POST-RESIZE VERIFICATION
# ══════════════════════════════════════════════════════════════

step "Post-resize verification (instance still stopped)"

# Confirm nothing else changed
POST_INFO=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].[State.Name,InstanceType,Placement.AvailabilityZone,SubnetId,SecurityGroups[0].GroupId,IamInstanceProfile.Arn]' \
  --output text)

POST_STATE=$(echo "$POST_INFO" | awk '{print $1}')
POST_TYPE=$(echo "$POST_INFO" | awk '{print $2}')
POST_AZ=$(echo "$POST_INFO" | awk '{print $3}')
POST_SUBNET=$(echo "$POST_INFO" | awk '{print $4}')
POST_SG=$(echo "$POST_INFO" | awk '{print $5}')
POST_IAM=$(echo "$POST_INFO" | awk '{print $6}')

run_check "State: $POST_STATE" "$([ "$POST_STATE" = "stopped" ] && echo pass || echo fail)"
run_check "Type: $POST_TYPE" "$([ "$POST_TYPE" = "$TARGET_TYPE" ] && echo pass || echo fail)"
run_check "AZ: $POST_AZ (unchanged)" "$([ "$POST_AZ" = "$CURRENT_AZ" ] && echo pass || echo fail)"

# Confirm EBS still attached
POST_VOL=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' \
  --output text)

run_check "EBS volume: $POST_VOL (unchanged)" "$([ "$POST_VOL" = "$ROOT_VOL_ID" ] && echo pass || echo fail)"

# Confirm EIP still allocated
POST_EIP=$(aws ec2 describe-addresses \
  --allocation-ids "$EIP_ALLOC" \
  --query 'Addresses[0].PublicIp' --output text 2>/dev/null || echo "GONE")

run_check "Elastic IP: $POST_EIP (allocated)" "$([ "$POST_EIP" = "$EIP_PUBLIC" ] && echo pass || echo fail)"

# Confirm target group still has our instance
POST_TG=$(aws elbv2 describe-target-health \
  --target-group-arn "$TG_ARN" \
  --query 'TargetHealthDescriptions[0].Target.Id' --output text 2>/dev/null || echo "NONE")

run_check "Target group: $POST_TG" "$([ "$POST_TG" = "$INSTANCE_ID" ] && echo pass || echo fail)"

# ══════════════════════════════════════════════════════════════
# UPDATE config.sh
# ══════════════════════════════════════════════════════════════

step "Updating config.sh"

CONFIG_PATH="$(dirname "${BASH_SOURCE[0]}")/config.sh"

if grep -q "^INSTANCE_TYPE=" "$CONFIG_PATH"; then
  sed -i "s/^INSTANCE_TYPE=.*/INSTANCE_TYPE=\"${TARGET_TYPE}\"/" "$CONFIG_PATH"
  info "config.sh updated: INSTANCE_TYPE=\"$TARGET_TYPE\""
else
  warn "Could not find INSTANCE_TYPE line in config.sh — update manually"
fi

# ══════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════

banner "Resize Complete — Instance Still Stopped"
echo "  Instance:     $INSTANCE_ID"
echo "  Previous:     $CURRENT_TYPE"
echo "  Current:      $TARGET_TYPE"
echo "  Elastic IP:   $EIP_PUBLIC"
echo "  Snapshot:     $SNAP_ID"
echo "  EBS volume:   $ROOT_VOL_ID (${VOL_SIZE}GB $VOL_TYPE)"
echo ""
echo "  config.sh has been updated to reflect the new instance type."
echo ""
echo "  When you are ready to start the instance:"
echo "    aws ec2 start-instances --instance-ids $INSTANCE_ID"
echo "    aws ec2 wait instance-running --instance-ids $INSTANCE_ID"
echo ""
echo "  After startup, verify the application:"
echo "    bash $(dirname "${BASH_SOURCE[0]}")/07-verify.sh"
echo ""
echo "  The pre-resize snapshot ($SNAP_ID) can be deleted once"
echo "  you confirm everything works:"
echo "    aws ec2 delete-snapshot --snapshot-id $SNAP_ID"
echo ""
echo "  Estimated monthly savings: m7i-flex.large (~\$73) → t3.small (~\$15)"
