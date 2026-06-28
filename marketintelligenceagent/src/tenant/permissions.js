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

import { hasPermission } from "./platform-db.js";

export function requirePermission(permission) {
  return async function permissionCheck(req, res, next) {
    
    
    const role = req.tenant?.role;
    if (!role) {
      return res.status(403).json({ error: "Permission denied" });
    }

    try {
      const allowed = await hasPermission(role, permission);
      if (!allowed) {
        return res.status(403).json({ error: "Permission denied" });
      }
      next();
    } catch {
      
      
      
      return res.status(500).json({ error: "Permission check failed" });
    }
  };
}

export function requireNoDevBypass() {
  return function devBypassBlock(req, res, next) {
    if (req.devBypass) {
      return res.status(403).json({ error: "Permission denied" });
    }
    next();
  };
}
