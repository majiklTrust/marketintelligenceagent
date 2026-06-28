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

import { isAuthEnabled, getProviders, getJwksMap, getIssuers, getSnapshotByIssuer } from "./index.js";
import { verifyToken } from "./jwt-verifier.js";
import { readSession, shouldRefreshSession, refreshSession, SESSION_COOKIE_NAME, MS_PER_MINUTE, SESSION_MAX_AGE_MS } from "./session.js";
import { platformLog } from "../services/platform-log.js";




const ERR_NO_TOKEN       = { status: 401, error: "Authentication required." };
const ERR_BAD_FORMAT     = { status: 401, error: "Invalid authorization header format." };
const ERR_TOKEN_EXPIRED  = { status: 401, error: "Token expired. Please log in again." };
const ERR_TOKEN_INVALID  = { status: 401, error: "Invalid token." };
const ERR_ISSUER_UNKNOWN = { status: 401, error: "Token issuer not recognized." };
const ERR_INTERNAL       = { status: 500, error: "Authentication check failed." };



function isDevBypass(req) {
  if (process.env.NODE_ENV !== 'dev') return false;

  const bypassOrigins = process.env.DEV_BYPASS_ORIGINS;
  if (!bypassOrigins) return false;

  const allowed = bypassOrigins.split(',').map(o => o.trim()).filter(Boolean);
  if (allowed.length === 0) return false;

  
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) return true;

  
  
  if (!origin) {
    const proto = req.protocol || 'http';
    const host = req.headers.host;
    if (host) {
      const effective = `${proto}://${host}`;
      if (allowed.includes(effective)) return true;
    }
  }

  return false;
}



function syntheticDevUser() {
  if (process.env.NODE_ENV === "production") {
    platformLog("warn", "synthetic_user_suppressed_in_prod", {})
    return null;
  }
  const sub = process.env.DEV_BYPASS_SUB;
  if (!sub || typeof sub !== 'string' || sub.trim().length === 0) return null;
  return {
    sub: sub.trim(),
    email: null,
    name: 'Dev Bypass User',
    authMethod: 'dev-bypass'
  };
}



function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;

  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return undefined; 
  }

  return parts[1];
}





function decodeTokenIssuer(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );

    return payload.iss || null;
  } catch {
    return null;
  }
}



