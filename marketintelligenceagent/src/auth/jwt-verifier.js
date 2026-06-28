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

import { createRemoteJWKSet, jwtVerify, errors } from "jose";





const jwksSets = new Map();

function getJwksSet(jwksUri) {
  if (!jwksSets.has(jwksUri)) {
    jwksSets.set(jwksUri, createRemoteJWKSet(new URL(jwksUri)));
  }
  return jwksSets.get(jwksUri);
}









const MAX_TOKEN_BYTES = 16_384;

export async function verifyToken(token, issuer, jwksUri, audience) {
  if (!token) {
    throw new Error("TOKEN_MISSING");
  }

  if (typeof token === "string" && Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    throw new Error("TOKEN_INVALID");
  }

  if (!issuer || !jwksUri) {
    throw new Error("VERIFIER_MISCONFIGURED");
  }

  try {
    const jwks = getJwksSet(jwksUri);

    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience,
      clockTolerance: 30  
    });

    return payload;
  } catch (err) {
    
    
    if (err instanceof errors.JWTExpired) {
      throw new Error("TOKEN_EXPIRED");
    }
    if (err instanceof errors.JWTClaimValidationFailed) {
      const claim = err.claim || "unknown";
      if (claim === "iss") throw new Error("TOKEN_INVALID_ISSUER");
      if (claim === "aud") throw new Error("TOKEN_INVALID_AUDIENCE");
      throw new Error("TOKEN_CLAIM_INVALID");
    }
    if (err instanceof errors.JWSSignatureVerificationFailed) {
      throw new Error("TOKEN_SIGNATURE_INVALID");
    }
    if (err instanceof errors.JWKSNoMatchingKey) {
      throw new Error("TOKEN_KEY_NOT_FOUND");
    }
    if (err instanceof errors.JWKSTimeout || err.code === "ERR_JOSE_GENERIC") {
      throw new Error("JWKS_FETCH_FAILED");
    }

    
    throw new Error("TOKEN_INVALID");
  }
}

export function clearJwksCache() {
  jwksSets.clear();
}













