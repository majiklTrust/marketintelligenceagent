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

import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { isPlatformAdmin } from "../tenant/platform-db.js";
import { pool } from "../db/pool.js";
import { platformLog } from "../services/platform-log.js";
import { decryptPlatformSecret } from "../services/platform-secret.js";
import { storePromptGenre } from "../services/prompt-vault.js";

const router = Router();







let ADMIN_DB_ROLE = null;

function resolveAdminRole() {
  if (ADMIN_DB_ROLE) return ADMIN_DB_ROLE;
  const cipher = process.env.PLATFORM_ADMIN_DB_ROLE;
  if (!cipher || typeof cipher !== "string" || cipher.trim().length === 0) {
    throw new Error("PLATFORM_ADMIN_DB_ROLE is not set — platform admin queries are disabled");
  }
  let role;
  try {
    role = decryptPlatformSecret(cipher.trim());
  } catch {
    throw new Error("PLATFORM_ADMIN_DB_ROLE could not be decrypted — platform admin queries are disabled");
  }
  const trimmed = role.trim();
  
  
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    throw new Error("Invalid PLATFORM_ADMIN_DB_ROLE: must be a valid PostgreSQL identifier");
  }
  ADMIN_DB_ROLE = trimmed;
  return ADMIN_DB_ROLE;
}






const MODEL_FAMILIES = [
  { group: "Sonnet", match: "sonnet" },
  { group: "Haiku", match: "haiku" },
  { group: "Opus", match: "opus" }
];

function groupModelsByFamily(models) {
  return MODEL_FAMILIES.map((fam) => ({
    group: fam.group,
    options: models
      .map((m) => m && m.id)
      .filter((id) => typeof id === "string" && id.toLowerCase().includes(fam.match))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  })).filter((g) => g.options.length > 0);
}

let modelCache = null;
let modelCacheAt = 0;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedModels() {
  if (modelCache && Date.now() - modelCacheAt < MODEL_CACHE_TTL_MS) return modelCache;
  return null;
}

function setCachedModels(optgroups) {
  modelCache = optgroups;
  modelCacheAt = Date.now();
}










