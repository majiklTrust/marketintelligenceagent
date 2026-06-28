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

import { query } from "../db/pool.js";
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from "node:crypto";
import { decryptPlatformSecret } from "../services/platform-secret.js";





export async function findTenantByAuthIdentity(provider, sub) {
  const result = await query(
    `SELECT t.id, t.slug, t.name, t.status, t.created_at, t.updated_at,
            m.role::text AS role
     FROM memberships m
     JOIN tenants t ON t.id = m.tenant_id
     WHERE m.auth_provider = $1::auth_provider AND m.auth_sub = $2
       AND t.status = 'active'::tenant_status
     LIMIT 1`,
    [provider, sub]
  );
  return result.rows[0] || null;
}




export async function listActiveTenants() {
  const result = await query(
    `SELECT id, slug, name, status, created_at, updated_at
     FROM tenants
     WHERE status = 'active'::tenant_status
     ORDER BY created_at`
  );
  return result.rows;
}







let _permissionCache = null;

async function loadPermissions() {
  if (_permissionCache) return _permissionCache;
  const result = await query(
    `SELECT role::text, permission FROM role_permissions`
  );
  const cache = new Map();
  for (const row of result.rows) {
    if (!cache.has(row.role)) {
      cache.set(row.role, new Set());
    }
    cache.get(row.role).add(row.permission);
  }
  _permissionCache = cache;
  return cache;
}






export async function hasPermission(role, permission) {
  const cache = await loadPermissions();
  const perms = cache.get(role);
  if (!perms) return false;
  return perms.has(permission);
}



export function _resetPermissionCacheForTesting() {
  _permissionCache = null;
}







export async function findPendingInviteByEmail(email) {
  if (!email || typeof email !== "string") return null;
  const result = await query(
    `SELECT i.id, i.tenant_id, i.email, i.email_domain,
            i.role::text AS role, i.invited_by, i.status::text AS status
     FROM invites i
     JOIN tenants t ON t.id = i.tenant_id
     WHERE lower(i.email) = $1
       AND i.status = 'pending'::invite_status
       AND t.status = 'active'::tenant_status
     ORDER BY i.created_at DESC
     LIMIT 1`,
    [email.trim().toLowerCase()]
  );
  return result.rows[0] || null;
}

export async function claimInvite(inviteId, provider, sub) {
  
  
  
  await query(
    `WITH new_membership AS (
       INSERT INTO memberships (tenant_id, auth_provider, auth_sub, role)
       SELECT i.tenant_id, $2::auth_provider, $3, i.role
       FROM invites i
       WHERE i.id = $1 AND i.status = 'pending'::invite_status
       RETURNING tenant_id
     )
     UPDATE invites
     SET status = 'claimed'::invite_status,
         claimed_at = now(),
         claimed_by_sub = $3
     WHERE id = $1 AND EXISTS (SELECT 1 FROM new_membership)`,
    [inviteId, provider, sub]
  );

  
  return findTenantByAuthIdentity(provider, sub);
}











let cachedAdminSubs = null;
let cachedAdminSubsCipher = null;

function getAdminSubs() {
  const cipher = process.env.PLATFORM_ADMIN_SUBS;
  if (!cipher || cipher.trim().length === 0) return null;
  if (cipher === cachedAdminSubsCipher) return cachedAdminSubs;
  let plaintext;
  try {
    plaintext = decryptPlatformSecret(cipher.trim());
  } catch {
    return null; 
  }
  const list = plaintext.split(",").map((s) => s.trim()).filter(Boolean);
  cachedAdminSubsCipher = cipher;
  cachedAdminSubs = list;
  return list;
}

export function isPlatformAdmin(sub) {
  if (!sub || typeof sub !== "string") return false;
  const list = getAdminSubs();
  if (!list || list.length === 0) return false;
  return list.includes(sub);
}









const DEFAULT_TTL_MINUTES = 15;

function getRegistrationTTL() {
  const envVal = parseInt(process.env.REGISTRATION_INVITE_TTL_MINUTES, 10);
  return envVal > 0 ? envVal : DEFAULT_TTL_MINUTES;
}







