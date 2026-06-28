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
import {
  getPostStats,
  getAllPosts,
  getPostsByStatus,
  getAgentState,
  setAgentState,
  getActivityLog,
  getPost,
  createPost,
  updatePost,
  updatePostStatus,
  deletePost,
  applyRefinedContent,
  logActivity
} from "../services/database.js";
import {
  approvePost,
  rejectPost,
  canPostNow,
  forceCycle,
  transitionStatus
} from "../services/scheduler.js";
import { generatePost, qualityCheck, refinePost } from "../services/content-generator.js";
import { getTopicBySlug } from "../tenant/topic-store.js";
import { createActionToken } from "../services/prompt-actions.js";
import { validateToken } from "../services/linkedin-api.js";
import { getArticleStats, getArticlesForTopic, pollAllFeeds, pollSingleFeed } from "../services/news-monitor.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import { isAuthEnabled } from "../auth/index.js";
import { getServerAddress } from "../services/server-address.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { isPlatformAdmin } from "../tenant/platform-db.js";
import { requirePermission } from "../tenant/permissions.js";
import { withTenant, currentClient as client } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import { isSafeUrl, isImageUrl } from "../services/security.js";
import { selectPrimarySource, sanitizePrimarySource } from "../services/source-provenance.js";
import { getAnthropicModel } from "../config/ai.js";
import { getPublishMode } from "../services/linkedin-publisher.js";
import { handleImageProxy } from "./image-proxy.js";
import { collectSourceLinks, mergeArticleImages } from "../services/post-image-hydrate.js";

const router = Router();








router.use((req, res, next) => {
  const reqPath = req.path;
  const reqMethod = req.method.toLowerCase();

  const matched = router.stack.some(layer => {
    if (!layer.route || !layer.route.path) return false;
    
    const routePath = layer.route.path;
    const isParam = routePath.includes(':');
    if (!isParam) {
      if (routePath !== reqPath) return false;
    } else {
      
      const pattern = new RegExp('^' + routePath.replace(/:[^/]+/g, '[^/]+') + '$');
      if (!pattern.test(reqPath)) return false;
    }
    
    if (layer.route.methods[reqMethod]) return true;
    if (reqMethod === 'options' || reqMethod === 'head') return true;
    return false;
  });

  if (!matched) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
});







