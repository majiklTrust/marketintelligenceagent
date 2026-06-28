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



const SCAN_LIMIT = 250000;

const OG_PATTERNS = [
  
  /<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i,
  /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["']/i
];
const TWITTER_PATTERNS = [
  // twitter:image via name= or property=, either order
  /<meta\b[^>]*(?:name|property)\s*=\s*["']twitter:image["'][^>]*content\s*=\s*["']([^"']+)["']/i,
  /<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*(?:name|property)\s*=\s*["']twitter:image["']/i
];



export function extractOgImage(html) {
  if (typeof html !== "string" || html.length === 0) return null;
  const head = html.slice(0, SCAN_LIMIT);
  for (const re of OG_PATTERNS) {
    const m = re.exec(head);
    if (m && m[1]) return m[1];
  }
  for (const re of TWITTER_PATTERNS) {
    const m = re.exec(head);
    if (m && m[1]) return m[1];
  }
  return null;
}



export function pickOgImage(html, articleLink) {
  const raw = extractOgImage(html);
  if (!raw) return null;
  let absolute;
  try {
    absolute = new URL(raw, articleLink).toString();
  } catch {
    return null;
  }
  
  
  return isImageUrl(absolute, "image/unknown") ? absolute : null;
}
