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

import { currentClient } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
















const CATCHALL_FEEDS = Object.freeze([
  
  {
    url: "https://www.technologyreview.com/feed/",
    name: "MIT Technology Review",
    tier: "primary",
    refresh: 240
  },
  {
    url: "https://www.wired.com/feed/rss",
    name: "Wired",
    tier: "secondary",
    refresh: 120
  },
  {
    url: "https://feeds.arstechnica.com/arstechnica/index",
    name: "Ars Technica",
    tier: "primary",
    refresh: 120
  },
  {
    url: "https://www.theverge.com/rss/index.xml",
    name: "The Verge",
    tier: "secondary",
    refresh: 120
  },
  {
    url: "https://www.zdnet.com/news/rss.xml",
    name: "ZDNet",
    tier: "secondary",
    refresh: 120
  },

  
  {
    url: "https://www.fastcompany.com/latest/rss",
    name: "Fast Company",
    tier: "secondary",
    refresh: 180
  },

  
  {
    url: "https://feeds.bbci.co.uk/news/technology/rss.xml",
    name: "BBC Technology",
    tier: "primary",
    refresh: 180
  },
  {
    url: "https://feeds.npr.org/1019/rss.xml",
    name: "NPR Technology",
    tier: "primary",
    refresh: 240
  },

  
  {
    url: "https://www.nature.com/nature.rss",
    name: "Nature News",
    tier: "primary",
    refresh: 360
  },

  
  {
    url: "https://www.statnews.com/feed/",
    name: "STAT News",
    tier: "primary",
    refresh: 240
  }
]);



function client() {
  const c = currentClient();
  if (!c) {
    throw new Error("seedTenantDefaults requires tenant context (call inside withTenant)");
  }
  return c;
}

export async function seedTenantDefaults() {
  const c = client();
  let inserted = 0;

  for (const f of CATCHALL_FEEDS) {
    const result = await c.query(
      `INSERT INTO feeds_v2
         (tenant_id, url, name, tier, refresh_minutes, is_catchall)
       VALUES
         (current_tenant_id(), $1, $2, $3::feed_tier, $4, true)
       ON CONFLICT (tenant_id, url) DO NOTHING`,
      [f.url, f.name, f.tier, f.refresh]
    );
    if (result.rowCount > 0) inserted++;
  }

  
  
  
  if (inserted > 0) {
    try {
      const { validateFeed, formatValidationMessage } = await import("../services/feed-validator.js");
      const feedsResult = await c.query(
        `SELECT id, url, name FROM feeds_v2
         WHERE is_catchall = true AND last_validated_at IS NULL`
      );

      const grades = { A: 0, B: 0, C: 0, F: 0 };
      for (const row of feedsResult.rows) {
        const v = await validateFeed(row.url);
        grades[v.grade]++;

        try {
          await c.query(
            `UPDATE feeds_v2
             SET last_validation_grade = $1,
                 last_validated_at = now(),
                 consecutive_failures = CASE WHEN $1 = 'F' THEN 1 ELSE 0 END
             WHERE id = $2`,
            [v.grade, row.id]
          );
        } catch {  }

        platformLog("info", "seed_feed_validated", {
          feed: row.name, message: formatValidationMessage(v)
        });
      }

      platformLog("info", "seed_validation_summary", {
        total: feedsResult.rows.length, ...grades
      });
    } catch (valErr) {
      platformLog("warn", "seed_validation_skipped", {
        error: valErr.message.substring(0, 200)
      });
    }
  }

  return { feeds: inserted };
}

export function getCatchallFeedList() {
  return CATCHALL_FEEDS.map(f => ({
    name: f.name,
    url: f.url,
    tier: f.tier
  }));
}
