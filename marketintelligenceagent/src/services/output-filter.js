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

const SECRET_PATTERNS = [
  
  { name: "anthropic_key", pattern: /sk-ant[\s-]*api\d*[\s-]*[a-zA-Z0-9]{8,}/i },

  
  
  
  { name: "anthropic_key_prefix", pattern: /sk[-\s]*ant[-\s]*api/i },

  
  { name: "aws_key", pattern: /AKIA[0-9A-Z]{12,}/  },

  
  { name: "github_token", pattern: /gh[ps]_[A-Za-z0-9]{20,}/ },

  
  { name: "generic_sk_key", pattern: /sk-[a-zA-Z]*[\s-]*[a-zA-Z0-9]{16,}/ },

  
  
  { name: "long_hex_secret", pattern: /(?:[0-9a-f]{4}[-]?){16,}/i },

  
  { name: "env_var_leak", pattern: /(ANTHROPIC_API_KEY|SESSION_SECRET|ENCRYPTION_SECRET|AUTH0_CLIENT_SECRET|LINKEDIN_ACCESS_TOKEN)\s*[=:]\s*\S+/i },
];

export function scanForSecrets(content) {
  if (!content || typeof content !== "string") return { found: false, matches: [] };

  const matches = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      matches.push(name);
    }
  }

  return { found: matches.length > 0, matches };
}





const PROMPT_LEAK_PATTERNS = [
  
  { name: "system_prompt_fragment", pattern: /you are a (linkedin|content|social media) (content\s+)?(writer|creator|generator|assistant)/i },
  { name: "system_context_leak", pattern: /my (system\s+)?(prompt|instructions?) (say|tell|state|indicate|are)/i },

  
  { name: "instruction_repetition", pattern: /Write in first person\.\s*Sound like a thoughtful practitioner/i },
  { name: "requirement_leak", pattern: /REQUIREMENTS:\s*\n\s*1\.\s*Length:/i },
  { name: "json_format_leak", pattern: /Respond in this exact JSON format:\s*\n\s*\{/i },

  
  { name: "research_marker_leak", pattern: /RESEARCH BRIEF \(use ONLY these verified facts/i },
  { name: "source_rules_leak", pattern: /CRITICAL SOURCE RULES:/i },
  { name: "attribution_rules_leak", pattern: /ATTRIBUTION RULES:\s*\n\s*-\s*Base ALL/i },
];

export function scanForPromptLeak(content) {
  if (!content || typeof content !== "string") return { found: false, matches: [] };

  const matches = [];
  for (const { name, pattern } of PROMPT_LEAK_PATTERNS) {
    if (pattern.test(content)) {
      matches.push(name);
    }
  }

  return { found: matches.length > 0, matches };
}




export function scanForExfiltration(content) {
  if (!content || typeof content !== "string") return { found: false, matches: [] };

  const matches = [];

  
  
  if (/[A-Za-z0-9+/]{40,}={0,2}/.test(content)) {
    matches.push("base64_block");
  }

  
  const urlMatches = content.match(/https?:\/\/[^\s]+/gi) || [];
  for (const url of urlMatches) {
    const queryStart = url.indexOf("?");
    if (queryStart >= 0) {
      const queryString = url.slice(queryStart + 1);
      if (queryString.length > 80) {
        matches.push("suspicious_url_data");
        break;
      }
    }
  }

  
  for (const url of urlMatches) {
    if (/sk-ant/i.test(url) || /AKIA[0-9A-Z]{12,}/.test(url) || /ghp_/.test(url)) {
      matches.push("secret_in_url");
      break;
    }
  }

  return { found: matches.length > 0, matches };
}



export function runOutputFilter(content) {
  const secretResult = scanForSecrets(content);
  const promptResult = scanForPromptLeak(content);
  const exfilResult = scanForExfiltration(content);

  const checks = [
    { name: "secrets", ...secretResult },
    { name: "prompt_leak", ...promptResult },
    { name: "exfiltration", ...exfilResult },
  ];

  const blocked = secretResult.found || promptResult.found || exfilResult.found;

  const reasons = [];
  if (secretResult.found) reasons.push("Secret detected: " + secretResult.matches.join(", "));
  if (promptResult.found) reasons.push("Prompt leak: " + promptResult.matches.join(", "));
  if (exfilResult.found) reasons.push("Exfiltration: " + exfilResult.matches.join(", "));

  return {
    blocked,
    reason: reasons.join("; ") || "",
    checks
  };
}
