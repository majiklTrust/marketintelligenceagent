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

import { getPrompt, getAuthorizedPrompt } from "./prompt-vault.js";
import { platformLog } from "./platform-log.js";

export async function frameUntrustedContent(content, actionToken) {
  var vaultGet = actionToken
    ? (key) => getAuthorizedPrompt(key, actionToken)
    : (key) => getPrompt(key);

  let prefix = await vaultGet("untrusted_content_prefix");
  let suffix = await vaultGet("untrusted_content_suffix");

  if (!prefix || !suffix) {
    platformLog("error", "prompt_vault_miss", { key: "untrusted_content_prefix/suffix" });
    throw new Error("Untrusted content framing prompts not configured");
  }

  const body = (!content || typeof content !== "string") ? "(empty)" : content;
  const framed = prefix + "\n" + body + "\n" + suffix;

  prefix = null;
  suffix = null;

  return framed;
}
