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

const MAX_TITLE_LENGTH = 500;
const MAX_SUMMARY_LENGTH = 1000;
const MAX_LINK_LENGTH = 2048;


const BLOCKED_SCHEMES = /^(javascript|data|vbscript|blob|file):/i;


const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u2060\u2061\u2062\u2063\u2064]/g;





const NAMED_ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
  "&ndash;": "–", "&mdash;": "—", "&lsquo;": "'",
  "&rsquo;": "'", "&ldquo;": "\u201C", "&rdquo;": "\u201D",
  "&bull;": "•", "&hellip;": "…", "&copy;": "©",
  "&reg;": "®", "&trade;": "™",
};

function decodeEntities(str) {
  if (!str) return "";
  let result = str;
  // Up to 3 passes to handle nested encoding (&amp;lt; → &lt; → <)
  for (let pass = 0; pass < 3; pass++) {
    const before = result;
    // Named entities
    result = result.replace(/&[a-zA-Z]+;/g, match =>
      NAMED_ENTITIES[match.toLowerCase()] || match
    );
    // Decimal numeric entities (&#60; → <)
    result = result.replace(/&#(\d+);/g, (_, code) => {
      const n = parseInt(code, 10);
      return n > 0 && n < 0x10FFFF ? String.fromCodePoint(n) : "";
    });
    // Hex numeric entities (&#x3C; → <)
    result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const n = parseInt(hex, 16);
      return n > 0 && n < 0x10FFFF ? String.fromCodePoint(n) : "";
    });
    if (result === before) break; // No more changes — stop early
  }
  return result;
}

// ── HTML Tag Stripping ───────────────────────────────────────
// Removes all HTML/XML tags including CDATA, comments, and
// fullwidth Unicode angle brackets used to evade basic regex.

function stripTags(str) {
  if (!str) return "";
  let result = str;
  // Remove CDATA sections
  result = result.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, "");
  // Remove HTML comments
  result = result.replace(/<!--[\s\S]*?-->/g, "");
  // Remove style and script blocks (content included)
  result = result.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  result = result.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  // Remove all remaining HTML tags
  result = result.replace(/<[^>]*>/g, "");
  // Remove fullwidth angle brackets and content between them
  result = result.replace(/\uFF1C[^\uFF1E]*\uFF1E/g, "");
  return result;
}

// ── Control Character Removal ────────────────────────────────

function stripControlChars(str) {
  if (!str) return "";
  // Remove null bytes and C0 control chars except \n, \r, \t
  let result = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Remove zero-width characters
  result = result.replace(ZERO_WIDTH_RE, "");
  return result;
}

// ── Whitespace Normalization ─────────────────────────────────

function normalizeWhitespace(str) {
  if (!str) return "";
  return str.replace(/\s+/g, " ").trim();
}

// ── Public API ───────────────────────────────────────────────

/**
 * Sanitize an RSS feed title.
 * @param {string|null|undefined} raw
 * @returns {string} Clean text, max 500 chars
 */
export function sanitizeTitle(raw) {
  if (raw == null) return "";
  let text = String(raw);
  text = decodeEntities(text);
  text = stripTags(text);
  text = stripControlChars(text);
  text = normalizeWhitespace(text);
  return text.slice(0, MAX_TITLE_LENGTH);
}

/**
 * Sanitize an RSS feed summary/content snippet.
 * @param {string|null|undefined} raw
 * @returns {string} Clean text, max 1000 chars
 */
export function sanitizeSummary(raw) {
  if (raw == null) return "";
  let text = String(raw);
  text = decodeEntities(text);
  text = stripTags(text);
  text = stripControlChars(text);
  text = normalizeWhitespace(text);
  return text.slice(0, MAX_SUMMARY_LENGTH);
}

/**
 * Sanitize an RSS feed link/URL.
 * Rejects dangerous URI schemes, strips control chars, enforces max length.
 * @param {string|null|undefined} raw
 * @returns {string|null} Clean URL or null if invalid/dangerous
 */
export function sanitizeLink(raw) {
  if (!raw || typeof raw !== "string") return null;

  let url = raw.trim();

  
  url = url.replace(/[\x00-\x1F\x7F]/g, "");

  // Decode percent-encoded characters for scheme detection
  let decoded;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    decoded = url;
  }

  // Strip whitespace from decoded version for scheme check
  const schemePart = decoded.replace(/\s/g, "");

  // Reject dangerous schemes
  if (BLOCKED_SCHEMES.test(schemePart)) return null;

  // Reject empty after cleaning
  if (!url || url.length === 0) return null;

  // Enforce max length
  if (url.length > MAX_LINK_LENGTH) return null;

  // Must start with http:// or https:// for RSS feed links
  if (!url.match(/^https?:\/\//i)) return null;

  return url;
}

// ── Prompt Injection Detection ───────────────────────────────
//
// Pattern-based detection of known prompt injection techniques.
// This is a speed bump, not a wall — sophisticated rephrasing
// can bypass it. The content framing layer (prompt-framing.js)
// is the primary defense.

const INJECTION_PATTERNS = [
  // English instruction override
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|context|prompts?|rules)/i,
  /disregard\s+(the\s+)?(above|previous|prior|earlier)\s+(context|instructions|prompts?)/i,
  /forget\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|context)/i,

  // System prompt extraction
  /output\s+(your|the)\s+(system\s+)?prompt/i,
  /(show|display|print|reveal|repeat)\s+(your|the)\s+(system\s+)?(prompt|instructions)/i,
  /what\s+(are|is)\s+your\s+(system\s+)?(prompt|instructions)/i,

  // Role hijacking
  /you\s+are\s+now\s+a/i,
  /act\s+as\s+(if\s+you\s+are|a)\s/i,
  /your\s+new\s+(role|task|instruction|purpose)\s+is/i,

  // Delimiter escape — attacker tries to close untrusted content block
  /---\s*END\s+(UNTRUSTED|EXTERNAL|USER)\s+(CONTENT|INPUT|DATA)\s*---/i,
  /\[\/?(UNTRUSTED|EXTERNAL|SYSTEM|INSTRUCTION)\]/i,

  // JSON output format injection
  /\{\s*"title"\s*:\s*"[^"]*"\s*,\s*"body"\s*:/i,
  /\{\s*"title"\s*:\s*"[^"]*"\s*,\s*"hook"\s*:/i,

  
  /ignorez\s+(toutes?\s+)?(les\s+)?instructions/i,
  /affichez\s+(la|le|les)\s+(cl[eé]|prompt|secret)/i,

  
  /note\s+to\s+(the\s+)?(ai|assistant|model|system)\s*:/i,
  /(system\s+)?prompt\s+should\s+be\s+(overridden|changed|modified|replaced)/i,
  /override\s+(the\s+)?(system\s+)?(prompt|instructions)/i,
];

export function detectPromptInjection(text) {
  if (!text || typeof text !== "string") return { detected: false, patterns: [] };

  const matched = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      matched.push(pattern.source.slice(0, 40));
    }
  }

  return {
    detected: matched.length > 0,
    patterns: matched
  };
}
