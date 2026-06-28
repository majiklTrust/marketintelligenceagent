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
-- 17-platform-admin-role.sql
-- ═══════════════════════════════════════════════════════════════
-- Grants the app role (linkedin_agent_app) the ability to assume
-- the admin role (agent_super) via SET LOCAL ROLE. This is used
-- exclusively by platform-admin-api.js to bypass RLS for
-- cross-tenant administrative queries.
--
-- SET LOCAL ROLE is transaction-scoped — the elevated role
-- reverts automatically on COMMIT/ROLLBACK. The pooled
-- connection returns to linkedin_agent_app with no leaked
-- privileges.
--
-- Prerequisites:
--   • agent_super must exist with BYPASSRLS or SUPERUSER
--   • linkedin_agent_app must exist
--
-- Idempotent: re-running is a no-op if the grant already exists.
-- ═══════════════════════════════════════════════════════════════

-- Allow the app role to assume the admin role inside transactions
GRANT agent_super TO linkedin_agent_app;

-- Verify the grant was applied
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE roleid = 'agent_super'::regrole
      AND member = 'linkedin_agent_app'::regrole
  ) THEN
    RAISE NOTICE '  ✓ GRANT agent_super TO linkedin_agent_app confirmed';
  ELSE
    RAISE WARNING '  ✗ GRANT agent_super TO linkedin_agent_app FAILED';
  END IF;
END $$;
