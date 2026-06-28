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
import { isSafeUrl } from "./security.js";
import { getMaxAgeDays } from "../config/research.js";
import { platformLog } from "./platform-log.js";

const parser = new Parser({ timeout: 15000 });



const VALIDATION_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; 

const XML_CONTENT_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml",
  "text/html" 
]);







const GRADE_A_MAX_RESPONSE_MS = 5000;
const GRADE_B_MAX_RESPONSE_MS = 15000;
const GRADE_STALE_DAYS = 90;



export async function validateFeed(url) {
  const result = {
    valid: false,
    grade: "F",
    url,
    feedTitle: null,
    httpStatus: null,
    contentType: null,
    itemCount: 0,
    latestItemDate: null,
    responseMs: 0,
    error: null
  };

  
  if (!url || typeof url !== "string") {
    result.error = "URL is empty or not a string";
    return result;
  }

  if (!isSafeUrl(url)) {
    result.error = "URL blocked by SSRF protection (must be HTTPS, public host)";
    return result;
  }

  
  const startMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "LinkedInAIAgent/1.5 (Feed Validator)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml"
      },
      signal: controller.signal
    });
  } catch (fetchErr) {
    result.responseMs = Date.now() - startMs;
    if (fetchErr.name === "AbortError") {
      result.error = `Timeout after ${VALIDATION_TIMEOUT_MS}ms`;
    } else {
      result.error = `Fetch failed: ${fetchErr.message.substring(0, 200)}`;
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }

  result.responseMs = Date.now() - startMs;
  result.httpStatus = response.status;

  if (!response.ok) {
    result.error = `HTTP ${response.status} ${response.statusText}`;
    return result;
  }

  
  const rawContentType = (response.headers.get("content-type") || "")
    .split(";")[0].trim().toLowerCase();
  result.contentType = rawContentType;

  if (rawContentType && !XML_CONTENT_TYPES.has(rawContentType)) {
    result.error = `Unexpected Content-Type: ${rawContentType} (expected RSS/XML)`;
    return result;
  }

  // ── Step 4: Read body with size cap ──────────────────────
  let xml;
  try {
    const chunks = [];
    let totalBytes = 0;
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        reader.cancel();
        result.error = `Response exceeds ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)} MB size limit`;
        return result;
      }
      chunks.push(value);
    }

    xml = Buffer.concat(chunks).toString("utf-8");
  } catch (readErr) {
    result.error = `Failed to read response body: ${readErr.message.substring(0, 200)}`;
    return result;
  }

  if (!xml || xml.trim().length === 0) {
    result.error = "Empty response body";
    return result;
  }

  
  let feed;
  try {
    feed = await parser.parseString(xml);
  } catch (parseErr) {
    result.error = `RSS parse failed: ${parseErr.message.substring(0, 200)}`;
    return result;
  }

  result.feedTitle = feed.title || null;
  const items = feed.items || [];
  result.itemCount = items.length;

  
  if (items.length > 0) {
    const dates = items
      .map(i => i.isoDate || i.pubDate || null)
      .filter(Boolean)
      .map(d => new Date(d))
      .filter(d => !isNaN(d.getTime()))
      .sort((a, b) => b - a);

    if (dates.length > 0) {
      result.latestItemDate = dates[0].toISOString();
    }
  }

  
  
  
  if (items.length > 0) {
    const summaries = items
      .map(i => (i.contentSnippet || i.content || i.summary || "").trim())
      .filter(s => s.length > 0);

    result.summaryCount = summaries.length;
    result.avgSummaryLength = summaries.length > 0
      ? Math.round(summaries.reduce((sum, s) => sum + s.length, 0) / summaries.length)
      : 0;

    // Paywall/truncation detection — check for common patterns
    const paywallPatterns = [
      /subscribe to (read|continue|access)/i,
      /sign in to (read|continue|view)/i,
      /log ?in (to|required)/i,
      /premium (content|article|subscriber)/i,
      /for (full|complete) (article|story|access)/i,
      /members? only/i,
      /create (a )?free account/i,
      /unlock (this|full) (article|story)/i
    ];

    const paywallHits = summaries.filter(s =>
      paywallPatterns.some(p => p.test(s))
    ).length;

    result.paywallIndicators = paywallHits;

    // Truncation detection — if most summaries are very short
    // or all end with "..." it suggests truncated content
    const truncated = summaries.filter(s =>
      s.length < 80 || s.endsWith("...") || s.endsWith("…")
    ).length;
    result.truncatedCount = truncated;

    // Quality flags
    const qualityIssues = [];
    if (summaries.length === 0) {
      qualityIssues.push("no_summaries");
    } else if (result.avgSummaryLength < 50) {
      qualityIssues.push("very_short_summaries");
    }
    if (paywallHits > 0) {
      qualityIssues.push("paywall_detected");
    }
    if (truncated > summaries.length * 0.7) {
      qualityIssues.push("mostly_truncated");
    }
    result.qualityIssues = qualityIssues;
  } else {
    result.summaryCount = 0;
    result.avgSummaryLength = 0;
    result.paywallIndicators = 0;
    result.truncatedCount = 0;
    result.qualityIssues = ["empty_feed"];
  }

  
  
  
  const categorySet = new Set();
  if (feed.categories) {
    (Array.isArray(feed.categories) ? feed.categories : [feed.categories])
      .forEach(c => {
        const tag = (typeof c === "string" ? c : c?._ || "").toLowerCase().trim();
        if (tag && tag.length >= 2 && tag.length <= 50) categorySet.add(tag);
      });
  }
  for (const item of items.slice(0, 10)) {
    (item.categories || []).forEach(c => {
      const tag = (typeof c === "string" ? c : c?._ || "").toLowerCase().trim();
      if (tag && tag.length >= 2 && tag.length <= 50) categorySet.add(tag);
    });
  }
  result.suggestedDomains = [...categorySet].slice(0, 10);

  // ── Step 9: Assign grade ─────────────────────────────────
  // Paywall or severe quality issues cap the grade
  if (result.paywallIndicators > 0) {
    result.valid = false;
    result.grade = "F";
    result.error = `Paywall detected: ${result.paywallIndicators} items contain subscription/login language`;
    return result;
  }

  result.valid = true;
  result.grade = computeGrade(result);

  return result;
}

