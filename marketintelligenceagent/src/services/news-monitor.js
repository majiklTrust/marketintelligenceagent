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

import Parser from "rss-parser";
import cron from "node-cron";
import { logActivity } from "./database.js";
import { platformLog } from "./platform-log.js";
import { sanitizeTitle, sanitizeSummary, sanitizeLink, detectPromptInjection } from "./sanitize-content.js";
import { extractArticleImage } from "./article-image.js";
import { resolvePollSchedule } from "../config/poll-schedule.js";
import { currentClient } from "../db/with-tenant.js";
import { withTenant } from "../db/with-tenant.js";
import { listActiveTenants } from "../tenant/platform-db.js";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "LinkedInAIAgent/1.5 (RSS Reader)" },
  customFields: {
    item: [
      ["media:content", "media:content", { keepArray: false }],
      ["media:thumbnail", "media:thumbnail", { keepArray: false }],
      ["media:group", "media:group", { keepArray: false }]
    ]
  }
});

let monitorJob = null;



import {
  getMaxAgeDays, getMaxAgeDaysPrune, getMaxResearchArticles,
  getFeedsManagerVersion, getDomainMatchThreshold, domainMatchScore
} from "../config/research.js";



function client() {
  const c = currentClient();
  if (!c) {
    throw new Error("news-monitor operation requires tenant context (call inside withTenant)");
  }
  return c;
}







function coerceString(val) {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "object") {
    
    if (val._ !== undefined) return String(val._);
    
    if (val.$ && val.$.href) return String(val.$.href);
    
    if (Array.isArray(val) && val.length > 0) return coerceString(val[0]);
    
    try { return JSON.stringify(val); } catch { return ""; }
  }
  return "";
}

// ── Feed Fetching ────────────────────────────────────────────

// Article image extraction lives in services/article-image.js
// (pure module; image-capture fix). It handles enclosure,
// media:content/media:thumbnail — including array shapes and
// media:group nesting — and runs every candidate through the
// SSRF + image checks in security.js.
// Must be called inside withTenant.
// feedRow: a row from feeds_v2 (id, url, name, tier, etc.)

