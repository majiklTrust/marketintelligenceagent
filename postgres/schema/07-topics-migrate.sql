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
-- Phase 6 DDL — Topics migration: per-user ownership + permissions
-- ═══════════════════════════════════════════════════════════════
-- Target: linkedin_posting_database (schema: public)
-- Run as: agent (superuser)
-- ═══════════════════════════════════════════════════════════════

-- Step 1: Add user_sub column for per-user topic ownership.
-- NULL = global (tenant-level), set = personal (user-level).
ALTER TABLE topics ADD COLUMN IF NOT EXISTS user_sub TEXT;

-- Step 2: Add description column for AI generation input.
-- The user's one-sentence description of what the topic covers.
ALTER TABLE topics ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';

-- Step 3: Add topic management permissions.
-- manage_topics: CRUD any topic in the tenant (global + personal)
-- manage_own_topics: CRUD own personal topics + read global
INSERT INTO role_permissions (role, permission) VALUES
  ('owner', 'manage_topics'),
  ('owner', 'manage_own_topics'),
  ('editor', 'manage_own_topics')
ON CONFLICT DO NOTHING;

-- Step 4: Remove preview_post from viewer.
DELETE FROM role_permissions
WHERE role = 'viewer' AND permission = 'preview_post';
