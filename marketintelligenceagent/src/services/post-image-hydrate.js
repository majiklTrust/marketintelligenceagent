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

const LINK_CAP = 50;
const IMAGE_CAP = 20;

function isHttps(u) {
  return typeof u === "string" && /^https:\/\//.test(u);
}

export function collectSourceLinks(ctx) {
  if (!ctx || typeof ctx !== "object") return [];
  const out = [];
  const seen = new Set();
  const add = (u) => {
    if (isHttps(u) && !seen.has(u) && out.length < LINK_CAP) {
      seen.add(u);
      out.push(u);
    }
  };
  if (Array.isArray(ctx.sourcesUsed)) {
    for (const s of ctx.sourcesUsed) add(s);
  }
  const list = ctx.researchSummary && Array.isArray(ctx.researchSummary.sourceList)
    ? ctx.researchSummary.sourceList : [];
  for (const s of list) {
    if (s && typeof s === "object") add(s.url);
  }
  return out;
}

export function mergeArticleImages(stored, derived) {
  const out = [];
  const seenImage = new Set();
  const seenLink = new Set();
  const add = (e) => {
    if (!e || typeof e !== "object" || !isHttps(e.imageUrl)) return;
    if (seenImage.has(e.imageUrl)) return;
    if (typeof e.link === "string" && seenLink.has(e.link)) return;
    if (out.length >= IMAGE_CAP) return;
    seenImage.add(e.imageUrl);
    if (typeof e.link === "string") seenLink.add(e.link);
    out.push({
      imageUrl: e.imageUrl,
      title: typeof e.title === "string" ? e.title : null,
      feedName: typeof e.feedName === "string" ? e.feedName : null,
      link: typeof e.link === "string" ? e.link : null
    });
  };
  for (const e of Array.isArray(stored) ? stored : []) add(e);
  for (const e of Array.isArray(derived) ? derived : []) add(e);
  return out;
}