async function fetchFeed(feedRow) {
  let httpStatus = null;
  try {
    // Fetch RSS manually to capture HTTP status code.
    // parser.parseURL() hides the status — we need it for logging.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      response = await fetch(feedRow.url, {
        headers: {
          "User-Agent": "LinkedInAIAgent/1.5 (RSS Reader)",
          "Accept": "application/rss+xml, application/xml, text/xml"
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    httpStatus = response.status;

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const xml = await response.text();

    
    
    
    var sanitizedXml = xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/gi, '&amp;');

    const feed = await parser.parseString(sanitizedXml);
    let newArticles = 0;
    let linked = 0;
    const c = client();

    
    const channelDescription = coerceString(feed.description).substring(0, 1000).trim();
    const channelCategories = Array.isArray(feed.categories)
      ? feed.categories.map(c => coerceString(c).trim()).filter(Boolean)
      : [];

    
    const itemCategorySet = new Set(channelCategories);

    for (const item of feed.items || []) {
      
      if (Array.isArray(item.categories)) {
        for (const cat of item.categories) {
          const trimmed = coerceString(cat).trim();
          if (trimmed && itemCategorySet.size < 50) {
            itemCategorySet.add(trimmed);
          }
        }
      }

      const link = sanitizeLink(coerceString(item.link) || coerceString(item.guid));
      if (!link) continue;

      const rawSummary = coerceString(item.contentSnippet) || coerceString(item.content) || coerceString(item.summary) || "";
      const cleanSummary = sanitizeSummary(rawSummary);
      const cleanTitle = sanitizeTitle(coerceString(item.title) || "Untitled");

      
      const titleInjection = detectPromptInjection(cleanTitle);
      const summaryInjection = detectPromptInjection(cleanSummary);

      if (titleInjection.detected || summaryInjection.detected) {
        await logActivity("warn", "prompt_injection_detected", {
          feed: feedRow.name,
          link,
          titlePatterns: titleInjection.patterns,
          summaryPatterns: summaryInjection.patterns
        });
        platformLog("warn", "prompt_injection_detected", {
          feed: feedRow.name, link,
          titlePatterns: titleInjection.patterns,
          summaryPatterns: summaryInjection.patterns
        });
        continue;
      }

      const published = coerceString(item.isoDate) || coerceString(item.pubDate) || null;
      const hash = simpleHash(link + cleanTitle);
      const imageUrl = extractArticleImage(item);

      
      
      
      const articleResult = await c.query(
        `INSERT INTO articles_v2 (title, link, summary, published_at, content_hash, image_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (link) DO UPDATE
           SET image_url = COALESCE(articles_v2.image_url, EXCLUDED.image_url)
         RETURNING id, (xmax = 0) AS is_new`,
        [cleanTitle, link, cleanSummary, published, hash, imageUrl]
      );

      const articleId = articleResult.rows[0].id;
      if (articleResult.rows[0].is_new) newArticles++;

      
      
      const linkResult = await c.query(
        `INSERT INTO feed_articles (tenant_id, feed_id, article_id)
         VALUES (current_tenant_id(), $1, $2)
         ON CONFLICT (feed_id, article_id) DO NOTHING`,
        [feedRow.id, articleId]
      );

      if (linkResult.rowCount > 0) linked++;
    }

    
    const categories = [...itemCategorySet];
    await c.query(
      `UPDATE feeds_v2
       SET last_polled_at = now(),
           last_error = NULL,
           consecutive_failures = 0,
           last_validation_grade = $2,
           last_validated_at = now(),
           feed_description = COALESCE(NULLIF($3, ''), feed_description),
           feed_categories = CASE
             WHEN $4::jsonb != '[]'::jsonb THEN $4::jsonb
             ELSE feed_categories
           END
       WHERE id = $1`,
      [feedRow.id, newArticles > 0 ? "A" : "B", channelDescription, JSON.stringify(categories)]
    );

    await logActivity("info", "feed_fetched", {
      feed: feedRow.name,
      status: httpStatus,
      newArticles,
      linked,
      totalItems: feed.items?.length || 0
    });
    platformLog("info", "feed_fetched", {
      feed: feedRow.name, status: httpStatus,
      newArticles, linked, totalItems: feed.items?.length || 0
    });

    return { newArticles, linked };
  } catch (err) {
    
    
    
    platformLog("warn", "feed_fetch_failed", {
      status: httpStatus, error: err.message.substring(0, 300),
      feed: feedRow.id, feedName: feedRow.name, url: feedRow.url
    });

    
    const c = client();
    try {
      await c.query(
        `UPDATE feeds_v2
         SET last_error = $1,
             consecutive_failures = consecutive_failures + 1,
             last_validation_grade = 'F',
             last_validated_at = now()
         WHERE id = $2`,
        [err.message.substring(0, 500), feedRow.id]
      );
    } catch {  }

    
    try {
      await logActivity("warn", "feed_fetch_failed", {
        status: httpStatus, error: err.message.substring(0, 300),
        feed: feedRow.id, feedName: feedRow.name, url: feedRow.url
      });
    } catch {  }
    return { newArticles: 0, linked: 0 };
  }
}




