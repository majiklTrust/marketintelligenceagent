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
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission } from "../tenant/permissions.js";
import { withTenant } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import { generatePost, qualityCheck } from "../services/content-generator.js";
import { createActionToken } from "../services/prompt-actions.js";
import { genreExists, listGenresForKey, templateUsesMetricBlock } from "../services/prompt-vault.js";
import { getTopicBySlug } from "../tenant/topic-store.js";
import { getMetricsForTopic } from "../services/metric-store.js";
import { createPost, logActivity, getPost } from "../services/database.js";
import { selectPrimarySource } from "../services/source-provenance.js";

const router = Router();

const { requireAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();


router.use(requireAuth);
router.use(resolveTenant);








router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});


const GENRE_RE = /^[a-z][a-z0-9_]{1,31}$/;








const INTERNAL_REFINE_GENRE = "refine";





router.post("/generate", requirePermission("preview_post"), async (req, res) => {
  try {
    const topicId = req.body.topicId || null;
    const angle = typeof req.body.angle === "string" ? req.body.angle : null;
    const rawGenre = typeof req.body.genre === "string" ? req.body.genre.trim() : "";
    const genre = rawGenre || "default";

    
    
    
    
    if (!GENRE_RE.test(genre)) {
      return res.status(400).json({ error: "Invalid genre format." });
    }
    if (genre !== "default") {
      const exists = await genreExists("content_generator", genre);
      if (!exists) {
        return res.status(400).json({ error: "Unknown genre: " + genre });
      }
    }

    platformLog("info", "compose_generate_requested", {
      user: req.user.sub, topicId, genre, hasAngle: !!angle
    });

    const actionToken = createActionToken("generate-content", req.user.sub);

    
    
    
    
    
    const result = await withTenant(req.tenant.id, async () => {
      const g = await generatePost(topicId, null, actionToken, angle, genre);
      if (g.blocked) return { generated: g, quality: null, postId: null };

      const preferUrl = (Array.isArray(g.articleImages) && g.articleImages[0] && g.articleImages[0].link) || null;
      const primarySource = selectPrimarySource((g.researchSummary && g.researchSummary.sourceList) || [], { preferUrl });
      if (!primarySource) {
        await logActivity("info", "compose_blocked_no_primary_source", { cycleId: g.cycleId, topicId: g.topicId }, req.user?.sub || null);
        return {
          generated: { blocked: true, reason: "No attributable primary source could be resolved", topicId: g.topicId, angle: g.angle, fidelity: g.fidelity || null },
          quality: null, postId: null
        };
      }

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
        imageUrl: null,
        genre
      });

      await logActivity("info", "compose_auto_saved", { postId, title: g.title, topicId: g.topicId, genre }, req.user?.sub || null);

      return { generated: g, quality: q, postId };
    });

    
    
    if (result.generated.blocked) {
      return res.json({
        blocked: true, reason: result.generated.reason,
        topicId: result.generated.topicId, angle: result.generated.angle, genre,
        fidelity: result.generated.fidelity || null
      });
    }

    res.json({
      post: result.generated, quality: result.quality, postId: result.postId,
      genre, fidelity: result.generated.fidelity || null
    });
  } catch (err) {
    platformLog("error", "compose_generate_failed", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});






router.post("/blank", requirePermission("preview_post"), async (req, res) => {
  try {
    const post = await withTenant(req.tenant.id, async () => {
      const id = await createPost({
        topicId: null,
        title: "",
        content: "",
        hashtags: [],
        newsContext: null,
        scheduledFor: null,
        imageUrl: null,
        genre: "manual"
      });
      await logActivity("info", "blank_draft_created", { postId: id }, req.user?.sub || null);
      return getPost(id);
    });
    res.json({ post });
  } catch (err) {
    console.error("[compose/blank] failed:", err.message);
    res.status(500).json({ error: "Could not create a blank draft." });
  }
});






