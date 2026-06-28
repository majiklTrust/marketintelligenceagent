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

import { currentClient, currentTenantId } from "../db/with-tenant.js";
import { canTransition, isEditable } from "./post-status.js";






function client() {
  const c = currentClient();
  if (!c) {
    throw new Error("database operation requires tenant context (call inside withTenant)");
  }
  return c;
}









function validateScheduledFor(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "string") {
    throw new TypeError("scheduledFor must be a Date, timezone-aware string, or null");
  }
  const tzAware = /Z$|[+-]\d{2}:?\d{2}$/.test(value);
  if (!tzAware) {
    throw new TypeError(
      "scheduledFor string must be timezone-aware (ISO 8601 with Z or offset)"
    );
  }
  return value;
}




async function resolveTopicIdBySlug(c, slug) {
  const r = await c.query(
    "SELECT id FROM topics WHERE slug = $1",
    [slug]
  );
  if (r.rows.length === 0) {
    throw new Error(`topic not found for slug: ${slug}`);
  }
  return r.rows[0].id;
}












export function initDatabase() {
  throw new Error(
    "initDatabase() is legacy — Postgres schema is managed externally " +
    "via data/pgsql/ DDL files. Remove this call from the app startup path."
  );

  
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id      TEXT NOT NULL,
      title         TEXT NOT NULL,
      content       TEXT NOT NULL,
      hashtags      TEXT,           -- JSON array
      status        TEXT NOT NULL DEFAULT 'draft',
        -- draft | pending_approval | approved | posted | rejected | failed
      linkedin_id   TEXT,           -- LinkedIn post URN after posting
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      scheduled_for DATETIME,
      posted_at     DATETIME,
      error_message TEXT,
      news_context  TEXT            -- source context used for generation
    );

    CREATE TABLE IF NOT EXISTS agent_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP,
      level      TEXT NOT NULL,
      action     TEXT NOT NULL,
      details    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
    CREATE INDEX IF NOT EXISTS idx_posts_posted_at ON posts(posted_at);
    CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_for);
  `);

  
  const upsert = db.prepare(`
    INSERT OR IGNORE INTO agent_state (key, value) VALUES (?, ?)
  `);
  upsert.run("mode", process.env.AGENT_MODE || "manual");
  upsert.run("last_topic_id", "");
  upsert.run("paused", "false");

  return db;
}



export async function createPost({ topicId, title, content, hashtags, newsContext, scheduledFor, imageUrl, genre }) {
  const c = client();
  const scheduled = validateScheduledFor(scheduledFor);
  const topicIntId = topicId ? await resolveTopicIdBySlug(c, topicId) : null;

  
  
  
  let nc = null;
  if (newsContext != null) {
    nc = typeof newsContext === "string" ? { raw: newsContext } : newsContext;
  }

  const r = await c.query(
    `INSERT INTO posts (tenant_id, topic_id, title, content, hashtags, news_context, scheduled_for, image_url, status, genre)
     VALUES (current_tenant_id(), $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, 'draft', $8)
     RETURNING id`,
    [topicIntId, title, content, JSON.stringify(hashtags || []), nc == null ? null : JSON.stringify(nc), scheduled, imageUrl || null, genre || 'default']
  );
  return r.rows[0].id;
}





export async function getPost(id) {
  const c = client();
  const r = await c.query(
    `SELECT p.id, p.tenant_id, t.slug AS topic_id, p.title, p.content,
            p.hashtags, p.status, p.linkedin_id, p.created_at,
            p.scheduled_for, p.posted_at, p.error_message, p.news_context,
            p.image_url, p.genre
     FROM posts p
     LEFT JOIN topics t ON t.id = p.topic_id
     WHERE p.id = $1`,
    [id]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  if (!Array.isArray(row.hashtags)) row.hashtags = row.hashtags || [];
  return row;
}










export async function updatePost(id, fields) {
  const c = client();

  
  
  
  const guard = await c.query(
    `SELECT id, status FROM posts WHERE id = $1 FOR UPDATE`,
    [id]
  );
  if (guard.rows.length === 0) {
    const err = new Error(`Post ${id} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  if (!isEditable(guard.rows[0].status)) {
    const err = new Error(
      `Post ${id} is not editable (status: ${guard.rows[0].status}).`
    );
    err.code = "NOT_EDITABLE";
    throw err;
  }

  
  
  const sets = [];
  const params = [];
  let i = 1;

  if (typeof fields.title === "string") {
    sets.push(`title = $${i++}`);
    params.push(fields.title);
  }
  if (typeof fields.content === "string") {
    sets.push(`content = $${i++}`);
    params.push(fields.content);
  }
  if (Array.isArray(fields.hashtags)) {
    sets.push(`hashtags = $${i++}::jsonb`);
    params.push(JSON.stringify(fields.hashtags));
  }
  if (fields.image_url !== undefined) {
    
    sets.push(`image_url = $${i++}`);
    params.push(fields.image_url || null);
  }

  if (sets.length === 0) {
    const err = new Error("No editable fields supplied");
    err.code = "NO_FIELDS";
    throw err;
  }

  params.push(id);
  const r = await c.query(
    `UPDATE posts SET ${sets.join(", ")} WHERE id = $${i}
     RETURNING id, title, content, hashtags, status, image_url`,
    params
  );

  const row = r.rows[0];
  if (!Array.isArray(row.hashtags)) row.hashtags = row.hashtags || [];
  return row;
}

