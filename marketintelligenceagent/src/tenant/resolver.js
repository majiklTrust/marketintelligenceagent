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

import { findTenantByAuthIdentity, findPendingInviteByEmail, claimInvite } from "./platform-db.js";
import { platformLog } from "../services/platform-log.js";

export function createTenantResolver() {
  return async function tenantResolver(req, res, next) {
    
    if (!req.user || !req.user.sub) {
      res.status(403).json({ error: "Authentication required for tenant resolution" });
      return;
    }

    
    
    
    const provider = req.user.provider || inferProvider(req.user.sub);
    if (!provider) {
      res.status(403).json({ error: "Unable to determine auth provider" });
      return;
    }

    
    const tenant = await findTenantByAuthIdentity(provider, req.user.sub);
    if (tenant) {
      req.tenant = tenant;
      return next();
    }

    
    
    
    
    
    
    
    const email = req.user.email;

    platformLog("info", "tenant_resolve_attempt", {
      sub: req.user.sub,
      email: email || "(null)",
      provider,
      path1_found: false
    });

    if (email) {
      try {
        const invite = await findPendingInviteByEmail(email);

        platformLog("info", "tenant_resolve_invite_lookup", {
          email,
          inviteFound: !!invite,
          inviteId: invite?.id || null,
          inviteTenant: invite?.tenant_id || null
        });

        if (invite) {
          const claimed = await claimInvite(invite.id, provider, req.user.sub);

          platformLog("info", "tenant_resolve_claim_result", {
            inviteId: invite.id,
            claimed: !!claimed,
            tenantId: claimed?.id || null
          });

          if (claimed) {
            req.tenant = claimed;
            req.inviteClaimed = true;
            return next();
          }
        }
      } catch (claimErr) {
        
        
        
        platformLog("warn", "invite_claim_failed", {
          email,
          error: claimErr.message
        });
      }
    } else {
      platformLog("warn", "tenant_resolve_no_email", {
        sub: req.user.sub,
        provider,
        reason: "req.user.email is null — invite claim path skipped"
      });
    }

    res.status(403).json({ error: "No tenant membership for this identity" });
  };
}





function inferProvider(sub) {
  if (!sub || typeof sub !== "string") return null;
  if (sub.startsWith("auth0|") || sub.startsWith("google-oauth2|")) {
    return "auth0";
  }
  if (sub.startsWith("user_")) {
    return "workos";
  }
  return null;
}
