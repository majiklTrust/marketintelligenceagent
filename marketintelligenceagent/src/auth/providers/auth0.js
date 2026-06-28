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
import { createRequire } from "node:module";
import { decryptPlatformSecret } from "../../services/platform-secret.js";
import { platformLog } from "../../services/platform-log.js";
const require = createRequire(import.meta.url);










const BLOCKED_DOMAIN_PATTERNS = [
  /^10\.\d+\.\d+\.\d+$/,                                      
  /^127\.\d+\.\d+\.\d+$/,                                     
  /^192\.168\.\d+\.\d+$/,                                      
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,                      
  /^0\.0\.0\.0$/,
  /^localhost$/i,
  /^\[?::1\]?$/,                                               
  /^169\.254\.\d+\.\d+$/,                                      
  /^metadata\./i,                                               
  /^kubernetes\./i,                                             
  /[@\\]/,                                                      
];

function isDomainBlocked(domain) {
  return BLOCKED_DOMAIN_PATTERNS.some(pattern => pattern.test(domain));
}








function isRedirectUriSafe(uri) {
  if (!uri) return true; 
  if (uri.startsWith("http://localhost")) return true;
  if (uri.startsWith("http://127.0.0.1")) return true;
  if (uri.startsWith("https://")) return true;
  return false;
}






function isSameOrigin(candidate, base) {
  if (typeof candidate !== "string" || typeof base !== "string" || !base) return false;
  try {
    return new URL(candidate).origin === new URL(base).origin;
  } catch {
    return false;
  }
}







const _decCache = new Map();
function decEnv(name) {
  const cipher = (process.env[name] || "").trim();
  if (!cipher) return "";
  if (_decCache.has(cipher)) return _decCache.get(cipher);
  let plain = "";
  try {
    plain = decryptPlatformSecret(cipher);
  } catch {
    plain = "";
  }
  _decCache.set(cipher, plain);
  return plain;
}

function getConfig() {
  const isProd = process.env.NODE_ENV === "production";
  const domain = (process.env.AUTH0_DOMAIN || "").trim();
  const clientId = decEnv("AUTH0_CLIENT_ID");
  const clientSecret = decEnv("AUTH0_CLIENT_SECRET");
  const audience = (process.env.AUTH0_AUDIENCE || "https://marketintelligence-agent-api").trim();
  const port = process.env.DASHBOARD_PORT || "3001";

  
  
  
  const origin = (process.env.AUTH0_PUBLIC_ORIGIN
    || (isProd ? "" : `http://localhost:${port}`)).trim();

  // Explicit AUTH0_REDIRECT_URI / AUTH0_LOGOUT_URI override the origin-derived
  // values when set; otherwise they are built from the origin.
  const redirectUri = (process.env.AUTH0_REDIRECT_URI || (origin ? `${origin}/auth/callback` : "")).trim();
  const logoutUri   = (process.env.AUTH0_LOGOUT_URI   || (origin ? `${origin}/` : "")).trim();
  const scopes = (process.env.AUTH0_SCOPES || "openid profile email").trim();

  
  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");

  return {
    domain: cleanDomain,
    clientId,
    clientSecret,
    audience,
    redirectUri,
    logoutUri,
    scopes,
    baseUrl: `https://${cleanDomain}`,
    issuer: `https://${cleanDomain}/`,
    jwksUri: `https://${cleanDomain}/.well-known/jwks.json`,
    authorizationUrl: `https://${cleanDomain}/authorize`,
    tokenUrl: `https://${cleanDomain}/oauth/token`,
    userInfoUrl: `https://${cleanDomain}/userinfo`,
    logoutUrl: `https://${cleanDomain}/v2/logout`,
    openidConfigUrl: `https://${cleanDomain}/.well-known/openid-configuration`
  };
}
// ── State Management ─────────────────────────────────────────
// Self-contained CSRF state for the Auth0 OAuth flow.
// Separate from the LinkedIn OAuth state in security.js —
// each provider manages its own state to remain independent.

const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function generateState() {
  const state = crypto.randomBytes(32).toString("hex");
  pendingStates.set(state, Date.now());

  
  for (const [key, ts] of pendingStates) {
    if (Date.now() - ts > STATE_TTL_MS) pendingStates.delete(key);
  }

  return state;
}

function validateState(state) {
  if (!state || !pendingStates.has(state)) return false;
  const ts = pendingStates.get(state);
  pendingStates.delete(state);
  return (Date.now() - ts) <= STATE_TTL_MS;
}



let discoveryCache = null;
let discoveryCacheTs = 0;
const DISCOVERY_TTL_MS = 60 * 60 * 1000; 

