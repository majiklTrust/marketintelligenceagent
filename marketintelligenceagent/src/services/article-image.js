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

import { isImageUrl } from "./security.js";

function asArray(v) {
  if (Array.isArray(v)) return v;
  return v === null || v === undefined ? [] : [v];
}


function mediaUrl(m) {
  return (m && typeof m === "object" && m.$ && typeof m.$.url === "string") ? m.$.url : null;
}

function mediaType(m) {
  if (!m || typeof m !== "object" || !m.$) return null;
  if (m.$.medium === "image") return "image/unknown";
  return typeof m.$.type === "string" ? m.$.type : null;
}

export function extractArticleImage(item) {
  if (!item || typeof item !== "object") return null;
  const candidates = [];

  
  const enc = item.enclosure;
  if (enc && typeof enc === "object" && typeof enc.url === "string") {
    candidates.push({ url: enc.url, type: typeof enc.type === "string" ? enc.type : null });
  }

  
  const group = (item["media:group"] && typeof item["media:group"] === "object")
    ? item["media:group"] : null;

  const contents = [
    ...asArray(item["media:content"]),
    ...asArray(group && group["media:content"])
  ];
  for (const m of contents) {
    const url = mediaUrl(m);
    if (url) candidates.push({ url, type: mediaType(m) });
  }

  const thumbs = [
    ...asArray(item["media:thumbnail"]),
    ...asArray(group && group["media:thumbnail"])
  ];
  for (const m of thumbs) {
    const url = mediaUrl(m);
    if (url) candidates.push({ url, type: "image/unknown" });
  }

  for (const c of candidates) {
    if (isImageUrl(c.url, c.type)) return c.url;
  }
  return null;
}