export async function pollAllFeeds() {
  const c = client();

  
  const feedsResult = await c.query(
    `SELECT id, url, name, tier::text, refresh_minutes, last_polled_at
     FROM feeds_v2
     WHERE enabled = true
     ORDER BY last_polled_at ASC NULLS FIRST`
  );

  const feeds = feedsResult.rows;

  await logActivity("info", "feed_poll_started", { feedCount: feeds.length });
  platformLog("info", "feed_poll_started", { feedCount: feeds.length });

  let totalNew = 0;
  let totalLinked = 0;
  
  
  
  
  let fetched = 0;
  let cooldownSkipped = 0;
  const minRefreshMinutes = feeds.length > 0
    ? Math.min(...feeds.map(f => f.refresh_minutes)) : null;

  for (const feedRow of feeds) {
    
    if (feedRow.last_polled_at) {
      const minutesSincePoll = (Date.now() - new Date(feedRow.last_polled_at).getTime()) / 60000;
      if (minutesSincePoll < feedRow.refresh_minutes) {
        cooldownSkipped++;
        continue;
      }
    }

    const result = await fetchFeed(feedRow);
    fetched++;
    totalNew += result.newArticles;
    totalLinked += result.linked;
    await new Promise(r => setTimeout(r, 1500));
  }

  
  
  
  const pruneWindow = getMaxAgeDaysPrune();
  const pruned = await c.query(
    `DELETE FROM feed_articles
     WHERE tenant_id = current_tenant_id()
       AND article_id IN (
         SELECT a.id FROM articles_v2 a
         WHERE a.published_at < now() - ($1 || ' days')::interval
       )`,
    [String(pruneWindow)]
  );

  await logActivity("info", "feed_poll_complete", {
    newArticles: totalNew,
    linked: totalLinked,
    prunedLinks: pruned.rowCount,
    fetched, cooldownSkipped, minRefreshMinutes
  });
  platformLog("info", "feed_poll_complete", {
    newArticles: totalNew, linked: totalLinked, prunedLinks: pruned.rowCount,
    fetched, cooldownSkipped, minRefreshMinutes
  });

  return totalNew;
}








export async function pollSingleFeed(feedId) {
  const c = client();

  const feedResult = await c.query(
    `SELECT id, url, name, tier::text, refresh_minutes, last_polled_at, last_error
     FROM feeds_v2
     WHERE id = $1 AND enabled = true`,
    [feedId]
  );

  if (feedResult.rows.length === 0) {
    return { success: false, error: "Feed not found or disabled", feedId };
  }

  const feedRow = feedResult.rows[0];

  platformLog("info", "single_feed_poll_started", {
    feedId: feedRow.id, feedName: feedRow.name, url: feedRow.url
  });

    const result = await fetchFeed(feedRow);

  
  
  
  
  const updated = await c.query(
    `SELECT last_polled_at, last_error FROM feeds_v2 WHERE id = $1`,
    [feedId]
  );
  const updatedRow = updated.rows[0] || {};

  return {
    success: !updatedRow.last_error,
    feed: {
      id: feedRow.id,
      name: feedRow.name,
      url: feedRow.url,
      tier: feedRow.tier
    },
    newArticles: result.newArticles,
    linked: result.linked,
    lastPolledAt: updatedRow.last_polled_at,
    lastError: updatedRow.last_error || null
  };
}




export async function getArticlesForTopic(topicSlug, maxAgeDays = null, limit = null) {
  const ageDays = maxAgeDays || getMaxAgeDays();
  const articleLimit = limit || getMaxResearchArticles();
  const version = await getFeedsManagerVersion();

  if (version === 2) {
    return _getArticlesForTopicV2(topicSlug, ageDays, articleLimit);
  }
  return _getArticlesForTopicV1(topicSlug, ageDays, articleLimit);
}




async function _getArticlesForTopicV1(topicSlug, ageDays, articleLimit) {
  const c = client();
  const r = await c.query(
    `SELECT DISTINCT a.id, a.title, a.link, a.summary, a.published_at,
            a.image_url, f.name AS feed_name, f.tier::text AS feed_tier
     FROM articles_v2 a
     JOIN feed_articles fa ON fa.article_id = a.id
     JOIN feeds_v2 f ON f.id = fa.feed_id
     LEFT JOIN feed_topics ft ON ft.feed_id = f.id
     LEFT JOIN topics t ON t.id = ft.topic_id AND t.slug = $1
     WHERE (t.id IS NOT NULL OR f.is_catchall = true)
       AND a.published_at >= now() - ($2 || ' days')::interval
     ORDER BY CASE WHEN t.id IS NOT NULL THEN 0 ELSE 1 END,
              a.published_at DESC
     LIMIT $3`,
    [topicSlug, String(ageDays), articleLimit]
  );
  return r.rows;
}










