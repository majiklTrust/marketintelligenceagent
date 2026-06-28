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

export function platformLog(level, action, details) {
  const ts = new Date().toISOString();
  const upper = String(level || "info").toUpperCase();
  const payload = details === null || details === undefined ? "" : (
    typeof details === "string" ? details : JSON.stringify(details)
  );
  console.log(`${ts} [PLATFORM:${upper}] ${action}${payload ? " " + payload : ""}`);
}
