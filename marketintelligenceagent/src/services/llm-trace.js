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

export function traceEnabled(value) {
  return typeof value === "string" && value.trim() === "1";
}

function charsOf(x) {
  return typeof x === "string" ? x.length : 0;
}

export function buildLlmRequestInfo(step, stepIndex, params, extra) {
  const p = params && typeof params === "object" ? params : {};
  const msgs = Array.isArray(p.messages) ? p.messages : [];
  let promptChars = 0;
  for (const m of msgs) {
    if (m && typeof m === "object") promptChars += charsOf(m.content);
  }
  const info = {
    ...(extra && typeof extra === "object" ? extra : {}),
    step,
    stepIndex,
    model: typeof p.model === "string" ? p.model : null,
    promptChars
  };
  if (typeof p.system === "string") {
    info.systemChars = p.system.length;
  }
  return info;
}

export function buildLlmPayloadDebug(step, params, cycleId) {
  return { cycleId, step, request: params };
}
