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

const MAX_REQUEST_LENGTH = 500;





export function selectContentAngle(topic, recentPosts) {
  const angles = topic.content_angles || [];
  if (angles.length === 0) return "General discussion";

  const recentSameTopic = recentPosts
    .filter(p => p.topic_id === topic.slug)
    .slice(0, 5);

  const usedAngles = new Set();
  for (const post of recentSameTopic) {
    for (let i = 0; i < angles.length; i++) {
      const angleWords = angles[i].toLowerCase().split(/\s+/);
      const postWords = post.content.toLowerCase();
      const matchCount = angleWords.filter(w => w.length > 4 && postWords.includes(w)).length;
      if (matchCount >= 3) usedAngles.add(i);
    }
  }

  const availableIndices = angles
    .map((_, i) => i)
    .filter(i => !usedAngles.has(i));

  const pool = availableIndices.length > 0
    ? availableIndices
    : angles.map((_, i) => i);

  const idx = pool[Math.floor(Math.random() * pool.length)];
  return angles[idx];
}







function normalize(s) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function findExistingAngle(topic, requested) {
  if (typeof requested !== "string") return null;
  if (requested.length > MAX_REQUEST_LENGTH) return null;
  const wanted = normalize(requested);
  if (wanted.length === 0) return null;
  const angles = (topic && topic.content_angles) || [];
  for (const a of angles) {
    if (typeof a !== "string") continue;
    if (normalize(a) === wanted) return a; 
  }
  return null;
}









export function resolveAngle(topic, requested, recentPosts) {
  const isEmpty = requested === null || requested === undefined ||
    (typeof requested === "string" && requested.trim().length === 0);

  if (isEmpty) {
    return { ok: true, angle: selectContentAngle(topic, recentPosts || []), selected: false };
  }
  const canonical = findExistingAngle(topic, requested);
  if (canonical !== null) {
    return { ok: true, angle: canonical, selected: true };
  }
  return { ok: false, reason: "Requested angle is not one of this topic's existing content angles" };
}
