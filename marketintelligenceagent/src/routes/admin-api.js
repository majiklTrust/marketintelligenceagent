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

import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTenantResolver } from "../tenant/resolver.js";
import { requirePermission, requireNoDevBypass } from "../tenant/permissions.js";
import { withTenant } from "../db/with-tenant.js";
import { platformLog } from "../services/platform-log.js";
import {
  createInvite,
  listPendingInvites,
  revokeInvite
} from "../tenant/invite-store.js";

const router = Router();

const { requireAuth } = createAuthMiddleware(platformLog);
const resolveTenant = createTenantResolver();


router.use(requireAuth);
router.use(resolveTenant);
router.use(requireNoDevBypass());
router.use(requirePermission("manage_users"));


const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_INVITE_ROLES = ["editor", "viewer"];






router.post("/invites", async (req, res) => {
  try {
    const { email, role } = req.body || {};

    if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({ error: "Valid email address required" });
    }
    if (!role || !VALID_INVITE_ROLES.includes(role)) {
      return res.status(400).json({
        error: `Role must be one of: ${VALID_INVITE_ROLES.join(", ")}`
      });
    }

    const invite = await withTenant(req.tenant.id, async () => {
      return createInvite({
        email: email.trim(),
        role,
        invitedBy: req.user.sub
      });
    });

    res.status(201).json(invite);
  } catch (err) {
    
    if (err.code === "23505") {
      return res.status(409).json({ error: "A pending invite already exists for this email" });
    }
    platformLog("error", "invite_create_failed", { error: err.message });
    res.status(500).json({ error: "Failed to create invite" });
  }
});


router.get("/invites", async (req, res) => {
  try {
    const invites = await withTenant(req.tenant.id, async () => {
      return listPendingInvites();
    });
    res.json({ invites });
  } catch (err) {
    platformLog("error", "invite_list_failed", { error: err.message });
    res.status(500).json({ error: "Failed to list invites" });
  }
});


router.delete("/invites/:id", async (req, res) => {
  try {
    const revoked = await withTenant(req.tenant.id, async () => {
      return revokeInvite(req.params.id);
    });
    if (!revoked) {
      return res.status(404).json({ error: "Invite not found or already claimed/revoked" });
    }
    res.json({ success: true });
  } catch (err) {
    platformLog("error", "invite_revoke_failed", { error: err.message });
    res.status(500).json({ error: "Failed to revoke invite" });
  }
});






router.get("/members", async (req, res) => {
  try {
    const { query } = await import("../db/pool.js");
    const r = await query(
      `SELECT m.id, m.auth_provider::text, m.auth_sub, m.role::text, m.created_at
       FROM memberships m
       WHERE m.tenant_id = $1
       ORDER BY m.created_at`,
      [req.tenant.id]
    );
    res.json({ members: r.rows });
  } catch (err) {
    platformLog("error", "members_list_failed", { error: err.message });
    res.status(500).json({ error: "Failed to list members" });
  }
});


router.patch("/members/:id", async (req, res) => {
  try {
    const { role } = req.body || {};
    if (!role || !VALID_INVITE_ROLES.includes(role)) {
      return res.status(400).json({
        error: `Role must be one of: ${VALID_INVITE_ROLES.join(", ")}`
      });
    }

    const { query } = await import("../db/pool.js");

    
    const target = await query(
      `SELECT id, auth_sub, role::text FROM memberships WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }

    
    if (target.rows[0].auth_sub === req.user.sub) {
      return res.status(400).json({ error: "Cannot change your own role" });
    }

    
    if (target.rows[0].role === "owner") {
      return res.status(400).json({ error: "This member cannot be modified" });
    }

    const r = await query(
      `UPDATE memberships SET role = $1::member_role WHERE id = $2 AND tenant_id = $3
       RETURNING id, auth_sub, role::text`,
      [role, req.params.id, req.tenant.id]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }
    res.json(r.rows[0]);
  } catch (err) {
    platformLog("error", "member_role_change_failed", { error: err.message });
    res.status(500).json({ error: "Failed to change role" });
  }
});


router.delete("/members/:id", async (req, res) => {
  try {
    const { query } = await import("../db/pool.js");

    
    const target = await query(
      `SELECT id, auth_sub, role::text FROM memberships WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: "Member not found" });
    }

    
    if (target.rows[0].auth_sub === req.user.sub) {
      return res.status(400).json({ error: "Cannot remove yourself" });
    }

    
    if (target.rows[0].role === "owner") {
      return res.status(400).json({ error: "This member cannot be removed" });
    }

    await query(
      `DELETE FROM memberships WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.tenant.id]
    );
    res.json({ success: true });
  } catch (err) {
    platformLog("error", "member_remove_failed", { error: err.message });
    res.status(500).json({ error: "Failed to remove member" });
  }
});

export default router;
