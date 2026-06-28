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

import cron from "node-cron";
import { withTenant } from "../db/with-tenant.js";
import { logActivity } from "./database.js";
import { executePost } from "./scheduler.js";
import { listActiveTenants } from "../tenant/platform-db.js";
import { platformLog } from "./platform-log.js";

let publisherJob = null;






function resolveIntervalMinutes() {
  const raw = process.env.BATCH_PUBLISH_INTERVAL_MINUTES;
  const n = parseInt(raw ?? "", 10);
  if (!Number.isInteger(n) || n < 1 || n > 59) {
    if (raw !== undefined && String(raw).trim() !== "") {
      platformLog("warn", "batch_publish_interval_invalid", { rejected: String(raw).slice(0, 20), using: 15 });
    }
    return 15;
  }
  return n;
}




function resolveMaxPerRun() {
  const n = parseInt(process.env.BATCH_PUBLISH_MAX_PER_RUN ?? "", 10);
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : 25;
}

// ── Claim + publish for one tenant ───────────────────────────
// Must NOT be called inside an existing withTenant block — it opens
// its own.

async function runBatchForTenant(tenant) {
  const maxPerRun = resolveMaxPerRun();

  // Step 1 — CLAIM (own transaction). Atomic select-and-mark.
  let claimed;
  try {
    claimed = await withTenant(tenant.id, async (client) => {
      const { rows } = await client.query(
        `UPDATE posts
            SET status = 'publishing'
          WHERE id IN (
            SELECT id FROM posts
             WHERE tenant_id = current_tenant_id()
               AND status = 'scheduled'
               AND scheduled_for <= now()
             ORDER BY scheduled_for ASC
             FOR UPDATE SKIP LOCKED
             LIMIT $1
          )
          RETURNING id, title`,
        [maxPerRun]
      );
      return rows;
    });
  } catch (err) {
    platformLog("error", "batch_publish_claim_failed", { tenant: tenant.slug, error: err.message });
    return;
  }

  if (claimed.length === 0) return;
  platformLog("info", "batch_publish_claimed", { tenant: tenant.slug, count: claimed.length });

  
  for (const post of claimed) {
    try {
      await withTenant(tenant.id, async () => {
        try {
          await executePost(post.id);
        } catch (err) {
          
          
          
          await logActivity("error", "scheduled_publish_failed", { postId: post.id, error: err.message });
        }
      });
    } catch (err) {
      
      
      platformLog("error", "batch_publish_txn_failed", { tenant: tenant.slug, postId: post.id, error: err.message });
    }
  }
}



async function runBatchForAllTenants() {
  let tenants;
  try {
    tenants = await listActiveTenants();
  } catch (err) {
    console.error("[batch-publisher] failed to list tenants:", err.message);
    return;
  }
  for (const tenant of tenants) {
    await runBatchForTenant(tenant);
  }
}



export function startBatchPublisher() {
  const minutes = resolveIntervalMinutes();
  const expression = `*/${minutes} * * * *`;

  
  
  runBatchForAllTenants().catch(err => {
    console.error("[batch-publisher] initial sweep failed:", err.message);
  });

  publisherJob = cron.schedule(expression, () => {
    runBatchForAllTenants().catch(err => {
      console.error("[batch-publisher] scheduled sweep failed:", err.message);
    });
  });

  console.log(`🗓️  Batch publisher started — sweeping due scheduled posts every ${minutes} min ("${expression}"), all active tenants`);
  return publisherJob;
}

export function stopBatchPublisher() {
  if (publisherJob) {
    publisherJob.stop();
    console.log("🗓️  Batch publisher stopped");
  }
}
