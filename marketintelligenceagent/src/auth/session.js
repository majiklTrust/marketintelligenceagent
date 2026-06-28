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

import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';
import { platformLog } from '../services/platform-log.js';



export const SESSION_COOKIE_NAME = '__la_session';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
export const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;




const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600;



export const SESSION_MAX_AGE_MS = parseInt(process.env.SESSION_MAX_AGE_MS, 10) || 300000; 








const SESSION_MAX_AGE_REFRESH_RATIO = (() => {
  const val = parseFloat(process.env.SESSION_MAX_AGE_REFRESH_RATIO);
  if (isNaN(val) || val < 0 || val > 1) return 0.75;
  return val;
})();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;          
const AUTH_TAG_LENGTH = 16;    
const MIN_SECRET_LENGTH = 32;  
const HKDF_INFO = 'marketintelligence-agent-session-v1';



function deriveKey(secret) {
  const keyMaterial = Buffer.from(secret, 'hex');
  return Buffer.from(
    hkdfSync('sha256', keyMaterial, '', HKDF_INFO, 32)
  );
}

/**
 * Read and validate SESSION_SECRET from environment.
 * Throws if missing, too short, or not valid hex.
 * Must be at least 64 hex characters (32 bytes = 256 bits).
 */
function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error('Session configuration invalid.');
  }
  if (!/^[0-9a-f]+$/i.test(secret)) {
    throw new Error('Session configuration invalid.');
  }
  return secret;
}

// ── Encryption ───────────────────────────────────────────────

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns base64url(IV || ciphertext || authTag).
 */
function encrypt(plaintext, key) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  
  return Buffer.concat([iv, encrypted, authTag]).toString('base64url');
}

function decrypt(packed, key) {
  try {
    const data = Buffer.from(packed, 'base64url');

    
    if (data.length < IV_LENGTH + 1 + AUTH_TAG_LENGTH) {
      return null;
    }

    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  } catch {
    
    return null;
  }
}



export function createSession(res, tokens) {
  if (!tokens?.accessToken) {
    throw new Error('Session requires an access token.');
  }
  if (!tokens?.user?.sub) {
    throw new Error('Session requires user claims.');
  }

  const secret = getSecret();
  const key = deriveKey(secret);

  const payload = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || null,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (tokens.expiresIn ?? DEFAULT_TOKEN_EXPIRY_SECONDS) * MS_PER_SECOND,
    user: {
      sub: tokens.user.sub,
      email: tokens.user.email || null,
      name: tokens.user.name || null,
    }
  };

  const encrypted = encrypt(JSON.stringify(payload), key);

  res.cookie(SESSION_COOKIE_NAME, encrypted, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  });

  platformLog("debug", "session_created", {
    sub: tokens.user.sub,
    ttlMinutes: Math.round(SESSION_MAX_AGE_MS / MS_PER_MINUTE)
  });
}

export function readSession(req) {
  const cookieHeader = req?.headers?.cookie;
  if (!cookieHeader) return null;

  
  const value = parseCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  if (!value) return null;

  let secret;
  try {
    secret = getSecret();
  } catch {
    return null;
  }

  const key = deriveKey(secret);
  const plaintext = decrypt(value, key);
  if (!plaintext) return null;

  try {
    const payload = JSON.parse(plaintext);
    if (!payload?.accessToken || !payload?.user?.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

export function clearSession(res) {
  res.cookie(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}



export function shouldRefreshSession(session) {
  if (!session || typeof session.issuedAt !== 'number') return false;
  const elapsed = Date.now() - session.issuedAt;
  const threshold = SESSION_MAX_AGE_MS * SESSION_MAX_AGE_REFRESH_RATIO;
  return elapsed > threshold;
}

export function refreshSession(res, session) {
  if (!session || !session.user?.sub) return;

  try {
    const key = deriveKey(getSecret());

    const now = Date.now();
    const oldRemainingMs = (session.issuedAt + SESSION_MAX_AGE_MS) - now;

    const payload = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken || null,
      issuedAt: now,
      expiresAt: session.expiresAt,
      user: {
        sub: session.user.sub,
        email: session.user.email || null,
        name: session.user.name || null,
      }
    };

    const encrypted = encrypt(JSON.stringify(payload), key);

    res.cookie(SESSION_COOKIE_NAME, encrypted, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS,
    });

    platformLog("debug", "session_refreshed", {
      sub: session.user.sub,
      oldRemainingMinutes: Math.round(oldRemainingMs / MS_PER_MINUTE),
      newTtlMinutes: Math.round(SESSION_MAX_AGE_MS / MS_PER_MINUTE)
    });
  } catch (err) {
    platformLog("debug", "session_refresh_failed", {
      sub: session.user?.sub,
      error: err.message
    });
    
    
    
  }
}



const SESSION_EXPIRING_THRESHOLD_MS = Math.round(SESSION_MAX_AGE_MS / 4);

export function isSessionExpiring(session, thresholdMs = SESSION_EXPIRING_THRESHOLD_MS) {
  if (!session) return true;
  if (typeof session.expiresAt !== 'number') return true;
  return session.expiresAt - Date.now() <= thresholdMs;
}



function parseCookieValue(cookieHeader, name) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;

  const prefix = name + '=';
  const cookies = cookieHeader.split(';');

  for (const cookie of cookies) {
    const trimmed = cookie.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.substring(prefix.length);
      return value || null;
    }
  }

  return null;
}
