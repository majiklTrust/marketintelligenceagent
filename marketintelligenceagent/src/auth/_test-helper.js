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

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import http from "node:http";
import crypto from "node:crypto";

export async function createTestJWKS(options = {}) {
  const port = options.port || 0;
  const issuer = options.issuer || "https://test-issuer.local/";
  const audience = options.audience || "https://marketintelligence-agent-api";

  
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = crypto.randomBytes(8).toString("hex");

  
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";

  const jwksResponse = JSON.stringify({ keys: [publicJwk] });

  
  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(jwksResponse);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  await new Promise((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  const actualPort = server.address().port;
  const jwksUri = `http://127.0.0.1:${actualPort}/.well-known/jwks.json`;

  return {
    issuer,
    audience,
    jwksUri,
    port: actualPort,
    kid,

        async signToken(claims = {}, overrides = {}) {
      const now = Math.floor(Date.now() / 1000);

      const jwt = new SignJWT({
        sub: claims.sub || "test_user_001",
        email: claims.email || "test@example.com",
        name: claims.name || "Test User",
        ...claims
      })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(overrides.issuer || issuer)
        .setAudience(overrides.audience || audience)
        .setIssuedAt(overrides.iat || now)
        .setExpirationTime(overrides.exp || now + 3600);

      return jwt.sign(privateKey);
    },

        async signExpiredToken(claims = {}) {
      const past = Math.floor(Date.now() / 1000) - 3600;
      return this.signToken(claims, { iat: past - 3600, exp: past });
    },

        async signWrongIssuerToken(claims = {}) {
      return this.signToken(claims, { issuer: "https://evil-issuer.com/" });
    },

        async signWrongAudienceToken(claims = {}) {
      return this.signToken(claims, { audience: "https://wrong-api" });
    },

        fabricateToken() {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({
        sub: "fake", iss: issuer, aud: audience,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600
      })).toString("base64url");
      const fakeSig = crypto.randomBytes(64).toString("base64url");
      return `${header}.${payload}.${fakeSig}`;
    },

        async close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}
