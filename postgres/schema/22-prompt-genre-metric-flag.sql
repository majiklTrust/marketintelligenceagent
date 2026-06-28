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
-- 22-prompt-genre-metric-flag.sql   (Composer feature)
-- ═══════════════════════════════════════════════════════════════
-- Per-genre flag marking a content_generator template as
-- metric-bearing. Derived from the template plaintext at submit time
-- (keyword scan, before encryption) and stored here so the composer's
-- compatibility menu can read it without decrypting anything.
--
--   • Additive and idempotent.
--   • DEFAULT FALSE: existing rows, and any genre not yet re-saved
--     through the admin panel, read as not metric-bearing until their
--     next save recomputes the flag.
--
-- Depends on: prompt_vault (18-prompt-vault.sql) and the genre column
-- (19-prompt-genre.sql). Apply after both.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE prompt_vault
  ADD COLUMN IF NOT EXISTS metric_bearing BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN prompt_vault.metric_bearing IS
  'TRUE when the template plaintext contained a metric keyword at submit time. Derived/cached; recomputed on each save.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'prompt_vault' AND column_name = 'metric_bearing'
  ) THEN
    RAISE NOTICE '  ✓ prompt_vault.metric_bearing column present';
  ELSE
    RAISE WARNING '  ✗ prompt_vault.metric_bearing column MISSING';
  END IF;
END $$;
