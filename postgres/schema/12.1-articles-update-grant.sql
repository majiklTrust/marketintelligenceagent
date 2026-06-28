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
-- 12.1-articles-update-grant.sql — UPDATE privilege for image
-- harvesting ON CONFLICT DO UPDATE on articles_v2
-- ═══════════════════════════════════════════════════════════════
-- The 12-image-support.sql migration added image_url to
-- articles_v2. The feed poll INSERT changed from
-- ON CONFLICT (link) DO NOTHING to ON CONFLICT DO UPDATE
-- to backfill image_url on existing articles.
--
-- PostgreSQL requires UPDATE privilege for ON CONFLICT DO UPDATE.
-- The linkedin_agent_app role previously had INSERT + SELECT
-- only. This adds the missing UPDATE grant.
-- ═══════════════════════════════════════════════════════════════

GRANT UPDATE ON articles_v2 TO linkedin_agent_app;
