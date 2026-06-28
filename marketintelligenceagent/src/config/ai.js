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

import { getAgentState } from "../services/database.js";







const DEFAULT_MODEL = "claude-haiku-4-5-20251001";






const ANTHROPIC_API_URL = "https://api.anthropic.com";

export async function getAnthropicModel() {
  
  try {
    const dbValue = await getAgentState("anthropic_model");
    if (dbValue && typeof dbValue === "string" && dbValue.trim().length > 0) {
      return dbValue.trim();
    }
  } catch {
    
  }

  
  const envValue = process.env.ANTHROPIC_MODEL;
  if (envValue && typeof envValue === "string" && envValue.trim().length > 0) {
    return envValue.trim();
  }

  
  return DEFAULT_MODEL;
}

export async function callAnthropic(client, params) {
  try {
    return await client.messages.create(params);
  } catch (err) {
    
    
    
    
    const status = err?.status || err?.statusCode;
    const errType = err?.error?.type || "";
    const errMsg = (err?.message || "").toLowerCase();

    const isModelError =
      (status === 404 && errType === "not_found_error") ||
      (status === 404 && errMsg.includes("model")) ||
      (status === 400 && errMsg.includes("model"));

    if (isModelError) {
      const model = params.model || "(unknown)";
      throw new Error(
        `Model "${model}" does not exist at ${ANTHROPIC_API_URL}. ` +
        `Verify the model name in your workspace settings (agent_state table, key "anthropic_model").`
      );
    }

    
    
    
    
    if (err.request) err.request = undefined;
    if (err.body) err.body = undefined;

    throw err;
  }
}