const { requireAuth, optionalAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();







router.get("/api/status", optionalAuth, async (req, res) => {
  try {
    
    const serverAddress = getServerAddress().display;
    const authRequired = isAuthEnabled() && !req.devBypass;
    const maxPostsPer10Days = parseInt(process.env.MAX_POSTS_PER_10_DAYS || "4", 10);

    
    
    let stats = null, mode = null, paused = false, corroboration = "enabled";
    let researchStats = null;
    let cadence = null;
    let tokenStatus = { valid: false };
    let anthropicModel = null;
    let tenantRole = null;

    if (req.user && req.user.sub) {
      
      
      
      try {
        const { findTenantByAuthIdentity, findPendingInviteByEmail, claimInvite } = await import("../tenant/platform-db.js");
        const provider = req.user.authMethod === "bearer"
          ? (req.authProvider || "auth0")
          : "auth0";
        let tenant = await findTenantByAuthIdentity(provider, req.user.sub);

        
        
        
        
        
        if (!tenant && req.user.email) {
          try {
            const invite = await findPendingInviteByEmail(req.user.email);
            if (invite) {
              tenant = await claimInvite(invite.id, provider, req.user.sub);
              if (tenant) {
                platformLog("info", "invite_claimed_via_status", {
                  email: req.user.email,
                  tenantId: tenant.id,
                  tenantSlug: tenant.slug
                });
              }
            }
          } catch (claimErr) {
            platformLog("warn", "invite_claim_failed_in_status", {
              email: req.user.email,
              error: claimErr.message
            });
          }
        }

        if (tenant) {
          tenantRole = tenant.role || null;
          await withTenant(tenant.id, async () => {
            stats = await getPostStats();
            mode = await getAgentState("mode");
            const p = await getAgentState("paused");
            paused = p === "true";
            corroboration = (await getAgentState("corroboration")) || "enabled";
            try { researchStats = await getArticleStats(); } catch {  }
            
            
            
            
            cadence = await canPostNow();
            tokenStatus = await validateToken().catch(() => ({ valid: false, reason: "Check failed" }));
            anthropicModel = await getAnthropicModel();
          });
        }
      } catch {
        
      }
    }

    res.json({
      authRequired,
      devBypass: !!req.devBypass,
      user: req.user ? {
        name: req.user.name || null,
        email: req.user.email || null,
        sub: req.user.sub || null,
        role: tenantRole,
        isPlatformAdmin: isPlatformAdmin(req.user.sub),
      } : null,
      serverAddress,
      mode,
      paused,
      corroboration,
      cadence,
      stats,
      maxPostsPer10Days,
      researchStats,
      feedLimit: parseInt(process.env.DASHBOARD_FEED_LIMIT) || 8,
      linkedinConnected: tokenStatus.valid,
      linkedinProfile: tokenStatus.valid ? tokenStatus.name : null,
      anthropicModel,
      publishMode: getPublishMode()
    });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});







router.use(requireAuth);
router.use(resolveTenant);







function parsePostId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}






function buildRefineSourceContext(ctx) {
  if (ctx && ctx.researchSummary && Array.isArray(ctx.researchSummary.sourceList) && ctx.researchSummary.sourceList.length) {
    return ctx.researchSummary.sourceList
      .map(s => `- ${s.name}${s.tier ? ` (${s.tier})` : ""}`)
      .join("\n");
  }
  if (ctx && Array.isArray(ctx.sourcesUsed) && ctx.sourcesUsed.length) {
    return ctx.sourcesUsed.map(n => `- ${n}`).join("\n");
  }
  return "(no source list recorded)";
}










async function hydrateArticleImages(posts) {
  const targets = posts.filter(p => p.status === "draft" || p.status === "pending_approval");
  if (targets.length === 0) return;
  const perPostLinks = new Map();
  const allLinks = new Set();
  for (const p of targets) {
    let ctx = p.news_context;
    if (typeof ctx === "string") { try { ctx = JSON.parse(ctx); } catch { ctx = null; } }
    const links = collectSourceLinks(ctx);
    perPostLinks.set(p.id, { ctx, links });
    for (const l of links) allLinks.add(l);
  }
  if (allLinks.size === 0) {
    for (const p of targets) {
      const { ctx } = perPostLinks.get(p.id);
      p.articleImages = mergeArticleImages(ctx && ctx.articleImages, []);
    }
    return;
  }
  const c = client();
  const r = await c.query(
    `SELECT DISTINCT ON (a.link) a.link, a.image_url, a.title, f.name AS feed_name
     FROM articles_v2 a
     LEFT JOIN feed_articles fa ON fa.article_id = a.id
     LEFT JOIN feeds_v2 f ON f.id = fa.feed_id
     WHERE a.link = ANY($1) AND a.image_url IS NOT NULL
     ORDER BY a.link, f.name`,
    [Array.from(allLinks)]
  );
  const byLink = new Map();
  for (const row of r.rows) {
    byLink.set(row.link, { imageUrl: row.image_url, title: row.title, feedName: row.feed_name, link: row.link });
  }
  for (const p of targets) {
    const { ctx, links } = perPostLinks.get(p.id);
    const derived = links.map(l => byLink.get(l)).filter(Boolean);
    p.articleImages = mergeArticleImages(ctx && ctx.articleImages, derived);
  }
}

router.get("/api/posts", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "50");
    const status = req.query.status;
    const posts = await withTenant(req.tenant.id, async () => {
      const rows = status ? await getPostsByStatus(status) : await getAllPosts(limit);
      await hydrateArticleImages(rows);
      return rows;
    });
    res.json({ posts });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.get("/api/posts/:id", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const id = parsePostId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid post id" });
    const post = await withTenant(req.tenant.id, async () => {
      const row = await getPost(id);
      if (row) await hydrateArticleImages([row]);
      return row;
    });
    if (!post) return res.status(404).json({ error: "Post not found" });
    res.json({ post });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});













