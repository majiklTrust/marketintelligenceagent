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

import { createHmac, randomBytes, hkdfSync, timingSafeEqual } from "node:crypto";
import { platformLog } from "./platform-log.js";






var ACTION_REGISTRY = {
  "generate-content": {
    description: "Generate a social media post from research",
    vaultKeys: [
      "content_generator",
      "research_brief_corroborated",
      "research_brief_uncorroborated",
      "untrusted_content_prefix",
      "untrusted_content_suffix",
      "research_assistant",
      "corroboration_analyst",
      "quality_reviewer"
    ],
    requiredPermission: "edit_post"
  },
  "discover-feeds": {
    description: "AI-powered RSS feed suggestions",
    vaultKeys: ["feed_discovery"],
    requiredPermission: "manage_feeds"
  }
};












var TOKEN_TTL_MS = 300000; 
var HKDF_SALT = "prompt-action-token";
var HKDF_INFO = "action-token-v1";
var signingKey = null;

function getSigningKey() {
  if (signingKey) return signingKey;
  var secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error("ENCRYPTION_SECRET is not set — action tokens cannot be signed");
  }
  var derived = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(HKDF_SALT, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    32
  );
  signingKey = Buffer.from(derived);
  return signingKey;
}













export function createActionToken(actionId, sub) {
  if (!ACTION_REGISTRY[actionId]) {
    throw new Error("Unknown action: " + actionId);
  }
  if (!sub || typeof sub !== "string") {
    throw new Error("User identity required for action token");
  }

  var nonce = randomBytes(16).toString("base64url");
  var iat = Date.now();
  
  var payload = [actionId, sub, iat, nonce].join("::");

  var key = getSigningKey();
  var signature = createHmac("sha256", key).update(payload).digest("base64url");

  return payload + "." + signature;
}

export function validateActionToken(token, vaultKey) {
  if (!token || typeof token !== "string") {
    return { valid: false, action: null, sub: null, reason: "missing token" };
  }

  var dotIdx = token.lastIndexOf(".");
  if (dotIdx < 0) {
    return { valid: false, action: null, sub: null, reason: "malformed token" };
  }

  var payload = token.substring(0, dotIdx);
  var providedSig = token.substring(dotIdx + 1);

  
  var key = getSigningKey();
  var expectedSig = createHmac("sha256", key).update(payload).digest("base64url");

  var sigBuffer = Buffer.from(providedSig, "base64url");
  var expBuffer = Buffer.from(expectedSig, "base64url");
  if (sigBuffer.length !== expBuffer.length || !timingSafeEqual(sigBuffer, expBuffer)) {
    return { valid: false, action: null, sub: null, reason: "invalid signature" };
  }

  
  var parts = payload.split("::");
  if (parts.length !== 4) {
    return { valid: false, action: null, sub: null, reason: "malformed payload" };
  }

  var [actionId, sub, iatStr] = parts;
  var iat = parseInt(iatStr, 10);

  
  if (Date.now() - iat > TOKEN_TTL_MS) {
    return { valid: false, action: actionId, sub, reason: "token expired" };
  }

  
  var actionDef = ACTION_REGISTRY[actionId];
  if (!actionDef) {
    return { valid: false, action: actionId, sub, reason: "unknown action" };
  }

  
  if (!actionDef.vaultKeys.includes(vaultKey)) {
    platformLog("warn", "prompt_key_unauthorized", {
      action: actionId, sub, requestedKey: vaultKey,
      allowedKeys: actionDef.vaultKeys
    });
    return { valid: false, action: actionId, sub, reason: "key not authorized for action" };
  }

  return { valid: true, action: actionId, sub };
}

export function getActionDefinition(actionId) {
  return ACTION_REGISTRY[actionId] || null;
}

export function listActions() {
  return Object.entries(ACTION_REGISTRY).map(([id, def]) => ({
    actionId: id,
    description: def.description,
    requiredPermission: def.requiredPermission
  }));
}
