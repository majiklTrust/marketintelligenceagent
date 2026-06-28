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

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = path.join(__dirname, "providers");
























const REQUIRED_FIELDS = ["name", "type", "priority", "issuer", "jwksUri", "audience", "clientId"];
const REQUIRED_METHODS = ["isConfigured", "init", "getRoutes", "getLoginUrl", "exchangeCode", "getUserInfo", "getLogoutUrl"];



const activeProviders = new Map();
let registryInitialized = false;
let authRequired = false;







const INIT_TIMEOUT_MS = 10_000;








const providerSnapshots = new Map();



function validateProviderInterface(provider, filename) {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (provider[field] === undefined || provider[field] === null || provider[field] === "") {
      errors.push(`missing field: ${field}`);
    }
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== "function") {
      errors.push(`missing or non-function method: ${method}`);
    }
  }

  if (provider.name && typeof provider.name !== "string") {
    errors.push("name must be a string");
  }

  if (provider.type && !["oidc", "saml"].includes(provider.type)) {
    errors.push(`type must be 'oidc' or 'saml', got '${provider.type}'`);
  }

  if (provider.priority !== undefined && typeof provider.priority !== "number") {
    errors.push("priority must be a number");
  }

  return errors;
}



async function discoverProviderFiles() {
  if (!existsSync(PROVIDERS_DIR)) {
    return [];
  }

  const files = await readdir(PROVIDERS_DIR);
  return files
    .filter(f => f.endsWith(".js") && !f.startsWith("_") && !f.startsWith("."))
    .sort();
}

async function loadProvider(filename) {
  const filepath = path.join(PROVIDERS_DIR, filename);

  try {
    const module = await import(filepath);
    const provider = module.default;

    if (!provider) {
      return { status: "skip", reason: "no default export", filename };
    }

    
    if (typeof provider.isConfigured === "function" && !provider.isConfigured()) {
      return { status: "inactive", reason: "env vars not configured", filename, name: provider.name || filename };
    }

    
    const errors = validateProviderInterface(provider, filename);
    if (errors.length > 0) {
      return { status: "invalid", reason: errors.join("; "), filename, name: provider.name || filename };
    }

    return { status: "ready", provider, filename };
  } catch (err) {
    return { status: "error", reason: err.message, filename };
  }
}



export async function initRegistry(logFn) {
  if (registryInitialized) {
    return { providers: activeProviders, authEnabled: activeProviders.size > 0, results: [] };
  }

  const isProduction = process.env.NODE_ENV === "production";
  authRequired = isProduction;

  const results = [];
  const files = await discoverProviderFiles();

  if (logFn) {
    logFn("info", "auth_registry_scan", {
      providersDir: PROVIDERS_DIR,
      filesFound: files.length,
      environment: process.env.NODE_ENV || "(unset)"
    });
  }

  for (const file of files) {
    const result = await loadProvider(file);
    results.push(result);

    if (result.status === "ready") {
      const providerName = result.provider.name;

      
      
      
      
      
      
      
      
      
      if (activeProviders.has(providerName)) {
        
        activeProviders.delete(providerName);
        providerSnapshots.delete(providerName);

        result.status = "duplicate";
        result.reason = `duplicate provider name "${providerName}" — both providers evicted for safety`;

        if (logFn) {
          logFn("error", "auth_provider_duplicate", {
            filename: result.filename,
            name: providerName,
            reason: result.reason
          });
        }
        continue;
      }

      try {
        
        
        
        
        
        
        
        await Promise.race([
          result.provider.init(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("INIT_TIMEOUT")), INIT_TIMEOUT_MS)
          )
        ]);

        
        
        
        
        
        
        
        const snapshot = Object.freeze({
          issuer: result.provider.issuer,
          jwksUri: result.provider.jwksUri,
          audience: result.provider.audience,
          clientId: result.provider.clientId,
          name: result.provider.name,
          type: result.provider.type,
          priority: result.provider.priority
        });
        providerSnapshots.set(providerName, snapshot);

        activeProviders.set(providerName, result.provider);

        if (logFn) {
          logFn("info", "auth_provider_loaded", {
            name: snapshot.name,
            type: snapshot.type,
            issuer: snapshot.issuer,
            priority: snapshot.priority
          });
        }
      } catch (err) {
        result.status = "init_failed";
        result.reason = err.message;

        if (logFn) {
          logFn("error", "auth_provider_init_failed", {
            name: result.provider.name,
            error: err.message
          });
        }
      }
    } else if (logFn) {
      logFn("info", "auth_provider_skipped", {
        filename: result.filename,
        status: result.status,
        reason: result.reason,
        name: result.name || null
      });
    }
  }

  
  if (isProduction && activeProviders.size === 0) {
    const msg = "[FATAL] No auth providers configured. Set AUTH0_DOMAIN or WORKOS_API_KEY in environment.";
    if (logFn) {
      logFn("error", "auth_registry_fatal", { message: msg });
    }
    throw new Error(msg);
  }

  if (activeProviders.size === 0 && logFn) {
    logFn("warn", "auth_registry_no_providers", {
      message: "No auth providers active — running without authentication."
    });
  }

  registryInitialized = true;

  return {
    providers: activeProviders,
    authEnabled: activeProviders.size > 0,
    results
  };
}

export function getProviders() {
  return [...activeProviders.values()].sort((a, b) => a.priority - b.priority);
}

export function getProvider(name) {
  return activeProviders.get(name) || null;
}

export function getDefaultProvider() {
  const sorted = getProviders();
  return sorted.length > 0 ? sorted[0] : null;
}

export function getJwksMap() {
  const map = new Map();
  for (const snapshot of providerSnapshots.values()) {
    map.set(snapshot.issuer, snapshot.jwksUri);
  }
  return map;
}

export function getIssuers() {
  return [...providerSnapshots.values()].map(s => s.issuer);
}

export function getSnapshotByIssuer(issuer) {
  for (const snapshot of providerSnapshots.values()) {
    if (snapshot.issuer === issuer) return snapshot;
  }
  return null;
}

export function isAuthEnabled() {
  return activeProviders.size > 0;
}

export function isAuthRequired() {
  return authRequired;
}

export async function shutdownRegistry(logFn) {
  for (const [name, provider] of activeProviders) {
    if (typeof provider.shutdown === "function") {
      try {
        await provider.shutdown();
        if (logFn) logFn("info", "auth_provider_shutdown", { name });
      } catch (err) {
        if (logFn) logFn("error", "auth_provider_shutdown_error", { name, error: err.message });
      }
    }
  }
  activeProviders.clear();
  providerSnapshots.clear();
  registryInitialized = false;
}

export function _resetForTesting() {
  activeProviders.clear();
  providerSnapshots.clear();
  registryInitialized = false;
  authRequired = false;
}

export function _patchSnapshotForTesting(providerName, overrides) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("_patchSnapshotForTesting cannot be used in production");
  }
  const existing = providerSnapshots.get(providerName);
  if (!existing) {
    throw new Error(`No snapshot found for provider "${providerName}"`);
  }
  providerSnapshots.set(providerName, Object.freeze({ ...existing, ...overrides }));
}



export const PROVIDER_INTERFACE = {
  fields: [...REQUIRED_FIELDS],
  methods: [...REQUIRED_METHODS]
};