async function _getArticlesForTopicV2(topicSlug, ageDays, articleLimit) {
  const c = client();
  const threshold = getDomainMatchThreshold();

  const topicResult = await c.query(
    `SELECT domains FROM topics WHERE slug = $1`,
    [topicSlug]
  );
  const rawDomains = topicResult.rows[0]?.domains || [];
  
  const topicDomains = Array.isArray(rawDomains)
    ? rawDomains
    : (() => { try { const p = JSON.parse(rawDomains); return Array.isArray(p) ? p : []; } catch { return []; } })();

  const r = await c.query(
    `SELECT DISTINCT a.id, a.title, a.link, a.summary, a.published_at,
            a.image_url, f.name AS feed_name, f.tier::text AS feed_tier,
            f.is_catchall, f.domains AS feed_domains,
            (t.id IS NOT NULL) AS is_topic_specific
     FROM articles_v2 a
     JOIN feed_articles fa ON fa.article_id = a.id
     JOIN feeds_v2 f ON f.id = fa.feed_id
     LEFT JOIN feed_topics ft ON ft.feed_id = f.id
     LEFT JOIN topics t ON t.id = ft.topic_id AND t.slug = $1
     WHERE (t.id IS NOT NULL OR f.is_catchall = true
            OR (f.domains IS NOT NULL AND f.domains != '[]'::jsonb))
       AND a.published_at >= now() - ($2 || ' days')::interval
     ORDER BY a.published_at DESC`,
    [topicSlug, String(ageDays)]
  );

  platformLog("info", "v2_match_candidates", {
    topicSlug, topicDomains, threshold,
    totalCandidates: r.rows.length,
    feedBreakdown: Object.entries(
      r.rows.reduce((acc, a) => { acc[a.feed_name] = (acc[a.feed_name] || 0) + 1; return acc; }, {})
    ).map(([name, count]) => `${name}:${count}`).join(", ")
  });

  const scored = [];
  for (const a of r.rows) {
    let priority;

    if (a.is_topic_specific) {
      priority = 0;
    } else {
      const score = domainMatchScore(a.feed_domains || [], topicDomains);
      if (score > threshold) {
        priority = 1;
      } else if (a.is_catchall) {
        priority = 2;
      } else {
        continue;
      }
    }

    scored.push({
      id: a.id, title: a.title, link: a.link, summary: a.summary,
      published_at: a.published_at, feed_name: a.feed_name,
      feed_tier: a.feed_tier, _priority: priority
    });
  }

  
  const dist = { p0: 0, p1: 0, p2: 0 };
  scored.forEach(s => { dist[`p${s._priority}`]++; });
  platformLog("info", "v2_match_result", {
    topicSlug, scored: scored.length, limit: articleLimit, ...dist
  });

  scored.sort((a, b) =>
    (a._priority || 0) - (b._priority || 0) ||
    new Date(b.published_at) - new Date(a.published_at)
  );

  return scored.slice(0, articleLimit);
}

export async function searchArticles(keywords, topicSlug = null, maxAgeDays = null, limit = 20) {
  const ageDays = maxAgeDays || getMaxAgeDays();
  const c = client();
  const conditions = [];
  const params = [];
  let i = 1;

  for (const kw of keywords) {
    conditions.push(`(a.title ILIKE $${i} OR a.summary ILIKE $${i})`);
    params.push(`%${kw}%`);
    i++;
  }

  if (topicSlug) {
    conditions.push(`t.slug = $${i}`);
    params.push(topicSlug);
    i++;
  }

  conditions.push(`a.published_at >= now() - ($${i} || ' days')::interval`);
  params.push(String(ageDays));
  i++;
  params.push(limit);

  const topicJoin = topicSlug
    ? `JOIN feed_topics ft ON ft.feed_id = f.id
       JOIN topics t ON t.id = ft.topic_id`
    : "";

  const sql = `
    SELECT DISTINCT a.id, a.title, a.link, a.summary, a.published_at,
           a.image_url, f.name AS feed_name, f.tier::text AS feed_tier
    FROM articles_v2 a
    JOIN feed_articles fa ON fa.article_id = a.id
    JOIN feeds_v2 f ON f.id = fa.feed_id
    ${topicJoin}
    WHERE ${conditions.join(" AND ")}
    ORDER BY a.published_at DESC
    LIMIT $${i}
  `;

  const r = await c.query(sql, params);
  return r.rows;
}

