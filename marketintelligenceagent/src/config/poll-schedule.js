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

const DEFAULT_SCHEDULE = "0 * * * *";
const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const PART_RE = /^(\*|(\d{1,2})(-(\d{1,2}))?)(\/(\d{1,2}))?$/;

function validField(field, [lo, hi]) {
  for (const part of field.split(",")) {
    const m = PART_RE.exec(part);
    if (!m) return false;
    if (m[6] !== undefined && parseInt(m[6], 10) === 0) return false; 
    if (m[1] === "*") continue;
    const n = parseInt(m[2], 10);
    if (n < lo || n > hi) return false;
    if (m[4] !== undefined) {
      const end = parseInt(m[4], 10);
      if (end < lo || end > hi || end < n) return false;
    }
  }
  return true;
}

function isValidCron(expr) {
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f, i) => validField(f, FIELD_RANGES[i]));
}


function rejectedEcho(raw) {
  return String(raw).replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 60).trim();
}

export function resolvePollSchedule(envValue) {
  
  if (envValue === undefined) {
    return { expression: DEFAULT_SCHEDULE, source: "default", valid: true };
  }
  
  
  if (typeof envValue !== "string") {
    return { expression: DEFAULT_SCHEDULE, source: "default", valid: false, rejected: rejectedEcho(envValue) };
  }
  const raw = envValue.trim();
  if (raw === "") {
    return { expression: DEFAULT_SCHEDULE, source: "default", valid: true };
  }
  if (isValidCron(raw)) {
    return { expression: raw, source: "env", valid: true };
  }
  return { expression: DEFAULT_SCHEDULE, source: "default", valid: false, rejected: rejectedEcho(raw) };
}
