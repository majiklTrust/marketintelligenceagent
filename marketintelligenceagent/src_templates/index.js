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

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import express from "express";
import cors from "cors";
const __dirname = path.dirname(fileURLToPath(import.meta.url));




export let app = null;









export function platformLog(level, action, details) {
  const upper = String(level || "info").toUpperCase();
  const payload = details === null || details === undefined ? "" : (
    typeof details === "string" ? details : JSON.stringify(details)
  );
  console.log(`[PLATFORM:${upper}] ${action}${payload ? " " + payload : ""}`);
}






export function createApp(ctx) {
  const {
    apiRoutes, adminRoutes, topicsRoutes, registrationRoutes, feedsRoutes, composeRoutes,
    getAuthorizationUrl, exchangeCodeForToken, getProfile,
    escapeHtml, generateOAuthState, validateOAuthState,
    isAuthEnabled, getDefaultProvider,
    createSession, readSession, clearSession,
    getServerAddress,
    logActivity,
    withTenant, findTenantByAuthIdentity, storeCredential,
    invalidateTokenCache,
    createPlatformAdminRoutes
  } = ctx;

  const instance = express();
  instance.disable("x-powered-by");
  instance.disable("etag");
  instance.set("trust proxy", true);

  
  instance.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "0");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
    res.setHeader("X-DNS-Prefetch-Control", "off");
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    res.setHeader("Content-Security-Policy",
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://unpkg.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "connect-src 'self'; " +
      "img-src 'self' data:; " +
      "font-src 'self' https://fonts.gstatic.com;"
    );
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  
  
  
  
  
  const normalizeOrigin = (s) => (s || "").trim().replace(/\/+$/, "");
  const allowedOrigins = [...new Set([
    ...(process.env.ALLOWED_ORIGINS || "").split(",").map(normalizeOrigin),
    normalizeOrigin(process.env.AUTH0_PUBLIC_ORIGIN),
    normalizeOrigin(getServerAddress().origin),
  ].filter(Boolean))];

  instance.use(cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(normalizeOrigin(origin))) {
        callback(null, true);
      } else {
        platformLog("warn", "cors_origin_rejected", { origin });
        callback(new Error("CORS: origin not allowed"));
      }
    },
    credentials: true,
  }));

  instance.use(express.json({ limit: "16kb" }));

  
  const dashboardHtml = path.join(__dirname, "../public/index.html");
  const alphaDir = path.join(__dirname, "../majikl-site");
  const alphaHtml = path.join(alphaDir, "index.html");

  
  
  
  
  
  
  
  
  
  
  
  
  const staticCacheHeaders = (res) => {
    res.setHeader("Cache-Control", "no-cache");
  };

  
  instance.use("/app/register", express.static(path.join(__dirname, "../public/register"), { index: "index.html", setHeaders: staticCacheHeaders }));

  
  instance.use("/app/feeds", express.static(path.join(__dirname, "../public/feeds"), { index: "index.html", setHeaders: staticCacheHeaders }));

  
  instance.use("/app/topics", express.static(path.join(__dirname, "../public/topics"), { index: "index.html", setHeaders: staticCacheHeaders }));

  
  
  instance.use("/app/admin", express.static(path.join(__dirname, "../public/admin"), { index: "index.html", setHeaders: staticCacheHeaders }));

  
  instance.use("/app/platform-admin", express.static(path.join(__dirname, "../public/platform-admin"), { index: "index.html", setHeaders: staticCacheHeaders }));

  instance.use("/app", express.static(path.join(__dirname, "../public"), { index: false, setHeaders: staticCacheHeaders }));
  instance.use(express.static(alphaDir, { index: false, setHeaders: staticCacheHeaders }));

  
  instance.get("/auth/login", (req, res) => {
    const provider = getDefaultProvider();
    if (!provider) {
      return res.status(503).send(`
        <h2>Authentication Not Available</h2>
        <p>No authentication provider is configured.</p>
        <a href="/">Back to home</a>
      `);
    }
    const state = generateOAuthState();
    const loginUrl = provider.getLoginUrl(state);
    res.redirect(loginUrl);
  });

  instance.get("/auth/callback", async (req, res) => {
    const { code, error, error_description, state } = req.query;

    if (error) {
      const safeError = escapeHtml(String(error));
      const safeDesc = escapeHtml(String(error_description || ""));
      return res.status(400).send(`
        <h2>Authentication Failed</h2>
        <p>${safeError}: ${safeDesc}</p>
        <a href="/">Back to home</a>
      `);
    }

    if (!validateOAuthState(state)) {
      return res.status(403).send(`
        <h2>Authorization Failed</h2>
        <p>Invalid or expired OAuth state. Please try again.</p>
        <a href="/">Back to home</a>
      `);
    }

    const provider = getDefaultProvider();
    if (!provider) {
      return res.status(503).send(`
        <h2>Authentication Not Available</h2>
        <p>No authentication provider is configured.</p>
      `);
    }

    try {
      // exchangeCode returns OAuth tokens only — no user identity.
      // getUserInfo fetches the user identity using the access token.
      // Both calls are required to populate the session payload that
      // createSession expects: { accessToken, refreshToken, expiresIn, user }.
      const tokens = await provider.exchangeCode(code);
      const user = await provider.getUserInfo(tokens.accessToken);
      createSession(res, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        user
      });

      // Log with tenant context — lookup membership for operational visibility.
      // Security: log email domain only (not full address), no tokens.
      let tenantInfo = { slug: null, role: null };
      try {
        const tenant = await findTenantByAuthIdentity(provider.name, user.sub);
        if (tenant) {
          tenantInfo = { slug: tenant.slug, role: tenant.role };
        }
      } catch { /* best-effort — don't block login on log enrichment */ }

      platformLog("info", "user_logged_in", {
        sub: user.sub,
        provider: provider.name,
        emailDomain: user.email ? user.email.split("@")[1] : null,
        tenant: tenantInfo.slug,
        role: tenantInfo.role,
        newUser: !tenantInfo.slug
      });
      return res.redirect("/app");
    } catch (err) {
      platformLog("error", "auth_callback_failed", {
        error: err.message,
        provider: provider.name
      });
      return res.status(500).send(`
        <h2>Authentication Failed</h2>
        <p>An error occurred during authentication. Please try again.</p>
        <a href="/">Back to home</a>
      `);
    }
  });

  instance.get("/auth/logout", (req, res) => {
    clearSession(res);

    const provider = getDefaultProvider();

    if (provider && typeof provider.getLogoutUrl === "function") {
      
      
      
      
      const logoutUrl = provider.getLogoutUrl();
      return res.redirect(logoutUrl);
    }

    res.redirect("/");
  });

  
  instance.get("/auth/linkedin/callback", async (req, res) => {
    const { code, error, state } = req.query;

    if (!validateOAuthState(state)) {
      return res.status(403).send(`
        <h2>Authorization Failed</h2>
        <p>Invalid or expired OAuth state. Please try again.</p>
        <a href="/app">Back to Dashboard</a>
      `);
    }

    if (error) {
      return res.send(`
        <h2>LinkedIn Authorization Failed</h2>
        <p>${escapeHtml(String(error))}: ${escapeHtml(String(req.query.error_description || ""))}</p>
        <a href="/app">Back to Dashboard</a>
      `);
    }

    
    
    
    
    
    
    
    
    
    
    
    
    const session = readSession(req);
    let userSub = session?.user?.sub || null;

    if (!userSub) {
      const devBypassActive = process.env.NODE_ENV === "dev"
        && !!process.env.DEV_BYPASS_ORIGINS;
      const bypassSub = process.env.DEV_BYPASS_SUB;
      if (devBypassActive && bypassSub && bypassSub.trim().length > 0) {
        userSub = bypassSub.trim();
        platformLog("info", "linkedin_callback_dev_bypass", { sub: userSub });
      }
    }

    if (!userSub) {
      return res.status(403).send(`
        <h2>Session Required</h2>
        <p>You must be logged in to connect LinkedIn. Your session may have expired.</p>
        <a href="/auth/login">Log In</a>
      `);
    }

    
    
    
    let provider = "auth0";
    if (userSub.startsWith("user_")) provider = "workos";
    let tenant = null;
    try {
      tenant = await findTenantByAuthIdentity(provider, userSub);
    } catch {
      
    }
    if (!tenant) {
      return res.status(403).send(`
        <h2>No Workspace Found</h2>
        <p>Your account is not associated with a workspace. Contact your administrator.</p>
        <a href="/app">Back to Dashboard</a>
      `);
    }

    try {
      
      
      
      
      
      
      
      await withTenant(tenant.id, async () => {
        const tokens = await exchangeCodeForToken(code);

        let profileName = "(unknown)";
        let personSub = null;
        try {
          const profile = await getProfile(tokens.accessToken);
          personSub = profile.sub;
          profileName = profile.name || "(unknown)";
        } catch (profileErr) {
          platformLog("warn", "oauth_profile_fetch_failed", { error: profileErr.message });
        }

        
        
        await storeCredential("linkedin_access_token", tokens.accessToken);
        if (personSub) {
          await storeCredential("linkedin_person_urn", `urn:li:person:${personSub}`);
        }

        platformLog("info", "linkedin_credentials_stored", {
          tenant: tenant.slug,
          user: userSub,
          profileName,
          hasPersonUrn: !!personSub
        });

        
        
        
        invalidateTokenCache(tenant.id);

        res.send(`
          <h2>LinkedIn Connected Successfully!</h2>
          <p>Logged in as: <strong>${escapeHtml(profileName)}</strong></p>
          ${!personSub ? '<p><em>Profile lookup failed. Token is valid but person URN was not saved. Retry auth to fix.</em></p>' : ''}
          <p>Credentials saved to your workspace.</p>
          <p><strong>Token expires in:</strong> ${Math.floor(tokens.expiresIn / 86400)} days</p>
          <p>Redirecting to dashboard...</p>
          <br>
          <a href="/app">Go to Dashboard</a>
          <script>setTimeout(function() { window.location.href = "/app"; }, 1500);</script>
        `);
      });
    } catch (err) {
      platformLog("error", "oauth_token_exchange_failed", { error: err.message });
      res.status(500).send(`
        <h2>Token Exchange Failed</h2>
        <p>An error occurred during authentication. Check the activity log.</p>
        <a href="/app">Back to Dashboard</a>
      `);
    }
  });

  instance.get("/auth/linkedin", (req, res) => {
    const state = generateOAuthState();
    res.redirect(getAuthorizationUrl(state));
  });

  
  
  
  
  
  instance.get("/auth/status", (req, res) => {
    res.setHeader("Cache-Control", "no-store, private, max-age=0");
    res.setHeader("Pragma", "no-cache");

    
    
    
    
    const devBypassActive = process.env.NODE_ENV === "dev"
      && !!process.env.DEV_BYPASS_ORIGINS;

    
    
    
    const authRequired = isAuthEnabled() && !devBypassActive;

    
    
    
    
    const session = readSession(req);
    let user = session?.user || null;
    if (!user && devBypassActive) {
      const sub = process.env.DEV_BYPASS_SUB;
      if (sub && sub.trim().length > 0) {
        user = { name: "Dev Bypass User", email: null, sub: sub.trim() };
      }
    }

    res.json({
      authenticated: !!user,
      authRequired,
      user: user ? { name: user.name || null, email: user.email || null } : null,
    });
  });

  
  instance.get("/app", (req, res) => res.sendFile(dashboardHtml));
  instance.get("/app/*", (req, res) => res.sendFile(dashboardHtml));
  instance.get("/", (req, res) => res.sendFile(alphaHtml));

  
  
  
  
  
  
  instance.use("/api/admin", adminRoutes);

  
  instance.use("/api/platform-admin", createPlatformAdminRoutes());

  
  
  
  instance.use("/api/topics", topicsRoutes);

  
  
  
  instance.use("/api/register", registrationRoutes);

  
  
  instance.use("/api/feeds", feedsRoutes);

  
  
  
  instance.use("/api/compose", composeRoutes);

  
  instance.use(apiRoutes);

  
  
  instance.use("/api", (req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  
  instance.use((err, req, res, next) => {
    if (!res.headersSent) {
      res.status(403).json({ error: "Forbidden" });
    }
  });

  return instance;
}














export async function buildAppForTests() {
  const { logActivity }                  = await import("./services/database.js");
  const { default: apiRoutes }           = await import("./routes/api.js");
  const { default: adminRoutes }         = await import("./routes/admin-api.js");
  const { default: topicsRoutes }        = await import("./routes/topics-api.js");
  const { default: registrationRoutes }  = await import("./routes/registration-api.js");
  const { default: feedsRoutes }          = await import("./routes/feeds-api.js");
  const { getAuthorizationUrl,
          exchangeCodeForToken,
          getProfile,
          invalidateTokenCache }         = await import("./services/linkedin-api.js");
  const { escapeHtml,
          generateOAuthState,
          validateOAuthState }           = await import("./services/security.js");
  const { initRegistry,
          isAuthEnabled,
          getDefaultProvider }           = await import("./auth/index.js");
  const { createSession,
          readSession,
          clearSession }                 = await import("./auth/session.js");
  const { getServerAddress }             = await import("./services/server-address.js");
  const { withTenant }                   = await import("./db/with-tenant.js");
  const { findTenantByAuthIdentity }     = await import("./tenant/platform-db.js");
  const { storeCredential }              = await import("./tenant/credential-store.js");
  const { default: createPlatformAdminRoutes } = await import("./routes/platform-admin-api.js");
  const { default: composeRoutes }       = await import("./routes/compose-api.js");

  
  
  await initRegistry(platformLog);

  return createApp({
    apiRoutes, adminRoutes, topicsRoutes, registrationRoutes, feedsRoutes, composeRoutes,
    getAuthorizationUrl, exchangeCodeForToken, getProfile,
    escapeHtml, generateOAuthState, validateOAuthState,
    isAuthEnabled, getDefaultProvider,
    createSession, readSession, clearSession,
    getServerAddress,
    logActivity,
    withTenant, findTenantByAuthIdentity, storeCredential,
    invalidateTokenCache,
    createPlatformAdminRoutes
  });
}






export async function start() {
  
  const envPath = path.resolve(__dirname, "../.env");
  const envResult = dotenv.config({ path: envPath, override: false });
  if (envResult.error) {
    console.error("[WARN] Could not load .env — falling back to OS environment variables.");
  }

  
  
  
  
  
  

  
  
  
  delete process.env.ENCRYPTION_SALT;
  delete process.env.ANTHROPIC_API_KEY_ENCRYPTED;

  
  const { connectionInfo }               = await import("./db/pool.js");
  const { logActivity }                  = await import("./services/database.js");
  const { startScheduler }               = await import("./services/scheduler.js");
  const { startMonitor }                 = await import("./services/news-monitor.js");
  const { startBatchPublisher }          = await import("./services/batch-publisher.js");
  const { default: apiRoutes }           = await import("./routes/api.js");
  const { default: adminRoutes }         = await import("./routes/admin-api.js");
  const { default: topicsRoutes }        = await import("./routes/topics-api.js");
  const { default: registrationRoutes }  = await import("./routes/registration-api.js");
  const { default: feedsRoutes }          = await import("./routes/feeds-api.js");
  const { getAuthorizationUrl,
          exchangeCodeForToken,
          getProfile,
          invalidateTokenCache }         = await import("./services/linkedin-api.js");
  const { escapeHtml,
          generateOAuthState,
          validateOAuthState }           = await import("./services/security.js");
  const { initRegistry,
          isAuthEnabled,
          getDefaultProvider }           = await import("./auth/index.js");
  const { createSession,
          readSession,
          clearSession }                 = await import("./auth/session.js");
  const { setBoundAddress,
          getServerAddress,
          getServerUrl }                 = await import("./services/server-address.js");
  const { withTenant }                   = await import("./db/with-tenant.js");
  const { findTenantByAuthIdentity }     = await import("./tenant/platform-db.js");
  const { storeCredential }              = await import("./tenant/credential-store.js");
  const { default: createPlatformAdminRoutes } = await import("./routes/platform-admin-api.js");
  const { default: composeRoutes }       = await import("./routes/compose-api.js");

  mkdirSync(path.join(__dirname, "../data"), { recursive: true });

  
  
  
  
  
  
  
  
  
  
  await initRegistry(platformLog);

  
  app = createApp({
    apiRoutes, adminRoutes, topicsRoutes, registrationRoutes, feedsRoutes, composeRoutes,
    getAuthorizationUrl, exchangeCodeForToken, getProfile,
    escapeHtml, generateOAuthState, validateOAuthState,
    isAuthEnabled, getDefaultProvider,
    createSession, readSession, clearSession,
    getServerAddress,
    logActivity,
    withTenant, findTenantByAuthIdentity, storeCredential,
    invalidateTokenCache,
    createPlatformAdminRoutes
  });

  
  const PORT = process.env.DASHBOARD_PORT || 3001;
  const server = app.listen(PORT, () => {
    setBoundAddress(server.address());
    const addr = getServerAddress();
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           LinkedIn AI Content Agent  {{VERSION}}
║
║           Mode:  ${(process.env.AGENT_MODE || "manual").toUpperCase().padEnd(0)}
║           Auth:  ${isAuthEnabled() ? "ENABLED" : "DISABLED (no providers configured)"}
║       Database:  ${connectionInfo.database}
║        DB User:  ${connectionInfo.user}
║            App:  ${addr.origin}
║            Env:  ${(process.env.NODE_ENV || "NODE_ENV not set").padEnd(0)}
║           ${process.env.DEV_BYPASS_ORIGINS}
╚═══════════════════════════════════════════════════════════╝
`);
    console.log(`🖥  Homepage at      ${addr.origin}/`);
    console.log(`🖥  Dashboard at     ${addr.origin}/app`);
    console.log(`🔗 LinkedIn auth at ${addr.origin}/auth/linkedin`);
    if (isAuthEnabled()) {
      console.log(`🔐 Auth0 login at   ${addr.origin}/auth/login`);
    }
    console.log("");

    startScheduler();
    // News monitor — iterates all active tenants each hour
    startMonitor();
    // Batch publisher — fires scheduled posts at their set time
    startBatchPublisher();
  });

  return { app, server };
}

// ═════════════════════════════════════════════════════════════
// Module guard — start() runs only when this file is invoked
// as the process entrypoint (node src/index.js), never when
// another module imports it. Tests import { createApp } without
// triggering startup.
// ═════════════════════════════════════════════════════════════
const isEntrypoint = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "");
if (isEntrypoint) {
  start().catch(err => {
    console.error("[FATAL] Startup failed.", err);
    process.exit(1);
  });
}
