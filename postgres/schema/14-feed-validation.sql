/**
#
# Copyright (c) 2026 majiklTrust Market Intelligence, LLC. All rights reserved.
#
# This file is part of Market Intelligence and contains proprietary and
# confidential information. Unauthorized copying, modification, distribution,
# or use of this file, via any medium, is strictly prohibited without the
# express written permission of the copyright holder.
#

**/

-- ═══════════════════════════════════════════════════════════════
-- 14-feed-validation.sql — Validation tracking for feeds_v2
-- ═══════════════════════════════════════════════════════════════
-- Adds tracking columns for feed URL validation results.
-- Used by feed-validator.js to record the last validation
-- grade, timestamp, and consecutive failure count.
--
-- Behavior is configurable via agent_state:
--   feed_validation_action = 'log_only' | 'disable' | 'skip'
--   Default: log_only (leave failing feeds in place, just log)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE feeds_v2
  ADD COLUMN IF NOT EXISTS consecutive_failures INT DEFAULT 0;

ALTER TABLE feeds_v2
  ADD COLUMN IF NOT EXISTS last_validation_grade TEXT;

ALTER TABLE feeds_v2
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ;

COMMENT ON COLUMN feeds_v2.consecutive_failures IS
  'Number of consecutive validation/poll failures. Reset to 0 on success.';

COMMENT ON COLUMN feeds_v2.last_validation_grade IS
  'Most recent validation grade: A (fresh+fast), B (has content), C (empty/stale), F (failed).';

COMMENT ON COLUMN feeds_v2.last_validated_at IS
  'Timestamp of the most recent validation attempt.';

-- Grant UPDATE on new columns to the app role
GRANT UPDATE ON feeds_v2 TO linkedin_agent_app;
