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

import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from "node:crypto";

const HKDF_SALT = "platform-secret";
const HKDF_INFO = "platform-secret-v1";
const AES_KEY_LENGTH_BYTES = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let cachedKey = null;

function deriveKey() {
  if (cachedKey) return cachedKey;
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error("ENCRYPTION_SECRET is not set — platform secret cannot be decrypted");
  }
  const derived = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(HKDF_SALT, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    AES_KEY_LENGTH_BYTES
  );
  cachedKey = Buffer.from(derived);
  return cachedKey;
}

export function encryptPlatformSecret(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("plaintext must be a non-empty string");
  }
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptPlatformSecret(b64) {
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new Error("ciphertext is empty");
  }
  const blob = Buffer.from(b64, "base64");
  if (blob.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("ciphertext is malformed");
  }
  const key = deriveKey();
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext, null, "utf8") + decipher.final("utf8");
}