function deriveRegKey(registrationId) {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error("ENCRYPTION_SECRET is required");
  return pbkdf2Sync(secret, `reg:${registrationId}`, 100000, 32, "sha512");
}

function encryptForRegistration(plaintext, registrationId) {
  const key = deriveRegKey(registrationId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptForRegistration(encBuffer, registrationId) {
  const key = deriveRegKey(registrationId);
  const iv = encBuffer.subarray(0, 12);
  const authTag = encBuffer.subarray(12, 28);
  const ciphertext = encBuffer.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext, null, "utf8") + decipher.final("utf8");
}

export async function createRegistrationInvite(email, invitedBySub, apiKey = null, modelId = null) {
  const token = randomBytes(32).toString("base64url");
  const ttl = getRegistrationTTL();
  const result = await query(
    `INSERT INTO tenant_registrations (token, email, invited_by_sub, expires_at, model_id)
     VALUES ($1, lower($2), $3, now() + ($4 || ' minutes')::interval, $5)
     RETURNING id, token, email, expires_at`,
    [token, email.trim(), invitedBySub, String(ttl), modelId]
  );

  const reg = result.rows[0];

  
  if (apiKey && reg.id) {
    const enc = encryptForRegistration(apiKey, reg.id);
    await query(
      `UPDATE tenant_registrations SET api_key_enc = $1 WHERE id = $2`,
      [enc, reg.id]
    );
  }

  return { ...reg, keyProvided: !!apiKey };
}

export async function validateRegistrationToken(token) {
  if (!token || typeof token !== "string") return null;
  const result = await query(
    `SELECT id, token, email, status, invited_by_sub, tenant_id,
            expires_at, created_at, model_id,
            (api_key_enc IS NOT NULL) AS key_provided
     FROM tenant_registrations
     WHERE token = $1
       AND status IN ('pending', 'active')
       AND expires_at > now()`,
    [token]
  );
  return result.rows[0] || null;
}

export async function activateRegistrationToken(token) {
  const result = await query(
    `UPDATE tenant_registrations
     SET status = 'active'
     WHERE token = $1 AND status = 'pending'
     RETURNING id, email, expires_at`,
    [token]
  );
  return result.rows[0] || null;
}

export async function completeRegistration(token, slug, name) {
  
  
  const result = await query(
    `WITH valid_reg AS (
       SELECT id FROM tenant_registrations
       WHERE token = $1 AND status = 'active' AND expires_at > now()
       FOR UPDATE
     ),
     new_tenant AS (
       INSERT INTO tenants (slug, name, status)
       SELECT $2, $3, 'active'::tenant_status
       FROM valid_reg
       WHERE EXISTS (SELECT 1 FROM valid_reg)
       RETURNING id
     )
     UPDATE tenant_registrations
     SET status = 'claimed',
         claimed_at = now(),
         tenant_id = (SELECT id FROM new_tenant)
     WHERE token = $1
       AND EXISTS (SELECT 1 FROM new_tenant)
     RETURNING tenant_id`,
    [token, slug, name]
  );
  return result.rows[0]?.tenant_id || null;
}

export async function expireStaleRegistrations() {
  const result = await query(
    `UPDATE tenant_registrations
     SET status = 'expired',
         api_key_enc = NULL
     WHERE status IN ('pending', 'active')
       AND expires_at <= now()`
  );
  return result.rowCount;
}

export async function getRegistrationAdminKey(registrationId) {
  const result = await query(
    `SELECT id, api_key_enc, model_id FROM tenant_registrations WHERE id = $1`,
    [registrationId]
  );
  const row = result.rows[0];
  if (!row || !row.api_key_enc) return null;

  const apiKey = decryptForRegistration(row.api_key_enc, row.id);
  return { apiKey, modelId: row.model_id };
}

export async function clearRegistrationKey(registrationId) {
  await query(
    `UPDATE tenant_registrations SET api_key_enc = NULL WHERE id = $1`,
    [registrationId]
  );
}