export async function getArticleStats() {
  const c = client();
  const ageDays = getMaxAgeDays();

  const total = await c.query(
    `SELECT COUNT(DISTINCT fa.article_id)::int AS count
     FROM feed_articles fa`
  );
  const byFeed = await c.query(
    `SELECT f.name AS feed_name, f.tier::text AS feed_tier,
            COUNT(DISTINCT fa.article_id)::int AS count
     FROM feed_articles fa
     JOIN feeds_v2 f ON f.id = fa.feed_id
     JOIN articles_v2 a ON a.id = fa.article_id
     WHERE a.published_at >= now() - ($1 || ' days')::interval
     GROUP BY f.name, f.tier
     ORDER BY CASE f.tier::text
                WHEN 'authoritative' THEN 1
                WHEN 'primary' THEN 2
                WHEN 'secondary' THEN 3
                ELSE 4
              END, f.name`,
    [String(ageDays)]
  );
  const recent = await c.query(
    `SELECT COUNT(DISTINCT fa.article_id)::int AS count
     FROM feed_articles fa
     JOIN articles_v2 a ON a.id = fa.article_id
     WHERE a.published_at >= now() - ($1 || ' days')::interval`,
    [String(ageDays)]
  );

  return {
    totalArticles: total.rows[0].count,
    recentArticles: recent.rows[0].count,
    maxAgeDays: ageDays,
    byFeed: byFeed.rows
  };
}

// ── Monitor Lifecycle ────────────────────────────────────────

async function runPollForAllTenants() {
  let tenants;
  try {
    tenants = await listActiveTenants();
  } catch (err) {
    console.error("[news-monitor] failed to list tenants:", err.message);
    return;
  }

  for (const tenant of tenants) {
    try {
      await withTenant(tenant.id, async () => {
        await pollAllFeeds();
      });
    } catch (err) {
      console.error(`[news-monitor] tenant ${tenant.slug} poll failed:`, err.message);
    }
  }
}

export function startMonitor() {
  // Initial poll at startup — async, don't block boot
  runPollForAllTenants().catch(err => {
    console.error("[news-monitor] initial poll failed:", err.message);
  });

  // Recurring poll for all tenants. Schedule is FEED_POLL_CRON
  // (validated; numeric 5-field syntax) with hourly as the safe
  // default — an invalid value logs loudly and polling continues
  // hourly rather than silently stopping.
  const sched = resolvePollSchedule(process.env.FEED_POLL_CRON);
  if (!sched.valid) {
    console.error(`[news-monitor] FEED_POLL_CRON "${sched.rejected}" is not a supported cron expression — using default "${sched.expression}" (hourly)`);
    platformLog("error", "feed_poll_cron_invalid", { rejected: sched.rejected, using: sched.expression });
  }
  monitorJob = cron.schedule(sched.expression, () => {
    runPollForAllTenants().catch(err => {
      console.error("[news-monitor] scheduled poll failed:", err.message);
    });
  });

  console.log(`📡 News monitor started — polling feeds on "${sched.expression}" (${sched.source}); per-feed refresh_minutes cooldowns gate each fetch (see feed_poll_complete for fetched/cooldownSkipped/minRefreshMinutes)`);
}

export function stopMonitor() {
  if (monitorJob) {
    monitorJob.stop();
    console.log("📡 News monitor stopped");
  }
}



function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}
