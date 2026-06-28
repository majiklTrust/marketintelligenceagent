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

import "dotenv/config";
import { pool, closePool } from "../src/db/pool.js";
import { isSafeUrl } from "../src/services/security.js";
import { pickOgImage } from "../src/services/og-image.js";
import { resolveWindow } from "./lib/backfill-window.js";
import { createInterface } from "node:readline/promises";

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "LinkedInAIAgent/1.5 (og:image backfill)",
        "Accept": "text/html,application/xhtml+xml"
      },
      redirect: "follow",
      signal: controller.signal
    });
    if (!res.ok) return { html: null, status: res.status };
    return { html: await res.text(), status: res.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const w = resolveWindow(process.argv[2], process.argv[3]);
  console.log(w.mode === "range"
    ? `[og-backfill] range: between ${w.maxDays} and ${w.minDays} days ago (inclusive)`
    : `[og-backfill] window: last ${w.maxDays} days`);

  
  
  const params = [String(w.maxDays)];
  let where = `image_url IS NULL
       AND published_at >= now() - ($1 || ' days')::interval`;
  if (w.mode === "range") {
    params.push(String(w.minDays));
    where += `
       AND published_at <= now() - ($2 || ' days')::interval`;
  }
  const { rows } = await pool.query(
    `SELECT id, link FROM articles_v2
     WHERE ${where}
     ORDER BY id`,
    params
  );
  console.log(`[og-backfill] candidates: ${rows.length}`);
  if (rows.length === 0) { await closePool(); return; }

  
  
  
  const rangeResult = await pool.query(
    `SELECT MIN(published_at) AS oldest, MAX(published_at) AS newest
     FROM articles_v2
     WHERE ${where}`,
    params
  );
  const oldest = rangeResult.rows[0]?.oldest
    ? new Date(rangeResult.rows[0].oldest).toISOString().slice(0, 10) : "(unknown)";
  const newest = rangeResult.rows[0]?.newest
    ? new Date(rangeResult.rows[0].newest).toISOString().slice(0, 10) : "(unknown)";
  console.log(`[og-backfill] date range: ${oldest} to ${newest}`);
  console.log(`[og-backfill] estimated runtime: ~${Math.ceil(rows.length * 1.6 / 60)} min at 1 fetch / 1.5s`);

  
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("[og-backfill] Proceed? (Y/n): ");
  rl.close();
  const a = answer.trim().toLowerCase();
  if (a !== "" && a !== "y") {
    console.log("[og-backfill] Cancelled.");
    await closePool();
    return;
  }

  console.log(`[og-backfill] Starting — processing ${rows.length} articles. Progress every 25.`);

  let updated = 0, noImage = 0, unsafe = 0, errors = 0, done = 0;

  for (const row of rows) {
    done++;
    if (!isSafeUrl(row.link)) {
      unsafe++;
    } else {
      try {
        const page = await fetchPage(row.link);
        const imageUrl = page.html ? pickOgImage(page.html, row.link) : null;
        if (imageUrl) {
          
          const r = await pool.query(
            `UPDATE articles_v2 SET image_url = $1
             WHERE id = $2 AND image_url IS NULL`,
            [imageUrl, row.id]
          );
          if (r.rowCount > 0) updated++;
        } else {
          noImage++;
        }
      } catch (err) {
        errors++;
        console.log(`[og-backfill] ${row.id} error: ${String(err.message || err).slice(0, 80)}`);
      }
    }
    if (done % 25 === 0 || done === rows.length) {
      console.log(`[og-backfill] ${done}/${rows.length} — updated ${updated}, no-image ${noImage}, unsafe ${unsafe}, errors ${errors}`);
    }
    if (done < rows.length) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  console.log(`[og-backfill] complete — updated ${updated} of ${rows.length} candidates (no-image ${noImage}, unsafe ${unsafe}, errors ${errors})`);
  await closePool();
}

main().catch(async err => {
  console.error("[og-backfill] fatal:", err.message);
  try { await closePool(); } catch {}
  process.exit(1);
});