router.get("/topic-metrics", requirePermission("preview_post"), async (req, res) => {
  try {
    const slug = typeof req.query.topicId === "string" ? req.query.topicId.trim() : "";
    if (!slug) {
      return res.status(400).json({ error: "topicId is required" });
    }

    const landscape = await withTenant(req.tenant.id, async () => {
      const topic = await getTopicBySlug(slug);
      if (!topic) return null;
      const groups = await getMetricsForTopic(topic.id);
      return {
        topicId: topic.slug,
        groupCount: groups.length,
        groups: groups.map(g => ({
          groupSlug: g.groupSlug,
          groupLabel: g.groupLabel,
          metricCount: Array.isArray(g.metrics) ? g.metrics.length : 0
        }))
      };
    });

    if (!landscape) {
      return res.status(404).json({ error: "Topic not found" });
    }
    res.json({ landscape });
  } catch (err) {
    platformLog("error", "compose_topic_metrics_failed", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});









router.get("/genres", requirePermission("preview_post"), async (req, res) => {
  try {
    const slug = typeof req.query.topicId === "string" ? req.query.topicId.trim() : "";

    // Genre catalog is platform-level (not tenant-scoped) — read it
    // outside withTenant. Metadata + flag only, no ciphertext.
    //
    // Two exclusions, both server-side so the picker only ever receives
    // what it should display:
    //   1. the internal refine genre — never a user-facing style (the
    //      platform-admin genre list still shows it for editing); and
    //   2. metric-bearing genres (metric_bearing = true, e.g. 'metricvalue')
    //      — these drive the metric pipeline and are out of scope for the
    //      Create flow, which offers metric-free content styles only.
    // A metric-bearing genre stays valid on the backend (genreExists in
    // /generate accepts it); it is simply not offered here.
    const genres = (await listGenresForKey("content_generator"))
      .filter((g) => g.genre !== INTERNAL_REFINE_GENRE && g.metricBearing !== true);

    let topicHasMetrics = null;
    let resolvedSlug = null;
    if (slug) {
      const probe = await withTenant(req.tenant.id, async () => {
        const topic = await getTopicBySlug(slug);
        if (!topic) return null;
        const groups = await getMetricsForTopic(topic.id);
        return { slug: topic.slug, hasMetrics: groups.length > 0 };
      });
      if (!probe) {
        return res.status(404).json({ error: "Topic not found" });
      }
      topicHasMetrics = probe.hasMetrics;
      resolvedSlug = probe.slug;
    }

    const menu = genres.map((g) => {
      const blockedByMetrics = g.metricBearing && !topicHasMetrics;
      return {
        genre: g.genre,
        description: g.description,
        metricBearing: g.metricBearing,
        selectable: !blockedByMetrics,
        reason: blockedByMetrics ? "Needs a topic with metric data." : null
      };
    });

    res.json({ topicId: resolvedSlug, topicHasMetrics, genres: menu });
  } catch (err) {
    platformLog("error", "compose_genres_failed", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});
















router.get("/metric-preview", requirePermission("preview_post"), async (req, res) => {
  try {
    const slug = typeof req.query.topicId === "string" ? req.query.topicId.trim() : "";
    const rawGenre = typeof req.query.genre === "string" ? req.query.genre.trim() : "";
    const genre = rawGenre || "default";

    if (!slug) {
      return res.status(400).json({ error: "topicId is required" });
    }
    if (!GENRE_RE.test(genre)) {
      return res.status(400).json({ error: "Invalid genre format." });
    }
    if (genre !== "default") {
      const exists = await genreExists("content_generator", genre);
      if (!exists) {
        return res.status(400).json({ error: "Unknown genre: " + genre });
      }
    }

    
    
    
    const resolved = await withTenant(req.tenant.id, async () => {
      const topic = await getTopicBySlug(slug);
      if (!topic) return null;
      const groups = await getMetricsForTopic(topic.id);
      return { slug: topic.slug, groups };
    });
    if (!resolved) {
      return res.status(404).json({ error: "Topic not found" });
    }

    
    
    
    const metricBearing = await templateUsesMetricBlock("content_generator", genre);

    const groups = resolved.groups.map((g) => ({
      groupSlug: g.groupSlug,
      groupLabel: g.groupLabel,
      metrics: (Array.isArray(g.metrics) ? g.metrics : []).map((m) => ({
        metricKey: m.metricKey,
        value: m.value,
        unit: m.unit,
        source: {
          name: m.source ? m.source.name : null,
          quote: m.source ? m.source.quote : null,
          locator: m.source ? m.source.locator : null,
          url: m.source ? m.source.url : null
        }
      }))
    }));
    const metricCount = groups.reduce((n, g) => n + g.metrics.length, 0);
    const willInjectMetrics = metricBearing && metricCount > 0;

    
    
    
    
    
    
    
    let status;
    if (!metricBearing) {
      status = "genre_no_metrics";
    } else if (metricCount === 0) {
      status = "needs_metrics";
    } else {
      status = "ready";
    }

    res.json({
      topicId: resolved.slug,
      genre,
      metricBearing,
      willInjectMetrics,
      status,
      groupCount: groups.length,
      metricCount,
      groups
    });
  } catch (err) {
    platformLog("error", "compose_metric_preview_failed", { path: req.path, error: err.message });
    res.status(500).json({ error: "An internal error occurred" });
  }
});

export default router;