export async function deletePost(id) {
  
  
  
  
  const c = client();
  const result = await c.query(
    `DELETE FROM posts WHERE id = $1 AND status = 'draft' RETURNING id`,
    [id]
  );
  return result.rowCount > 0;
}










export async function applyRefinedContent(id, fields) {
  const c = client();

  const guard = await c.query(
    `SELECT id, status FROM posts WHERE id = $1 FOR UPDATE`,
    [id]
  );
  if (guard.rows.length === 0) {
    const err = new Error(`Post ${id} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const status = guard.rows[0].status;
  if (status !== "draft" && status !== "pending_approval") {
    const err = new Error(
      `Post ${id} cannot be refined (status: ${status}). Only draft or pending_approval posts can be refined.`
    );
    err.code = "NOT_REFINABLE";
    throw err;
  }

  const r = await c.query(
    `UPDATE posts
        SET title = $1, content = $2, hashtags = $3::jsonb, status = 'draft'::post_status
      WHERE id = $4
      RETURNING id, title, content, hashtags, status`,
    [fields.title, fields.content, JSON.stringify(fields.hashtags || []), id]
  );
  const row = r.rows[0];
  if (!Array.isArray(row.hashtags)) row.hashtags = row.hashtags || [];
  return row;
}

export async function updatePostStatus(id, status, extra = {}) {
  const c = client();
  const sets = ["status = $1::post_status"];
  const params = [status];
  let i = 2;

  if (extra.linkedinId) {
    sets.push(`linkedin_id = $${i++}`);
    params.push(extra.linkedinId);
  }
  if (extra.postedAt) {
    sets.push(`posted_at = $${i++}`);
    params.push(extra.postedAt);
  }
  if (extra.errorMessage) {
    sets.push(`error_message = $${i++}`);
    params.push(extra.errorMessage);
  }

  params.push(id);
  await c.query(
    `UPDATE posts SET ${sets.join(", ")} WHERE id = $${i}`,
    params
  );
}










export async function transitionPostStatus({ id, to, scheduledFor, title, content, hashtags, imageUrl, spacingMinutes = 0 }) {
  const c = client();

  
  
  
  const guard = await c.query(
    `SELECT status, content FROM posts WHERE id = $1 AND tenant_id = current_tenant_id() FOR UPDATE`,
    [id]
  );
  if (guard.rows.length === 0) {
    const err = new Error(`Post ${id} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const from = guard.rows[0].status;
  if (!canTransition(from, to)) {
    const err = new Error(`Cannot move post from '${from}' to '${to}'`);
    err.code = "INVALID_TRANSITION";
    throw err;
  }

  
  
  
  const effectiveContent = typeof content === "string" ? content : guard.rows[0].content;
  if ((to === "scheduled" || to === "pending_approval") && !(effectiveContent || "").trim()) {
    const err = new Error("Add some content before scheduling or queuing this post.");
    err.code = "EMPTY_CONTENT";
    throw err;
  }

  if (to === "scheduled" && spacingMinutes > 0) {
    const conflict = await c.query(
      `SELECT 1 FROM posts
        WHERE tenant_id = current_tenant_id()
          AND status = 'scheduled'
          AND id <> $1
          AND scheduled_for BETWEEN ($2::timestamptz - make_interval(mins => $3))
                                AND ($2::timestamptz + make_interval(mins => $3))
        LIMIT 1`,
      [id, scheduledFor, spacingMinutes]
    );
    if (conflict.rows.length > 0) {
      const err = new Error(`Another post is scheduled within ${spacingMinutes} minute(s) of that time`);
      err.code = "SPACING_CONFLICT";
      throw err;
    }
  }

  
  
  
  {
    const sets = [];
    const params = [];
    let i = 1;
    if (typeof title === "string")   { sets.push(`title = $${i++}`);            params.push(title); }
    if (typeof content === "string") { sets.push(`content = $${i++}`);          params.push(content); }
    if (Array.isArray(hashtags))     { sets.push(`hashtags = $${i++}::jsonb`);  params.push(JSON.stringify(hashtags)); }
    if (imageUrl !== undefined)      { sets.push(`image_url = $${i++}`);        params.push((typeof imageUrl === "string" && imageUrl.length) ? imageUrl : null); }
    if (sets.length) {
      params.push(id);
      await c.query(
        `UPDATE posts SET ${sets.join(", ")} WHERE id = $${i} AND tenant_id = current_tenant_id()`,
        params
      );
    }
  }

  
  
  
  if (to === "scheduled") {
    await c.query(
      `UPDATE posts SET status = 'scheduled', scheduled_for = $1
        WHERE id = $2 AND tenant_id = current_tenant_id()`,
      [scheduledFor, id]
    );
  } else {
    await c.query(
      `UPDATE posts SET status = $1::post_status, scheduled_for = NULL
        WHERE id = $2 AND tenant_id = current_tenant_id()`,
      [to, id]
    );
  }
}



export async function getPostsByStatus(status) {
  const c = client();
  const r = await c.query(
    `SELECT p.id, p.tenant_id, t.slug AS topic_id, p.title, p.content,
            p.hashtags, p.status, p.linkedin_id, p.created_at,
            p.scheduled_for, p.posted_at, p.error_message, p.news_context,
            p.image_url
     FROM posts p
     LEFT JOIN topics t ON t.id = p.topic_id
     WHERE p.status = $1::post_status
     ORDER BY p.created_at DESC`,
    [status]
  );
  return r.rows.map(normalizeHashtags);
}

export async function getRecentPosts(days = 10) {
  const c = client();
  const r = await c.query(
    `SELECT p.id, p.tenant_id, t.slug AS topic_id, p.title, p.content,
            p.hashtags, p.status, p.linkedin_id, p.created_at,
            p.scheduled_for, p.posted_at, p.error_message, p.news_context,
            p.image_url
     FROM posts p
     LEFT JOIN topics t ON t.id = p.topic_id
     WHERE p.posted_at >= now() - ($1 || ' days')::interval
       AND p.status = 'posted'::post_status
     ORDER BY p.posted_at DESC`,
    [String(days)]
  );
  return r.rows.map(normalizeHashtags);
}

export async function getAllPosts(limit = 50) {
  const c = client();
  const r = await c.query(
    `SELECT p.id, p.tenant_id, t.slug AS topic_id, p.title, p.content,
            p.hashtags, p.status, p.linkedin_id, p.created_at,
            p.scheduled_for, p.posted_at, p.error_message, p.news_context,
            p.image_url
     FROM posts p
     LEFT JOIN topics t ON t.id = p.topic_id
     ORDER BY p.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows.map(normalizeHashtags);
}





export async function getLastPostedTopic() {
  const c = client();
  const r = await c.query(
    `SELECT t.slug
     FROM posts p
     JOIN topics t ON t.id = p.topic_id
     WHERE p.status = 'posted'::post_status
     ORDER BY p.posted_at DESC
     LIMIT 1`
  );
  return r.rows.length === 0 ? null : r.rows[0].slug;
}

function normalizeHashtags(row) {
  if (!Array.isArray(row.hashtags)) row.hashtags = row.hashtags || [];
  return row;
}



export async function getAgentState(key) {
  const c = client();
  const r = await c.query(
    "SELECT value FROM agent_state WHERE key = $1",
    [key]
  );
  return r.rows.length === 0 ? undefined : r.rows[0].value;
}




export async function setAgentState(key, value) {
  const c = client();
  await c.query(
    `INSERT INTO agent_state (tenant_id, key, value)
     VALUES (current_tenant_id(), $1, $2)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, String(value)]
  );
}







export async function logActivity(level, action, details = null, userSub = null) {
  const c = client();
  let jsonb = null;
  if (details != null) {
    jsonb = typeof details === "string"
      ? JSON.stringify({ raw: details })
      : JSON.stringify(details);
  }
  await c.query(
    `INSERT INTO activity_log (tenant_id, level, action, details, user_sub)
     VALUES (current_tenant_id(), $1::log_level, $2, $3::jsonb, $4)`,
    [level, action, jsonb, userSub]
  );
}

export async function getActivityLog(limit = 100) {
  const c = client();
  const r = await c.query(
    `SELECT id, tenant_id, timestamp, level, action, details
     FROM activity_log
     ORDER BY timestamp DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows;
}



export async function getPostStats() {
  const c = client();

  const total = await c.query(
    "SELECT COUNT(*)::int AS count FROM posts WHERE status = 'posted'::post_status"
  );
  const byTopic = await c.query(
    `SELECT t.slug AS topic_id, COUNT(*)::int AS count
     FROM posts p
     JOIN topics t ON t.id = p.topic_id
     WHERE p.status = 'posted'::post_status
     GROUP BY t.slug`
  );
  const pending = await c.query(
    "SELECT COUNT(*)::int AS count FROM posts WHERE status = 'pending_approval'::post_status"
  );
  const last10Days = await getRecentPosts(10);

  return {
    totalPosted: total.rows[0].count,
    byTopic: byTopic.rows,
    postsLast10Days: last10Days.length,
    pendingApproval: pending.rows[0].count,
    recentPosts: last10Days
  };
}
