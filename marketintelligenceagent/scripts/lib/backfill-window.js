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

const DEFAULT_DAYS = 160;

function toPosInt(v) {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  const n = parseInt(v, 10);
  return n >= 0 ? n : null;
}

export function resolveWindow(arg1, arg2) {
  const a = toPosInt(arg1);
  if (a === null) {
    return { mode: "window", minDays: 0, maxDays: DEFAULT_DAYS };
  }
  const b = toPosInt(arg2);
  if (b === null) {
    return { mode: "window", minDays: 0, maxDays: a };
  }
  return { mode: "range", minDays: Math.min(a, b), maxDays: Math.max(a, b) };
}
