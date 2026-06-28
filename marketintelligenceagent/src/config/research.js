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

import { getAgentState } from "../services/database.js";



const DEFAULT_MAX_AGE_DAYS = 20;
const DEFAULT_MAX_AGE_DAYS_PRUNE = 60;
const DEFAULT_MAX_RESEARCH_ARTICLES = 30;
const DEFAULT_DASHBOARD_FEED_LIMIT = 8;
const DEFAULT_API_COOLDOWN_MS = 10000;

export function getMaxAgeDays() {
  const val = parseInt(process.env.MAX_AGE_DAYS, 10);
  return val > 0 ? val : DEFAULT_MAX_AGE_DAYS;
}

export function getMaxAgeDaysPrune() {
  const val = parseInt(process.env.MAX_AGE_DAYS_PRUNE, 10);
  return val > 0 ? val : DEFAULT_MAX_AGE_DAYS_PRUNE;
}

export function getMaxResearchArticles() {
  const val = parseInt(process.env.MAX_RESEARCH_ARTICLES, 10);
  return val > 0 ? val : DEFAULT_MAX_RESEARCH_ARTICLES;
}

export function getDashboardFeedLimit() {
  const val = parseInt(process.env.DASHBOARD_FEED_LIMIT, 10);
  return val > 0 ? val : DEFAULT_DASHBOARD_FEED_LIMIT;
}












const DEFAULT_FEEDS_MANAGER_VERSION = 1;
const DEFAULT_DOMAIN_MATCH_THRESHOLD = 0.4;







export async function getFeedsManagerVersion() {
  try {
    const dbVal = await getAgentState("feeds_manager_version");
    if (dbVal) {
      const parsed = parseInt(dbVal, 10);
      if (parsed === 1 || parsed === 2) return parsed;
    }
  } catch {
    
  }
  const envVal = parseInt(process.env.FEEDS_MANAGER_VERSION, 10);
  return (envVal === 1 || envVal === 2) ? envVal : DEFAULT_FEEDS_MANAGER_VERSION;
}

export function getDomainMatchThreshold() {
  const val = parseFloat(process.env.DOMAIN_MATCH_THRESHOLD);
  if (isNaN(val)) return DEFAULT_DOMAIN_MATCH_THRESHOLD;
  return Math.max(0.0, Math.min(1.0, val));
}




function ensureArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try { const parsed = JSON.parse(val); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }
  return [];
}

export function domainMatchScore(feedDomains, topicDomains) {
  const fd = ensureArray(feedDomains);
  const td = ensureArray(topicDomains);
  if (!fd.length || !td.length) return 0;
  const feedSet = new Set(fd.map(d => String(d).toLowerCase()));
  const topicSet = new Set(td.map(d => String(d).toLowerCase()));
  const overlap = [...topicSet].filter(d => feedSet.has(d)).length;
  return overlap / Math.min(feedSet.size, topicSet.size);
}

export function getCooldownMs() {
  const val = parseInt(process.env.API_COOLDOWN_MS, 10);
  return val > 0 ? val : DEFAULT_API_COOLDOWN_MS;
}
