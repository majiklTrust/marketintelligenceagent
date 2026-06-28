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

import crypto from "node:crypto";
import { currentTenantId, currentClient } from "../db/with-tenant.js";


const HKDF_INFO = "credential-encryption-v1";
const AES_KEY_LENGTH_BYTES = 32;
const AES_IV_LENGTH_BYTES = 12;
const AES_AUTH_TAG_LENGTH_BYTES = 16;




const STORAGE_KEY = Object.freeze({
  ANTHROPIC_API_KEY:     "anthropic_api_key",
  LINKEDIN_ACCESS_TOKEN: "linkedin_access_token",
  LINKEDIN_PERSON_URN:   "linkedin_person_urn",
  LINKEDIN_ORG_URN:      "linkedin_org_urn"
});




const keyCache = new Map();

function deriveTenantKey(tenantId) {
  if (keyCache.has(tenantId)) return keyCache.get(tenantId);
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error("ENCRYPTION_SECRET not set");
  const derived = crypto.hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(tenantId, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    AES_KEY_LENGTH_BYTES
  );
  const key = Buffer.from(derived);
  keyCache.set(tenantId, key);
  return key;
}

function decrypt(blob, tenantKey) {
  const iv = blob.subarray(0, AES_IV_LENGTH_BYTES);
  const authTag = blob.subarray(
    AES_IV_LENGTH_BYTES,
    AES_IV_LENGTH_BYTES + AES_AUTH_TAG_LENGTH_BYTES
  );
  const ciphertext = blob.subarray(
    AES_IV_LENGTH_BYTES + AES_AUTH_TAG_LENGTH_BYTES
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", tenantKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString("utf8");
}

function encrypt(plaintext, tenantKey) {
  const iv = crypto.randomBytes(AES_IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", tenantKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  
  
  return Buffer.concat([iv, authTag, encrypted]);
}



async function fetchDecrypted(storageKey) {
  const tenantId = currentTenantId();
  if (!tenantId) {
    throw new Error("credential access called outside tenant context");
  }
  const client = currentClient();
  if (!client) {
    throw new Error("No database client in tenant context");
  }
  const result = await client.query(
    "SELECT value_enc FROM credentials WHERE key = $1",
    [storageKey]
  );
  if (result.rows.length === 0) {
    throw new Error(`Credential not found: ${storageKey}`);
  }
  const tenantKey = deriveTenantKey(tenantId);
  return decrypt(result.rows[0].value_enc, tenantKey);
}




async function storeEncrypted(storageKey, plaintext) {
  const tenantId = currentTenantId();
  if (!tenantId) {
    throw new Error("credential store called outside tenant context");
  }
  const client = currentClient();
  if (!client) {
    throw new Error("No database client in tenant context");
  }
  const tenantKey = deriveTenantKey(tenantId);
  const blob = encrypt(plaintext, tenantKey);
  await client.query(
    `INSERT INTO credentials (tenant_id, key, value_enc, encryption_version)
     VALUES (current_tenant_id(), $1, $2, 1)
     ON CONFLICT (tenant_id, key)
     DO UPDATE SET value_enc = EXCLUDED.value_enc,
                   encryption_version = EXCLUDED.encryption_version,
                   updated_at = now()`,
    [storageKey, blob]
  );
}










export async function getAnthropicApiKey() {
  return fetchDecrypted(STORAGE_KEY.ANTHROPIC_API_KEY);
}






export async function getLinkedInAccessToken() {
  return fetchDecrypted(STORAGE_KEY.LINKEDIN_ACCESS_TOKEN);
}







export async function getLinkedInPersonUrn() {
  return fetchDecrypted(STORAGE_KEY.LINKEDIN_PERSON_URN);
}






export async function getLinkedInOrgUrn() {
  return fetchDecrypted(STORAGE_KEY.LINKEDIN_ORG_URN);
}













export async function storeCredential(key, plaintext) {
  return storeEncrypted(key, plaintext);
}