async function fetchDiscovery(config) {
  if (discoveryCache && (Date.now() - discoveryCacheTs) < DISCOVERY_TTL_MS) {
    return discoveryCache;
  }

  
  
  
  
  
  
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(config.openidConfigUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Auth0 OIDC discovery failed: ${res.status} ${res.statusText}`);
    }

    discoveryCache = await res.json();
    discoveryCacheTs = Date.now();
    return discoveryCache;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}



let initialized = false;
let initConfig = null;



const auth0Provider = {

  

  get name()     { return "auth0"; },
  get type()     { return "oidc"; },
  get priority() { return 10; },
  get issuer()   { return getConfig().issuer; },
  get jwksUri()  { return getConfig().jwksUri; },
  get audience() { return getConfig().audience; },
  get clientId() { return getConfig().clientId; },

  

  isConfigured() {
    const { domain, clientId, clientSecret, redirectUri, logoutUri } = getConfig();
    if (!(domain && clientId && clientSecret)) return false;

    
    
    
    
    if (!redirectUri || !logoutUri) return false;

    
    
    
    
    
    
    
    if (isDomainBlocked(domain)) return false;

    
    
    
    
    
    
    if (!isRedirectUriSafe(redirectUri)) return false;

    return true;
  },

  
  
  

  async init() {
    const config = getConfig();

    
    
    
    platformLog("info", "auth0_config_resolved", {
      domain: config.domain || "(empty)",
      redirectUri: config.redirectUri || "(empty)",
      logoutUri: config.logoutUri || "(empty)",
      credentialsConfigured: Boolean(config.clientId && config.clientSecret)
    });

    
    const missing = [];
    if (!config.domain)       missing.push("AUTH0_DOMAIN");
    if (!config.clientId)     missing.push("AUTH0_CLIENT_ID");
    if (!config.clientSecret) missing.push("AUTH0_CLIENT_SECRET");
    if (!config.redirectUri)  missing.push("AUTH0_REDIRECT_URI (or AUTH0_PUBLIC_ORIGIN)");
    if (!config.logoutUri)    missing.push("AUTH0_LOGOUT_URI (or AUTH0_PUBLIC_ORIGIN)");

    if (missing.length > 0) {
      throw new Error(`Auth0 provider missing required env vars: ${missing.join(", ")}`);
    }

    
    if (config.domain.includes(" ") || !config.domain.includes(".")) {
      throw new Error(`Auth0 domain appears invalid: "${config.domain}". Expected format: your-tenant.auth0.com`);
    }

    
    try {
      await fetchDiscovery(config);
    } catch (err) {
      
      
      console.warn(`[AUTH0] OIDC discovery fetch failed during init: ${err.message}`);
      console.warn("[AUTH0] Will retry on first authentication attempt.");
    }

    initConfig = config;
    initialized = true;
  },

  
  
  
  
  

  getRoutes() {
    const { Router } = require("express");
    const router = Router();

    
    router.get("/auth/login", (req, res) => {
      const state = generateState();
      const url = auth0Provider.getLoginUrl(state);
      res.redirect(url);
    });

    
    router.get("/auth/callback", async (req, res) => {
      const { code, error, error_description, state } = req.query;

      
      if (!validateState(state)) {
        return res.status(403).json({
          error: "Invalid or expired authentication state. Please try logging in again."
        });
      }

      
      if (error) {
        return res.status(400).json({
          error: "Authentication failed.",
          detail: error_description || error
        });
      }

      if (!code) {
        return res.status(400).json({
          error: "Missing authorization code."
        });
      }

      try {
        const tokens = await auth0Provider.exchangeCode(code);
        const user = await auth0Provider.getUserInfo(tokens.accessToken);

        
        
        
        
        res.json({
          success: true,
          user: {
            sub: user.sub,
            name: user.name,
            email: user.email,
            emailVerified: user.email_verified
          },
          tokens: {
            accessToken: tokens.accessToken,
            expiresIn: tokens.expiresIn,
            tokenType: tokens.tokenType
            
            
          }
        });
      } catch (err) {
        
        
        platformLog("error", "auth0_callback_failed", { message: err.message });
        res.status(500).json({
          error: "Token exchange failed. Check server logs."
        });
      }
    });

    
    router.get("/auth/logout", (req, res) => {
      const cfg = getConfig();
      const requested = req.query.returnTo;
      
      
      
      
      const returnTo = isSameOrigin(requested, cfg.logoutUri) ? requested : cfg.logoutUri;
      const url = auth0Provider.getLogoutUrl(returnTo);
      res.redirect(url);
    });

    return router;
  },

  

  getLoginUrl(state) {
    const config = getConfig();
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes,
      audience: config.audience,
      state: state || generateState()
    });
    return `${config.authorizationUrl}?${params.toString()}`;
  },

  

  async exchangeCode(code) {
    const config = getConfig();

    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Auth0 token exchange failed: ${res.status} — ${body.substring(0, 200)}`);
    }

    const data = await res.json();

    return {
      accessToken: data.access_token,
      idToken: data.id_token || null,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      refreshToken: data.refresh_token || null,
      scope: data.scope || null
    };
  },

  

  async getUserInfo(accessToken) {
    const config = getConfig();

    const res = await fetch(config.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Auth0 userinfo failed: ${res.status} — ${body.substring(0, 200)}`);
    }

    const data = await res.json();

    return {
      sub: data.sub,
      name: data.name || data.nickname || null,
      email: data.email || null,
      emailVerified: data.email_verified || false,
      picture: data.picture || null,
      provider: "auth0",
      raw: data
    };
  },

  

  getLogoutUrl(returnTo) {
    const config = getConfig();
    const params = new URLSearchParams({
      client_id: config.clientId,
      returnTo: returnTo || config.logoutUri
    });
    return `${config.logoutUrl}?${params.toString()}`;
  },

  

  async shutdown() {
    initialized = false;
    initConfig = null;
    discoveryCache = null;
    discoveryCacheTs = 0;
    pendingStates.clear();
  },

  

  _isInitialized() { return initialized; },
  _getConfig() { return getConfig(); },
  _getStateCount() { return pendingStates.size; },
  _generateState: generateState,
  _validateState: validateState,
  _getDiscoveryCache() { return discoveryCache; }
};

export default auth0Provider;