router.patch("/api/posts/:id", requirePermission("edit_post"), async (req, res) => {
  try {
    const id = parsePostId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid post id" });
    const { title, content, hashtags, image_url } = req.body || {};
    const fields = {};
    if (title !== undefined)   fields.title = title;
    if (content !== undefined) fields.content = content;
    if (hashtags !== undefined) fields.hashtags = hashtags;
    if (image_url !== undefined) {
      
      if (image_url !== null && typeof image_url === "string" && image_url.length > 0) {
        if (!isImageUrl(image_url)) {
          return res.status(400).json({ error: "URL must be a valid HTTPS image (JPEG, PNG, GIF, or WebP)" });
        }
        fields.image_url = image_url;
      } else {
        fields.image_url = null;
      }
    }

    const updated = await withTenant(req.tenant.id, async () => {
      const row = await updatePost(id, fields);
      await logActivity("info", "post_edited", {
        postId: row.id,
        fieldsChanged: Object.keys(fields)
      }, req.user?.sub || null);
      return row;
    });

    res.json({ success: true, post: updated });
  } catch (err) {
    if (err.code === "NOT_FOUND")    return res.status(404).json({ error: err.message });
    if (err.code === "NOT_EDITABLE") return res.status(409).json({ error: err.message });
    if (err.code === "NO_FIELDS")    return res.status(400).json({ error: err.message });
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});







router.delete("/api/posts/:id", requirePermission("edit_post"), async (req, res) => {
  try {
    const id = parsePostId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid post id" });
    const deleted = await withTenant(req.tenant.id, async () => {
      const ok = await deletePost(id);
      if (ok) await logActivity("info", "post_discarded", { postId: id }, req.user?.sub || null);
      return ok;
    });
    if (!deleted) return res.status(404).json({ error: "Draft not found" });
    res.json({ success: true, deleted: true });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});












router.post("/api/posts/:id/rewrite", requirePermission("edit_post"), async (req, res) => {
  try {
    const id = parsePostId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid post id" });

    
    
    const actionToken = createActionToken("generate-content", req.user.sub);

    const updated = await withTenant(req.tenant.id, async () => {
      const post = await getPost(id);
      if (!post) { const e = new Error("Post not found"); e.code = "NOT_FOUND"; throw e; }
      if (post.status !== "draft" && post.status !== "pending_approval") {
        const e = new Error(`Post ${id} cannot be refined (status: ${post.status}).`);
        e.code = "NOT_REFINABLE";
        throw e;
      }

      const topic = await getTopicBySlug(post.topic_id);
      const ctx = (post.news_context && typeof post.news_context === "object") ? post.news_context : {};
      const angle = typeof ctx.angle === "string" ? ctx.angle : "";

      const refined = await refinePost({
        topicName: topic ? topic.name : post.topic_id,
        angle,
        genre: post.genre || "default",
        title: post.title,
        content: post.content,
        hashtags: post.hashtags,
        sourceContext: buildRefineSourceContext(ctx)
      }, req.user?.sub || null, actionToken);

      const row = await applyRefinedContent(id, {
        title: refined.title,
        content: refined.content,
        hashtags: refined.hashtags
      });
      await logActivity("info", "post_refined", { postId: id, fromStatus: post.status, cycleId: refined.cycleId }, req.user?.sub || null);
      return row;
    });

    res.json({ success: true, post: updated });
  } catch (err) {
    if (err.code === "NOT_FOUND")     return res.status(404).json({ error: err.message });
    if (err.code === "NOT_REFINABLE") return res.status(409).json({ error: err.message });
    if (err.code === "REFINE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "Rewrite isn't configured yet — add the 'refine' genre to the content_generator prompt." });
    }
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});







router.post("/api/posts/:id/approve", requirePermission("approve_reject_post"), async (req, res) => {
  try {
    const id = parsePostId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid post id" });
    const result = await withTenant(req.tenant.id, async () => {
      return approvePost(id, req.user?.sub || null);
    });
    res.json({ success: true, result });
  } catch (err) {
    if (err.code === "EMPTY_CONTENT") return res.status(400).json({ error: err.message });
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/posts/:id/reject", requirePermission("approve_reject_post"), async (req, res) => {
  try {
    const id = parsePostId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid post id" });
    await withTenant(req.tenant.id, async () => {
      return rejectPost(id, req.body.reason || "", req.user?.sub || null);
    });
    res.json({ success: true });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});










router.post("/api/posts/:id/status", requirePermission("approve_reject_post"), async (req, res) => {
  try {
    const id = parsePostId(req.params.id);
    if (id === null) return res.status(400).json({ error: "Invalid post id" });

    const { to, scheduledFor, title, content, hashtags, imageUrl } = req.body;
    if (typeof to !== "string" || !to) {
      return res.status(400).json({ error: "Missing target status 'to'" });
    }
    if (imageUrl !== undefined && imageUrl !== null && imageUrl !== "" && !isImageUrl(imageUrl)) {
      return res.status(400).json({ error: "Image URL must be a valid HTTPS image" });
    }

    const result = await withTenant(req.tenant.id, async () => {
      return transitionStatus(id, to, { scheduledFor, title, content, hashtags, imageUrl }, req.user?.sub || null);
    });
    res.json({ success: true, status: result.status, scheduledFor: result.scheduledForIso });
  } catch (err) {
    if (err.code === "VALIDATION")         return res.status(400).json({ error: err.message });
    if (err.code === "INVALID_TRANSITION") return res.status(409).json({ error: err.message });
    if (err.code === "NOT_FOUND")          return res.status(404).json({ error: "Post not found" });
    if (err.code === "SPACING_CONFLICT")   return res.status(409).json({ error: err.message });
    if (err.code === "EMPTY_CONTENT")      return res.status(400).json({ error: err.message });
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});



router.post("/api/mode", requirePermission("change_mode"), async (req, res) => {
  try {
    const { mode } = req.body;
    if (!["auto", "manual"].includes(mode)) {
      return res.status(400).json({ error: "Mode must be 'auto' or 'manual'" });
    }
    await withTenant(req.tenant.id, async () => {
      await setAgentState("mode", mode);
    });
    res.json({ mode });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/pause", requirePermission("change_mode"), async (req, res) => {
  try {
    const { paused } = req.body;
    await withTenant(req.tenant.id, async () => {
      await setAgentState("paused", String(!!paused));
    });
    res.json({ paused: !!paused });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/corroboration", requirePermission("toggle_corroboration"), async (req, res) => {
  try {
    const { enabled } = req.body;
    const value = enabled === false ? "disabled" : "enabled";
    await withTenant(req.tenant.id, async () => {
      await setAgentState("corroboration", value);
      await logActivity("info", "corroboration_toggled", { corroboration: value }, req.user?.sub || null);
    });
    res.json({ corroboration: value });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});



router.post("/api/generate-preview", requirePermission("preview_post"), async (req, res) => {
  try {
    const topicId = req.body.topicId || null;
    
    
    
    const angle = typeof req.body.angle === "string" ? req.body.angle : null;
    const actionToken = createActionToken("generate-content", req.user.sub);
    const result = await withTenant(req.tenant.id, async () => {
      const g = await generatePost(topicId, null, actionToken, angle);
      if (g.blocked) return { generated: g, quality: null, postId: null };

      
      
      
      
      const preferUrl = (Array.isArray(g.articleImages) && g.articleImages[0] && g.articleImages[0].link) || null;
      const primarySource = selectPrimarySource((g.researchSummary && g.researchSummary.sourceList) || [], { preferUrl });
      if (!primarySource) {
        await logActivity("info", "post_blocked_no_primary_source", { cycleId: g.cycleId, topicId: g.topicId }, req.user?.sub || null);
        return {
          generated: { blocked: true, reason: "No attributable primary source could be resolved", topicId: g.topicId, angle: g.angle },
          quality: null, postId: null
        };
      }

      
      
      platformLog("info", "primary_source_selected", {
        cycleId: g.cycleId, topicId: g.topicId,
        domain: primarySource.domain, name: primarySource.name, url: primarySource.url,
        imageArticlePreferred: !!preferUrl
      });

      const q = await qualityCheck(g.content, g.researchSummary, null, actionToken);

      
      
      const storedContext = {
        angle: g.angle || "",
        sourcesUsed: g.sourcesUsed || [],
        researchSummary: g.researchSummary || null,
        qualityScores: q?.scores,
        qualityOverall: q?.overall,
        qualityPass: q?.pass,
        factualFlags: q?.factual_flags,
        primarySource,
        articleImages: Array.isArray(g.articleImages) ? g.articleImages.slice(0, 20) : []
      };

      const postId = await createPost({
        topicId: g.topicId,
        title: g.title,
        content: g.content,
        hashtags: g.hashtags || [],
        newsContext: storedContext,
        scheduledFor: null,
        imageUrl: null
      });

      await logActivity("info", "preview_auto_saved", {
        postId, title: g.title, topicId: g.topicId
      }, req.user?.sub || null);

      return { generated: g, quality: q, postId };
    });

    if (result.generated.blocked) {
      return res.json({
        blocked: true, reason: result.generated.reason,
        topicId: result.generated.topicId, angle: result.generated.angle
      });
    }
    res.json({ post: result.generated, quality: result.quality, postId: result.postId });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/save-preview", requirePermission("edit_post"), async (req, res) => {
  try {
    let { postId, topicId, title, content, hashtags, angle, sourcesUsed, researchSummary, quality, imageUrl, articleImages, primarySource } = req.body;

    
    if (postId !== undefined && postId !== null) {
      postId = Number(postId);
      if (!Number.isInteger(postId) || postId < 1) {
        return res.status(400).json({ error: "Invalid postId" });
      }
    }

    
    let validatedImageUrl = null;
    if (imageUrl && typeof imageUrl === "string" && imageUrl.length > 0) {
      if (!isImageUrl(imageUrl)) {
        return res.status(400).json({ error: "Image URL must be a valid HTTPS image" });
      }
      validatedImageUrl = imageUrl;
    }

    const savedId = await withTenant(req.tenant.id, async () => {
      
      if (postId) {
        
        if (title || content || hashtags) {
          const c = client();
          await c.query(
            `UPDATE posts SET
               title = COALESCE($1, title),
               content = COALESCE($2, content),
               hashtags = COALESCE($3::jsonb, hashtags),
               image_url = $4
             WHERE id = $5 AND tenant_id = current_tenant_id() AND status = 'draft'`,
            [title || null, content || null, hashtags ? JSON.stringify(hashtags) : null, validatedImageUrl, postId]
          );
        }
        const chk = await client().query(
          `SELECT content FROM posts WHERE id = $1 AND tenant_id = current_tenant_id()`,
          [postId]
        );
        if (!(chk.rows[0]?.content || "").trim()) {
          const err = new Error("Add some content before queuing this post.");
          err.code = "EMPTY_CONTENT";
          throw err;
        }
        await updatePostStatus(postId, "pending_approval");
        await logActivity("info", "draft_promoted_to_queue", { postId, title }, req.user?.sub || null);
        return postId;
      }

      
      if (!topicId || !title || !content) {
        throw new Error("Missing required fields: topicId, title, content");
      }

      const storedContext = {
        angle: angle || "",
        sourcesUsed: sourcesUsed || [],
        researchSummary: researchSummary || null,
        qualityScores: quality?.scores,
        qualityOverall: quality?.overall,
        qualityPass: quality?.pass,
        factualFlags: quality?.factual_flags,
        // Zero Trust: primarySource arrives in req.body — revalidate it
        // (canonical url, re-derived domain) before persisting. A value
        // that fails validation is stored as null, never raw.
        primarySource: sanitizePrimarySource(primarySource),
        articleImages: Array.isArray(articleImages) ? articleImages.slice(0, 20) : []
      };

      const id = await createPost({
        topicId,
        title,
        content,
        hashtags: hashtags || [],
        newsContext: storedContext,
        scheduledFor: null,
        imageUrl: validatedImageUrl
      });
      await updatePostStatus(id, "pending_approval");
      await logActivity("info", "preview_saved_to_queue", { postId: id, title }, req.user?.sub || null);
      return id;
    });

    res.json({ success: true, postId: savedId });
  } catch (err) {
    if (err.code === "EMPTY_CONTENT") return res.status(400).json({ error: err.message });
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/force-cycle", requirePermission("force_cycle"), async (req, res) => {
  try {
    const topicId = req.body.topicId || null;
    await withTenant(req.tenant.id, async () => {
      return forceCycle(topicId, req.user?.sub || null);
    });
    res.json({ success: true, message: "Scheduler cycle executed", topicId: topicId || "auto" });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});



router.get("/api/research/stats", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const stats = await withTenant(req.tenant.id, async () => getArticleStats());
    res.json(stats);
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.get("/api/research/articles", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const topicId = req.query.topic;
    const maxAge = parseInt(req.query.maxAge || "14");
    const limit = parseInt(req.query.limit || "20");

    if (!topicId) {
      return res.status(400).json({ error: "topic query parameter required" });
    }

    const articles = await withTenant(req.tenant.id, async () => {
      return getArticlesForTopic(topicId, maxAge, limit);
    });
    res.json({ articles });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/research/poll", requirePermission("refresh_feeds"), async (req, res) => {
  try {
    const newArticles = await withTenant(req.tenant.id, async () => pollAllFeeds());
    res.json({ success: true, newArticles });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

router.post("/api/research/single", requirePermission("refresh_feeds"), async (req, res) => {
  try {
    const { feedId } = req.body;
    if (!feedId) {
      return res.status(400).json({ error: "feedId is required" });
    }
    const result = await withTenant(req.tenant.id, async () => pollSingleFeed(feedId));
    res.json(result);
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});






router.get("/api/image-proxy", requirePermission("view_dashboard"), handleImageProxy);



router.get("/api/logs", requirePermission("view_dashboard"), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || "100");
    const logs = await withTenant(req.tenant.id, async () => getActivityLog(limit));
    res.json({ logs });
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});



router.get("/api/linkedin/status", requirePermission("view_dashboard"), async (req, res) => {
  try {
    
    
    const status = await withTenant(req.tenant.id, async () => {
      return validateToken().catch(() => ({ valid: false }));
    });
    res.json(status);
  } catch (err) {
    platformLog("error", "api_error", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

export default router;