function computeGrade(result) {
  if (!result.valid) return "F";

  const { itemCount, latestItemDate, responseMs, qualityIssues } = result;

  
  if (itemCount === 0) return "C";

  
  const hasQualityIssues = qualityIssues && qualityIssues.length > 0;
  const hasSevereIssues = qualityIssues &&
    (qualityIssues.includes("no_summaries") || qualityIssues.includes("mostly_truncated"));

  
  const maxAgeDays = getMaxAgeDays();
  const staleDays = GRADE_STALE_DAYS;
  const now = Date.now();

  if (latestItemDate) {
    const latestMs = new Date(latestItemDate).getTime();
    const ageDays = (now - latestMs) / (1000 * 60 * 60 * 24);

    
    if (ageDays <= maxAgeDays && responseMs <= GRADE_A_MAX_RESPONSE_MS && !hasQualityIssues) return "A";

    
    if (ageDays <= maxAgeDays && !hasSevereIssues) return "B";

    
    if (ageDays <= maxAgeDays) return "C";

    
    if (ageDays <= staleDays) return hasSevereIssues ? "C" : "B";

    
    return "C";
  }

  
  if (hasSevereIssues) return "C";
  if (responseMs <= GRADE_B_MAX_RESPONSE_MS) return "B";

  return "C";
}

export async function validateFeeds(urls, concurrency = 4) {
  const results = new Array(urls.length);
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const idx = cursor++;
      results[idx] = await validateFeed(urls[idx]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, urls.length) },
    () => worker()
  );
  await Promise.all(workers);

  return results;
}

export function formatValidationMessage(result) {
  if (result.valid) {
    return `[${result.grade}] ${result.feedTitle || result.url} — ${result.itemCount} items, ` +
      `latest: ${result.latestItemDate ? result.latestItemDate.split("T")[0] : "unknown"}, ` +
      `${result.responseMs}ms`;
  }
  return `[F] ${result.url} — ${result.error}`;
}
