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

import { currentClient } from "../db/with-tenant.js";

export async function createInvite({ email, role, invitedBy }) {
  const c = currentClient();
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@")[1] || "";

  const r = await c.query(
    `INSERT INTO invites (tenant_id, email, email_domain, role, invited_by, status)
     VALUES (current_tenant_id(), $1, $2, $3::member_role, $4, 'pending')
     RETURNING id, tenant_id, email, email_domain, role::text, invited_by,
               status::text, created_at, expires_at, claimed_at, claimed_by_sub`,
    [normalized, domain, role, invitedBy]
  );
  return r.rows[0];
}

/**
 * List pending invites for the current tenant.
 */
export async function listPendingInvites() {
  const c = currentClient();
  const r = await c.query(
    `SELECT id, email, email_domain, role::text, invited_by,
            status::text, created_at, expires_at
     FROM invites
     WHERE tenant_id = current_tenant_id()
       AND status = 'pending'::invite_status
     ORDER BY created_at DESC`
  );
  return r.rows;
}

/**
 * Revoke a pending invite by ID. Sets status to 'revoked'.
 * Returns true if the invite was found and revoked, false otherwise.
 */
export async function revokeInvite(inviteId) {
  const c = currentClient();
  const r = await c.query(
    `UPDATE invites SET status = 'revoked'::invite_status
     WHERE id = $1
       AND tenant_id = current_tenant_id()
       AND status = 'pending'::invite_status
     RETURNING id`,
    [inviteId]
  );
  return r.rowCount > 0;
}

/**
 * Find a pending invite by email (case-insensitive).
 * Used by the resolver during the claim flow.
 * Returns the invite row or null.
 */
export async function findPendingInviteByEmail(email) {
  if (!email || typeof email !== "string") return null;
  const c = currentClient();
  const r = await c.query(
    `SELECT id, tenant_id, email, email_domain, role::text, invited_by,
            status::text, created_at, expires_at
     FROM invites
     WHERE tenant_id = current_tenant_id()
       AND lower(email) = $1
       AND status = 'pending'::invite_status
     LIMIT 1`,
    [email.trim().toLowerCase()]
  );
  return r.rows[0] || null;
}

export async function markInviteClaimed(inviteId, claimedBySub) {
  const c = currentClient();
  await c.query(
    `UPDATE invites
     SET status = 'claimed'::invite_status,
         claimed_at = now(),
         claimed_by_sub = $2
     WHERE id = $1`,
    [inviteId, claimedBySub]
  );
}
