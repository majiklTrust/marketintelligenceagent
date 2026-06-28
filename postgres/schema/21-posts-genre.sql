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
-- 21-posts-genre.sql   (Composer feature — Cycle 1)
-- ═══════════════════════════════════════════════════════════════
-- Records which content_generator genre produced each post.
--
--   • Additive and idempotent — safe to run more than once.
--   • DEFAULT 'default' means every existing row, and every post
--     created by paths that do not yet supply a genre (the Preview
--     workflow and the scheduled cycle), is transparently recorded
--     as the base genre with no code change required.
--   • This column is provenance only. It does not alter generation;
--     it captures, for audit and reproducibility, the genre the
--     Composer selected. Population by the Composer save path lands
--     in a later cycle.
--
-- Depends on: posts (02-tenant-tables.sql). Apply after it.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS genre VARCHAR(32) NOT NULL DEFAULT 'default';

COMMENT ON COLUMN posts.genre IS
  'content_generator genre that produced this post. Provenance only; defaults to ''default'' for Preview and scheduled posts.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'posts' AND column_name = 'genre'
  ) THEN
    RAISE NOTICE '  ✓ posts.genre column present';
  ELSE
    RAISE WARNING '  ✗ posts.genre column MISSING';
  END IF;
END $$;