export function createAuthMiddleware(logFn) {

  
  
  
  
  
  
  
  
  
  
  
  
  async function safeLog(level, action, details) {
    if (!logFn) return;
    try {
      const result = logFn(level, action, details);
      if (result && typeof result.then === "function") {
        await result.catch(() => {});
      }
    } catch {
      
      
    }
  }

    async function requireAuth(req, res, next) {
    
    
    
    
    if (!isAuthEnabled()) {
      req.user = syntheticDevUser();
      req.authSkipped = true;
      req.devBypass = !!req.user;
      return next();
    }

    
    
    
    
    if (isDevBypass(req)) {
      req.user = syntheticDevUser();
      req.authSkipped = true;
      req.devBypass = true;
      return next();
    }

    
    
    
    try {
      const session = readSession(req);
      if (session && session.user && session.user.sub) {
        
        const sessionDeadline = (session.issuedAt || 0) + SESSION_MAX_AGE_MS;
        if (typeof session.issuedAt === 'number' && Date.now() > sessionDeadline) {
          platformLog("debug", "session_expired", {
            sub: session.user.sub,
            expiredAgoMinutes: Math.round((Date.now() - sessionDeadline) / MS_PER_MINUTE)
          });
          
        } else {
          req.user = {
            sub: session.user.sub,
            email: session.user.email || null,
            name: session.user.name || null,
            expiresAt: session.expiresAt ? new Date(session.expiresAt) : null,
            authMethod: 'session',
          };

          
          
          
          
          const isBackgroundPoll = req.headers['x-background-poll'] === '1';
          if (!isBackgroundPoll && shouldRefreshSession(session)) {
            const _json = res.json.bind(res);
            res.json = function (body) {
              refreshSession(res, session);
              return _json(body);
            };
          }

          return next();
        }
      }
    } catch {
      
    }

    
    const token = extractBearerToken(req);

    
    if (token === null) {
      return res.status(ERR_NO_TOKEN.status).json({ error: ERR_NO_TOKEN.error });
    }

    
    if (token === undefined) {
      return res.status(ERR_BAD_FORMAT.status).json({ error: ERR_BAD_FORMAT.error });
    }

    
    const issuer = decodeTokenIssuer(token);
    if (!issuer) {
      safeLog("warn", "auth_token_unreadable", { path: req.path });
      return res.status(ERR_TOKEN_INVALID.status).json({ error: ERR_TOKEN_INVALID.error });
    }

    
    const jwksMap = getJwksMap();
    const jwksUri = jwksMap.get(issuer);

    if (!jwksUri) {
      safeLog("warn", "auth_issuer_unknown", {
        path: req.path,
        issuer,
        knownIssuers: getIssuers()
      });
      return res.status(ERR_ISSUER_UNKNOWN.status).json({ error: ERR_ISSUER_UNKNOWN.error });
    }

    
    const snapshot = getSnapshotByIssuer(issuer);
    const audience = snapshot?.audience || null;

    
    try {
      const payload = await verifyToken(token, issuer, jwksUri, audience);

      
      req.user = {
        sub: payload.sub,
        email: payload.email || payload[`${issuer}email`] || null,
        name: payload.name || null,
        issuer: payload.iss,
        audience: payload.aud,
        expiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
        raw: payload,
        authMethod: 'bearer',
      };

      req.authProvider = snapshot?.name || "unknown";
      return next();

    } catch (err) {
      const code = err.message;

      if (code === "TOKEN_EXPIRED") {
        safeLog("info", "auth_token_expired", { path: req.path, issuer });
        return res.status(ERR_TOKEN_EXPIRED.status).json({ error: ERR_TOKEN_EXPIRED.error });
      }

      if (code === "JWKS_FETCH_FAILED") {
        safeLog("error", "auth_jwks_fetch_failed", { path: req.path, issuer, jwksUri });
        return res.status(ERR_INTERNAL.status).json({ error: ERR_INTERNAL.error });
      }

      
      safeLog("warn", "auth_token_rejected", {
        path: req.path,
        issuer,
        reason: code
      });

      return res.status(ERR_TOKEN_INVALID.status).json({ error: ERR_TOKEN_INVALID.error });
    }
  }

    async function optionalAuth(req, res, next) {
    
    if (!isAuthEnabled()) {
      req.user = syntheticDevUser();
      req.authSkipped = true;
      req.devBypass = !!req.user;
      return next();
    }

    
    if (isDevBypass(req)) {
      req.user = syntheticDevUser();
      req.authSkipped = true;
      req.devBypass = true;
      return next();
    }

    
    try {
      const session = readSession(req);
      if (session && session.user && session.user.sub) {
        
        const sessionDeadline = (session.issuedAt || 0) + SESSION_MAX_AGE_MS;
        if (typeof session.issuedAt === 'number' && Date.now() > sessionDeadline) {
          platformLog("debug", "session_expired", {
            sub: session.user.sub,
            expiredAgoMinutes: Math.round((Date.now() - sessionDeadline) / MS_PER_MINUTE)
          });
          
        } else {
          req.user = {
            sub: session.user.sub,
            email: session.user.email || null,
            name: session.user.name || null,
            expiresAt: session.expiresAt ? new Date(session.expiresAt) : null,
            authMethod: 'session',
          };

          
          
          const isBackgroundPoll = req.headers['x-background-poll'] === '1';
          if (!isBackgroundPoll && shouldRefreshSession(session)) {
            const _json = res.json.bind(res);
            res.json = function (body) {
              refreshSession(res, session);
              return _json(body);
            };
          }

          return next();
        }
      }
    } catch {
      
    }

    const token = extractBearerToken(req);

    
    if (token === null || token === undefined) {
      req.user = null;
      return next();
    }

    
    const issuer = decodeTokenIssuer(token);
    if (!issuer) {
      req.user = null;
      return next();
    }

    const jwksMap = getJwksMap();
    const jwksUri = jwksMap.get(issuer);
    if (!jwksUri) {
      req.user = null;
      return next();
    }

    const snapshot = getSnapshotByIssuer(issuer);
    const audience = snapshot?.audience || null;

    try {
      const payload = await verifyToken(token, issuer, jwksUri, audience);
      req.user = {
        sub: payload.sub,
        email: payload.email || null,
        name: payload.name || null,
        issuer: payload.iss,
        audience: payload.aud,
        expiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
        raw: payload,
        authMethod: 'bearer',
      };
      req.authProvider = snapshot?.name || "unknown";
    } catch {
      req.user = null;
    }

    return next();
  }

  return { requireAuth, optionalAuth };
}