const QUERY_REGISTRY = {

  "list-tenants": {
    label: "List All Tenants",
    description: "Shows all tenants with status, slug, and creation date.",
    capability: "See every tenant on the platform at a glance — status, slug, and creation date.",
    sql: `SELECT id, slug, name, status::text, created_at
          FROM tenants ORDER BY created_at DESC`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "list-memberships": {
    label: "List All Memberships",
    description: "Shows all tenant memberships with auth provider and role.",
    capability: "See who has access to which tenant, by auth provider and role.",
    sql: `SELECT t.slug, m.auth_sub,
                 m.role::text, m.auth_provider::text, m.created_at
          FROM memberships m
          JOIN tenants t ON t.id = m.tenant_id
          ORDER BY t.slug, m.created_at`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "tenant-feed-summary": {
    label: "Tenant Feed Summary",
    description: "Feed counts, catchall vs topic-specific, and validation grades for a tenant.",
    capability: "Inspect one tenant's feeds — validation grades, failures, and article counts.",
    sql: `SELECT f.name, f.url, f.tier::text, f.is_catchall,
                 f.last_validation_grade, f.consecutive_failures,
                 f.last_validated_at,
                 (SELECT count(*) FROM feed_articles fa WHERE fa.feed_id = f.id) AS article_count
          FROM feeds_v2 f
          WHERE f.tenant_id = $1
          ORDER BY f.name`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: false,
    readOnly: true
  },

  "tenant-agent-state": {
    label: "Tenant Agent State",
    description: "Shows all agent_state configuration values for a tenant.",
    capability: "Review a tenant's full agent configuration in one place, with schema metadata.",
    sql: `SELECT a.key, a.value, s.value_type, s.allowed_values, s.description
          FROM agent_state a
          LEFT JOIN agent_state_schema s ON s.key = a.key
          WHERE a.tenant_id = $1
          ORDER BY a.key`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: false,
    readOnly: true
  },

  "set-feeds-manager-version": {
    label: "Set Feeds Manager Version",
    description: "Sets feeds_manager_version for a tenant (1 or 2).",
    capability: "Switch a tenant between the v1 and v2 Feeds Manager UI.",
    sql: `INSERT INTO agent_state (tenant_id, key, value)
          VALUES ($1, 'feeds_manager_version', $2)
          ON CONFLICT (tenant_id, key) DO UPDATE SET value = $2`,
    params: [
      { name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true },
      { name: "version", label: "Version (1 or 2)", type: "text", required: true }
    ],
    destructive: false,
    readOnly: false
  },

  "clear-tenant-feeds": {
    label: "Clear All Tenant Feeds",
    description: "Removes all feeds, feed-topic mappings, and feed-article links for a tenant. Articles are preserved.",
    capability: "Wipe a tenant's feeds and feed links while preserving the underlying articles.",
    sql: `WITH deleted_mappings AS (
            DELETE FROM feed_topics WHERE tenant_id = $1
          ), deleted_articles AS (
            DELETE FROM feed_articles WHERE feed_id IN (
              SELECT id FROM feeds_v2 WHERE tenant_id = $1
            )
          )
          DELETE FROM feeds_v2 WHERE tenant_id = $1`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-posts": {
    label: "Clear Tenant Posts",
    description: "Removes all posts for a tenant.",
    capability: "Remove all of a tenant's posts — useful for resetting a demo or test tenant.",
    sql: `DELETE FROM posts WHERE tenant_id = $1`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-topics": {
    label: "Clear Tenant Topics",
    description: "Removes all topics and their feed mappings for a tenant.",
    capability: "Remove a tenant's topics and their feed mappings.",
    sql: `WITH deleted_mappings AS (
            DELETE FROM feed_topics WHERE tenant_id = $1
          )
          DELETE FROM topics WHERE tenant_id = $1`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-invites": {
    label: "Clear Tenant Member Invites (all users)",
    description: "Removes all member invites (pending and claimed) for a tenant.",
    capability: "Clear a tenant's invite records before re-inviting users.",
    sql: `DELETE FROM invites WHERE tenant_id = $1`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-memberships": {
    label: "Clear Tenant Membership",
    description: "Removes all memberships for a tenant, revoking every user's access.",
    capability: "Revoke all user access to a tenant in one step.",
    sql: `DELETE FROM memberships WHERE tenant_id = $1`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: true,
    readOnly: false
  },

  "clear-tenant-main": {
    label: "Clear Tenant",
    description: "Deletes the tenant row itself. Run the other clear-tenant queries first to remove dependent data.",
    capability: "Final teardown step — remove the tenant shell after its data is cleared.",
    sql: `DELETE FROM tenants WHERE id = $1`,
    params: [{ name: "id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: true,
    readOnly: false
  },

  "reseed-catchall-feeds": {
    label: "Reseed Catchall Feeds",
    description: "Re-inserts default catchall feeds for a tenant. Idempotent — skips existing URLs.",
    capability: "Restore the default catchall feed set for a tenant without touching existing feeds.",
    sql: `INSERT INTO feeds_v2 (tenant_id, url, name, tier, refresh_minutes, is_catchall) VALUES
            ($1, 'https://www.technologyreview.com/feed/', 'MIT Technology Review', 'primary', 240, true),
            ($1, 'https://www.wired.com/feed/rss', 'Wired', 'secondary', 120, true),
            ($1, 'https://feeds.arstechnica.com/arstechnica/index', 'Ars Technica', 'primary', 120, true),
            ($1, 'https://www.theverge.com/rss/index.xml', 'The Verge', 'secondary', 120, true),
            ($1, 'https://www.zdnet.com/news/rss.xml', 'ZDNet', 'secondary', 120, true),
            ($1, 'https://www.fastcompany.com/latest/rss', 'Fast Company', 'secondary', 180, true),
            ($1, 'https://feeds.bbci.co.uk/news/technology/rss.xml', 'BBC Technology', 'primary', 180, true),
            ($1, 'https://feeds.npr.org/1019/rss.xml', 'NPR Technology', 'primary', 240, true),
            ($1, 'https://www.nature.com/nature.rss', 'Nature News', 'primary', 360, true),
            ($1, 'https://www.statnews.com/feed/', 'STAT News', 'primary', 240, true)
          ON CONFLICT (tenant_id, url) DO NOTHING`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: false,
    readOnly: false
  },

  "reset-feed-failures": {
    label: "Reset Feed Failure Counters",
    description: "Resets consecutive_failures and last_validation_grade for all feeds in a tenant.",
    capability: "Clear failure counters and grades so feeds get a fresh polling chance.",
    sql: `UPDATE feeds_v2
          SET consecutive_failures = 0,
              last_validation_grade = NULL,
              last_validated_at = NULL,
              last_error = NULL
          WHERE tenant_id = $1`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: false,
    readOnly: false
  },

  "all-tenant-states": {
    label: "All Tenant Config States",
    description: "Shows agent_state configuration across all tenants with schema metadata.",
    capability: "Compare agent configuration across every tenant in one result.",
    sql: `SELECT t.slug AS tenant, a.key, a.value,
                 s.value_type, s.allowed_values
          FROM agent_state a
          JOIN tenants t ON t.id = a.tenant_id
          LEFT JOIN agent_state_schema s ON s.key = a.key
          ORDER BY t.slug, a.key`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "database-enum-fields": {
    label: "Database Wide enum Type Fields",
    description: "Shows all scoped fields.",
    capability: "Discover every enum type, where it's used, and its valid values — handy before setting status fields.",
    sql: `SELECT t.typname AS enum_type,
                c.relname AS table_name,
                a.attname AS column_name,
                ARRAY(SELECT e.enumlabel::text 
                      FROM pg_enum e 
                      WHERE e.enumtypid = t.oid 
                      ORDER BY e.enumsortorder) AS possible_values
          FROM pg_type t
          JOIN pg_enum e2 ON e2.enumtypid = t.oid
          JOIN pg_attribute a ON a.atttypid = t.oid
          JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relkind = 'r'
            AND NOT a.attisdropped
          GROUP BY t.typname, t.oid, c.relname, a.attname
          ORDER BY t.typname, c.relname`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "tenant-credentials-status": {
    label: "Tenant Credentials Status",
    description: "Shows which credentials exist for a tenant (names only — values are encrypted and never exposed).",
    capability: "Confirm which credentials a tenant has set without exposing the encrypted values.",
    sql: `SELECT key, length(value_enc) > 0 AS has_value, updated_at
          FROM credentials
          WHERE tenant_id = $1
          ORDER BY key`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: false,
    readOnly: true
  },

  

  "prompt-vault-inventory": {
    label: "Prompt Vault Inventory",
    description: "Lists every vaulted prompt: key, genre, description, encryption version, and last update. Encrypted content is never exposed.",
    capability: "See exactly which prompts and genre variants the vault protects and when each was last rotated.",
    sql: `SELECT key, genre, description, encryption_version, updated_at
          FROM prompt_vault
          ORDER BY key, genre`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "content-generator-genres": {
    label: "Content Generator Genres",
    description: "Lists the genre variants configured for the content_generator prompt. Encrypted content is never exposed.",
    capability: "Confirm which content genres exist before inserting a new one.",
    sql: `SELECT genre, description, updated_at
          FROM prompt_vault
          WHERE key = 'content_generator'
          ORDER BY genre`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "prompt-vault-summary": {
    label: "Prompt Vault Summary",
    description: "Aggregate snapshot: total prompts, distinct encryption versions in use, and oldest/newest update timestamps.",
    capability: "One-glance vault health — confirms all expected prompts are present and on the current encryption version.",
    sql: `SELECT count(*) AS total_prompts,
                 count(DISTINCT encryption_version) AS encryption_versions,
                 min(updated_at) AS oldest_update,
                 max(updated_at) AS newest_update
          FROM prompt_vault`,
    params: [],
    destructive: false,
    readOnly: true
  },

  

  "topic-content-blueprint": {
    label: "Topic Content Blueprint",
    description: "For one topic (by slug): expands content_angles, search_templates, hashtags, and domains, plus system_context and config.",
    capability: "See everything that drives a single topic's research and generation in one view.",
    sql: `SELECT slug, name, system_context,
                 content_angles, search_templates, hashtags, domains,
                 weight, max_age_days, enabled
          FROM topics
          WHERE slug = $1`,
    params: [{ name: "slug", label: "Topic slug", type: "text", required: true }],
    destructive: false,
    readOnly: true
  },

  "topic-feed-article-rollup": {
    label: "Topic / Feed / Article Rollup",
    description: "Per topic: number of mapped feeds and number of articles reachable through those feeds.",
    capability: "See the topic → feed → article funnel size for every topic at a glance.",
    sql: `SELECT t.slug, t.name,
                 count(DISTINCT ft.feed_id) AS mapped_feeds,
                 count(DISTINCT fa.article_id) AS available_articles
          FROM topics t
          LEFT JOIN feed_topics ft ON ft.topic_id = t.id
          LEFT JOIN feed_articles fa ON fa.feed_id = ft.feed_id
          GROUP BY t.slug, t.name
          ORDER BY t.slug`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "feed-domain-catalog": {
    label: "Feed Domain Catalog",
    description: "Per feed: name, tier, catchall flag, feed_categories, and domains.",
    capability: "See how each feed is classified and which domains it claims.",
    sql: `SELECT name, tier::text, is_catchall, feed_categories, domains
          FROM feeds_v2
          ORDER BY is_catchall DESC, name`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "topic-feed-domain-overlap": {
    label: "Topic / Feed Domain Overlap",
    description: "Pairs topics and feeds (within the same tenant) whose domain arrays intersect.",
    capability: "Understand why a feed matches a topic — the domain overlap that drives article scoring.",
    sql: `SELECT t.slug AS topic, f.name AS feed,
                 t.domains AS topic_domains, f.domains AS feed_domains
          FROM topics t
          JOIN feeds_v2 f ON f.tenant_id = t.tenant_id
          WHERE t.domains IS NOT NULL AND f.domains IS NOT NULL
            AND jsonb_typeof(t.domains) = 'array'
            AND jsonb_typeof(f.domains) = 'array'
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(t.domains) td
              JOIN jsonb_array_elements_text(f.domains) fd ON td = fd
            )
          ORDER BY t.slug, f.name`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "article-lineage": {
    label: "Article Lineage (recent)",
    description: "50 most recent articles with their source feed, tier, and the topics that feed maps to.",
    capability: "Trace any article backward through its feed to the topics it can feed.",
    sql: `SELECT a.title, a.published_at, f.name AS feed, f.tier::text AS tier,
                 string_agg(DISTINCT t.slug, ', ') AS mapped_topics
          FROM articles_v2 a
          JOIN feed_articles fa ON fa.article_id = a.id
          JOIN feeds_v2 f ON f.id = fa.feed_id
          LEFT JOIN feed_topics ft ON ft.feed_id = f.id
          LEFT JOIN topics t ON t.id = ft.topic_id
          GROUP BY a.id, a.title, a.published_at, f.name, f.tier
          ORDER BY a.published_at DESC NULLS LAST
          LIMIT 50`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "feed-discovery-health": {
    label: "Feed Discovery Health",
    description: "Feeds with validation grade, consecutive failures, and last validated time, ordered by tier then failures.",
    capability: "See the health of discovered feeds and which ones need attention.",
    sql: `SELECT name, tier::text, last_validation_grade, consecutive_failures,
                 last_validated_at, is_catchall
          FROM feeds_v2
          ORDER BY tier, consecutive_failures DESC, name`,
    params: [],
    destructive: false,
    readOnly: true
  },

  "catchall-vs-topic-coverage": {
    label: "Catchall vs Topic Coverage",
    description: "Counts catchall feeds, topic-specific feeds, and topics with zero mapped feeds.",
    capability: "Spot coverage gaps — topics that have no dedicated feeds.",
    sql: `SELECT
            (SELECT count(*) FROM feeds_v2 WHERE is_catchall = true) AS catchall_feeds,
            (SELECT count(*) FROM feeds_v2 WHERE is_catchall = false) AS topic_specific_feeds,
            (SELECT count(*) FROM topics t WHERE NOT EXISTS (
               SELECT 1 FROM feed_topics ft WHERE ft.topic_id = t.id)) AS topics_with_no_feeds`,
    params: [],
    destructive: false,
    readOnly: true
  },

  

  "set-agent-paused": {
    label: "Set Agent Paused",
    description: "Pauses or resumes the agent for a tenant. Value must be 'true' or 'false'.",
    capability: "Stop or restart a tenant's scheduled posting without touching any other config.",
    sql: `INSERT INTO agent_state (tenant_id, key, value)
          VALUES ($1, 'paused', $2)
          ON CONFLICT (tenant_id, key) DO UPDATE SET value = $2`,
    params: [
      { name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true },
      { name: "value", label: "Paused (true or false)", type: "text", required: true }
    ],
    destructive: false,
    readOnly: false
  },

  "set-agent-corroboration": {
    label: "Set Corroboration",
    description: "Toggles multi-source corroboration for a tenant. Value must be 'enabled' or 'disabled'.",
    capability: "Turn cross-source fact-checking on or off for a tenant's content pipeline.",
    sql: `INSERT INTO agent_state (tenant_id, key, value)
          VALUES ($1, 'corroboration', $2)
          ON CONFLICT (tenant_id, key) DO UPDATE SET value = $2`,
    params: [
      { name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true },
      { name: "value", label: "Corroboration (enabled or disabled)", type: "text", required: true }
    ],
    destructive: false,
    readOnly: false
  },

  "set-agent-model": {
    label: "Set Language Model",
    description: "Sets the per-tenant Language Model override from the live model catalog. Falls back to the deployment default when unset.",
    capability: "Pin or change which LLM a tenant's generation pipeline uses.",
    sql: `INSERT INTO agent_state (tenant_id, key, value)
          VALUES ($1, 'anthropic_model', $2)
          ON CONFLICT (tenant_id, key) DO UPDATE SET value = $2`,
    params: [
      { name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true },
      { name: "value", label: "Model", type: "select", source: "models", required: true }
    ],
    destructive: false,
    readOnly: false
  },

  "set-agent-state-generic": {
    label: "Set Agent State (any key)",
    description: "Sets any agent_state key/value for a tenant. Use for properties without a dedicated setter.",
    capability: "Maintenance escape hatch — adjust any single agent_state property by key.",
    sql: `INSERT INTO agent_state (tenant_id, key, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (tenant_id, key) DO UPDATE SET value = $3`,
    params: [
      { name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true },
      { name: "key", label: "agent_state key", type: "text", required: true },
      { name: "value", label: "Value", type: "text", required: true }
    ],
    destructive: false,
    readOnly: false
  },

  

  "set-tenant-status": {
    label: "Set Tenant Status",
    description: "Sets the tenants.status field. Known values: pending, active, suspended. Suspending a tenant cuts off access.",
    capability: "Activate, suspend, or reset a tenant's lifecycle state. Run 'Database Wide enum Type Fields' to see all valid values.",
    sql: `UPDATE tenants SET status = $2::tenant_status WHERE id = $1`,
    params: [
      { name: "id", label: "Tenant UUID", type: "uuid", required: true },
      { name: "status", label: "Status (pending / active / suspended)", type: "text", required: true }
    ],
    destructive: true,
    readOnly: false
  },

  

  "tenant-post-status-breakdown": {
    label: "Tenant Post Status Breakdown",
    description: "Counts a tenant's posts grouped by status (draft, pending_approval, posted, etc.).",
    capability: "Diagnose stuck or piled-up posts — see how a tenant's posts are distributed across the workflow.",
    sql: `SELECT status::text, count(*) AS posts
          FROM posts
          WHERE tenant_id = $1
          GROUP BY status
          ORDER BY status`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: false,
    readOnly: true
  },

  "recent-errors": {
    label: "Recent Errors",
    description: "50 most recent error-level activity_log entries for a tenant.",
    capability: "Triage failures fast — surface a tenant's recent errors without shell access to logs.",
    sql: `SELECT timestamp, action, details
          FROM activity_log
          WHERE tenant_id = $1 AND level = 'error'::log_level
          ORDER BY timestamp DESC
          LIMIT 50`,
    params: [{ name: "tenant_id", label: "Tenant UUID", type: "uuid", required: true }],
    destructive: false,
    readOnly: true
  }
};



export default function createPlatformAdminRoutes() {
  const { requireAuth } = createAuthMiddleware();

  
  function requirePlatformAdmin(req, res, next) {
    if (!req.user || !isPlatformAdmin(req.user.sub)) {
      return res.status(403).json({ error: "Platform admin access required" });
    }
    next();
  }

  router.use(requireAuth);
  router.use(requirePlatformAdmin);

  
  

  router.get("/queries", (req, res) => {
    const queries = Object.entries(QUERY_REGISTRY).map(([key, q]) => ({
      key,
      label: q.label,
      description: q.description,
      capability: q.capability || null,
      params: q.params,
      destructive: q.destructive,
      readOnly: q.readOnly
    }));
    res.json({ queries });
  });

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  

  router.get("/models", async (req, res) => {
    const encKey = process.env.PLATFORM_ANTHROPIC_API_KEY;
    if (!encKey || encKey.trim().length === 0) {
      return res.status(503).json({ error: "Model listing is not configured" });
    }

    let apiKey;
    try {
      apiKey = decryptPlatformSecret(encKey.trim());
    } catch (err) {
      platformLog("error", "platform_key_decrypt_failed", { admin: req.user.sub });
      return res.status(503).json({ error: "Model listing is not configured" });
    }
    if (!apiKey || apiKey.length === 0) {
      return res.status(503).json({ error: "Model listing is not configured" });
    }

    const cached = getCachedModels();
    if (cached) {
      return res.json({ optgroups: cached });
    }

    try {
      const resp = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        }
      });
      if (!resp.ok) {
        platformLog("error", "model_list_failed", { admin: req.user.sub, status: resp.status });
        return res.status(502).json({ error: "Could not retrieve models" });
      }
      const data = await resp.json();
      const optgroups = groupModelsByFamily(data.data || []);
      setCachedModels(optgroups);
      res.json({ optgroups });
    } catch (err) {
      platformLog("error", "model_list_error", { admin: req.user.sub, error: err.message });
      res.status(502).json({ error: "Could not retrieve models" });
    } finally {
      apiKey = null;
    }
  });

  
  
  
  
  
  
  

  router.post("/execute", async (req, res) => {
    const { key, params: clientParams, confirmed } = req.body || {};

    if (!key || typeof key !== "string") {
      return res.status(400).json({ error: "Query key required" });
    }

    const queryDef = QUERY_REGISTRY[key];
    if (!queryDef) {
      return res.status(400).json({ error: "Unknown query key" });
    }

    
    if (queryDef.destructive && !confirmed) {
      return res.status(400).json({
        error: "Destructive query requires confirmation",
        requiresConfirmation: true
      });
    }

    
    const paramValues = [];
    for (const p of queryDef.params) {
      const val = clientParams?.[p.name];
      if (p.required && (!val || String(val).trim().length === 0)) {
        return res.status(400).json({ error: `Parameter '${p.label}' is required` });
      }
      paramValues.push(val || null);
    }

    platformLog("info", "platform_admin_query", {
      admin: req.user.sub,
      query: key,
      params: clientParams,
      destructive: queryDef.destructive
    });

    
    
    
    var RESTRICTED_COLUMNS = [
      { table: "prompt_vault", columns: ["value_enc"] }
    ];

    var sqlLower = queryDef.sql.toLowerCase();
    for (var restriction of RESTRICTED_COLUMNS) {
      if (!sqlLower.includes(restriction.table)) continue;
      for (var col of restriction.columns) {
        if (sqlLower.includes(col)) {
          platformLog("warn", "platform_admin_restricted_column", {
            admin: req.user.sub, query: key, table: restriction.table, column: col
          });
          return res.status(403).json({ error: "Query references a restricted column" });
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${resolveAdminRole()}`);

      const result = await client.query(queryDef.sql, paramValues);

      await client.query("COMMIT");

      platformLog("info", "platform_admin_query_result", {
        query: key,
        rowCount: result.rowCount,
        command: result.command
      });

      res.json({
        success: true,
        command: result.command,
        rowCount: result.rowCount,
        rows: queryDef.readOnly ? result.rows : undefined,
        fields: queryDef.readOnly ? result.fields?.map(f => f.name) : undefined
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      platformLog("error", "platform_admin_query_failed", {
        query: key, error: err.message
      });
      res.status(500).json({ error: "An internal error occurred" });
    } finally {
      client.release();
    }
  });

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  router.post("/content-genre", async (req, res) => {
    const { genre, template, description, confirmed } = req.body || {};

    
    platformLog("info", "content_genre_write_attempt", {
      admin: req.user.sub,
      genre: typeof genre === "string" ? genre : "(invalid)",
      templateLength: typeof template === "string" ? template.length : 0,
      confirmed: confirmed === true
    });

    try {
      const result = await storePromptGenre(
        "content_generator", genre, template, description, confirmed === true
      );
      res.json({ success: true, action: result.action, key: "content_generator", genre });
    } catch (err) {
      
      
      
      if (err.code === "CONFIRM_OVERWRITE") {
        return res.status(409).json({
          needsConfirm: true,
          message: "A template for genre '" + genre + "' already exists. Overwrite it?"
        });
      }
      
      
      const SAFE = {
        INVALID_GENRE:  "Genre must be lowercase, start with a letter, and be 2-32 characters.",
        EMPTY_TEMPLATE: "Template text is required.",
        EMPTY_DESCRIPTION: "Description is required."
      };
      if (err.code && SAFE[err.code]) {
        platformLog("warn", "content_genre_write_rejected", {
          admin: req.user.sub, genre, reason: err.code
        });
        return res.status(400).json({ error: SAFE[err.code], code: err.code });
      }
      platformLog("error", "content_genre_write_failed", {
        admin: req.user.sub, error: err.message
      });
      return res.status(500).json({ error: "An internal error occurred" });
    }
  });

  return router;
}
