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
-- 23-post-scheduling.sql — Scheduled-post feature (v1.9.33)
-- ═══════════════════════════════════════════════════════════════
-- Adds the status values and the per-post destination column needed
-- by the scheduled-post feature. Idempotent (IF NOT EXISTS).
--
-- The scheduling COLUMN and INDEX already exist from 02-tenant-tables.sql
-- (posts.scheduled_for TIMESTAMPTZ + idx_posts_tenant_scheduled, a
-- partial index on scheduled_for IS NOT NULL). This migration only adds
-- the missing enum values and the destination discriminator.
--
-- NOTE on ALTER TYPE ... ADD VALUE: Postgres does not allow a newly
-- added enum value to be USED in the same transaction in which it was
-- added. This script only ADDS values and a column (it never inserts a
-- row using them), so it is safe whether run standalone (psql) or inside
-- a single migration transaction. Do not fold row-inserts that use these
-- values into the same transaction.
-- ═══════════════════════════════════════════════════════════════

-- ── Status vocabulary additions ──────────────────────────────
--   scheduled  — committed to publish at posts.scheduled_for; the batch
--                publisher claims these when scheduled_for <= now().
--   publishing — short-lived claim/in-flight marker set the instant the
--                batch publisher takes a post, BEFORE the LinkedIn call.
--                Guarantees exactly-once: a crash mid-send leaves the post
--                visibly stuck here (for reconciliation) instead of
--                reverting to 'scheduled' and being re-published.
--   blocked    — terminal; written by executePost when the output security
--                filter rejects content. (Code already wrote this value;
--                the enum was missing it — this also fixes that latent bug.)
ALTER TYPE post_status ADD VALUE IF NOT EXISTS 'scheduled';
ALTER TYPE post_status ADD VALUE IF NOT EXISTS 'publishing';
ALTER TYPE post_status ADD VALUE IF NOT EXISTS 'blocked';

-- ── Per-post destination (MDP-proofing seam) ─────────────────
-- Separates the TIMING layer (scheduler/batch publisher — destination
-- agnostic) from the DESTINATION layer. NULL means "use the global
-- LINKEDIN_PUBLISH_TARGET default" so existing personal-posting behavior
-- is unchanged. When organization / Marketing Developer Platform (MDP)
-- posting is implemented, a post can carry its own target ('organization')
-- and the publisher honors it per-post — no change to scheduling code.
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS publish_target TEXT
    CHECK (publish_target IS NULL OR publish_target IN ('personal', 'organization'));

COMMENT ON COLUMN posts.publish_target IS
  'Per-post LinkedIn destination. NULL = use global LINKEDIN_PUBLISH_TARGET. '
  'personal = member URN; organization = org URN (MDP, future). The scheduler '
  'and batch publisher are destination-agnostic; the publisher resolves this.';
