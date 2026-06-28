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

import axios from "axios";
import { logActivity } from "./database.js";
import { platformLog } from "./platform-log.js";
import { publishPost as legacyPublishPost } from "./linkedin-api.js";
import {
  getLinkedInAccessToken,
  getLinkedInPersonUrn,
  getLinkedInOrgUrn
} from "../tenant/credential-store.js";
import { isSafeUrl } from "./security.js";
import { currentTenantId } from "../db/with-tenant.js";



const LINKEDIN_REST = "https://api.linkedin.com/rest";




function getPublishMode() {
  const mode = (process.env.LINKEDIN_PUBLISH_MODE || "text-posting").toLowerCase();
  
  if (mode === "image-posting" || mode === "rest") return "image-posting";
  return "text-posting";
}

function getPublishTarget() {
  
  
  
  
  
  
  const target = (process.env.LINKEDIN_PUBLISH_TARGET || "personal").toLowerCase();
  return target === "organization" ? "organization" : "personal";
}

function getLinkedInVersion() {
  
  
  
  
  
  return process.env.LINKEDIN_VERSION || "202509";
}

function getImageMaxBytes() {
  const val = parseInt(process.env.LINKEDIN_IMAGE_MAX_BYTES, 10);
  return val > 0 ? val : 10 * 1024 * 1024; 
}

function getImagePollMaxAttempts() {
  const val = parseInt(process.env.LINKEDIN_IMAGE_POLL_MAX, 10);
  return val > 0 ? val : 10;
}

function getImagePollIntervalMs() {
  const val = parseInt(process.env.LINKEDIN_IMAGE_POLL_INTERVAL_MS, 10);
  return val > 0 ? val : 2000; 
}



function restHeaders(token, contentType = "application/json") {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": contentType,
    "LinkedIn-Version": getLinkedInVersion(),
    "X-Restli-Protocol-Version": "2.0.0"
  };
}















function stripExifFromJpeg(buffer) {
  
  if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) return buffer;

  const out = [Buffer.from([0xFF, 0xD8])]; 
  let pos = 2;

  while (pos < buffer.length - 1) {
    
    if (buffer[pos] !== 0xFF) {
      
      out.push(buffer.subarray(pos));
      break;
    }

    const marker = buffer[pos + 1];

    
    
    if (marker === 0xDA) {
      out.push(buffer.subarray(pos));
      break;
    }

    
    if ((marker >= 0xD0 && marker <= 0xD9) || marker === 0x01) {
      out.push(buffer.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }

    
    const segLen = buffer.readUInt16BE(pos + 2);
    const segEnd = pos + 2 + segLen;

    
    if (marker >= 0xE1 && marker <= 0xEF) {
      pos = segEnd;
      continue;
    }

    
    out.push(buffer.subarray(pos, segEnd));
    pos = segEnd;
  }

  return Buffer.concat(out);
}

function stripMetadata(buffer, contentType) {
  if (contentType === "image/jpeg") {
    const stripped = stripExifFromJpeg(buffer);
    const removed = buffer.length - stripped.length;
    if (removed > 0) {
      platformLog("info", "exif_stripped", {
        originalBytes: buffer.length,
        strippedBytes: stripped.length,
        removedBytes: removed
      });
    }
    return stripped;
  }

  
  
  return buffer;
}






const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp"
]);


const MAGIC_BYTES = [
  { type: "image/jpeg", bytes: [0xFF, 0xD8, 0xFF] },
  { type: "image/png",  bytes: [0x89, 0x50, 0x4E, 0x47] },
  { type: "image/gif",  bytes: [0x47, 0x49, 0x46] },
  { type: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] }
];

function detectImageType(buffer) {
  for (const m of MAGIC_BYTES) {
    if (m.bytes.every((b, i) => buffer[i] === b)) return m.type;
  }
  return null;
}

async function downloadImage(imageUrl) {
  if (!isSafeUrl(imageUrl)) {
    throw new Error("Image URL blocked by SSRF protection");
  }

  const maxBytes = getImageMaxBytes();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let response;
  try {
    response = await fetch(imageUrl, {
      headers: {
        "User-Agent": "LinkedInAIAgent/1.5 (Image Fetch)",
        "Accept": "image/jpeg, image/png, image/gif, image/webp"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Image download failed: HTTP ${response.status}`);
  }

  
  const rawContentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (rawContentType && !ALLOWED_IMAGE_TYPES.has(rawContentType)) {
    throw new Error(`Invalid image Content-Type: ${rawContentType}`);
  }

  // Stream to buffer with size cap
  const chunks = [];
  let totalBytes = 0;
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    if (totalBytes > maxBytes) {
      reader.cancel();
      throw new Error(`Image exceeds size limit (${Math.round(maxBytes / 1024 / 1024)} MB)`);
    }
    chunks.push(value);
  }

  const buffer = Buffer.concat(chunks);

  // Validate magic bytes — defense in depth against Content-Type spoofing
  const detectedType = detectImageType(buffer);
  if (!detectedType) {
    throw new Error("Image failed magic-byte validation — not a recognized image format");
  }

  return { buffer, contentType: detectedType };
}




async function uploadImageToLinkedIn(token, ownerUrn, imageBuffer, contentType) {
  
  const initResponse = await axios.post(
    `${LINKEDIN_REST}/images?action=initializeUpload`,
    {
      initializeUploadRequest: {
        owner: ownerUrn
      }
    },
    { headers: restHeaders(token) }
  );

  const uploadUrl = initResponse.data?.value?.uploadUrl;
  const imageUrn = initResponse.data?.value?.image;

  if (!uploadUrl || !imageUrn) {
    throw new Error("LinkedIn initializeUpload did not return uploadUrl or image URN");
  }

  platformLog("info", "linkedin_image_upload_initialized", {
    imageUrn,
    hasUploadUrl: !!uploadUrl
  });

  
  await axios.put(uploadUrl, imageBuffer, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType
    },
    maxBodyLength: getImageMaxBytes(),
    maxContentLength: getImageMaxBytes()
  });

  platformLog("info", "linkedin_image_binary_uploaded", {
    imageUrn,
    bytes: imageBuffer.length,
    contentType
  });

  
  const maxAttempts = getImagePollMaxAttempts();
  const intervalMs = getImagePollIntervalMs();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs));

    try {
      const statusResponse = await axios.get(
        `${LINKEDIN_REST}/images/${encodeURIComponent(imageUrn)}`,
        { headers: restHeaders(token) }
      );

      const status = statusResponse.data?.status;
      platformLog("info", "linkedin_image_poll", {
        imageUrn, attempt, status
      });

      if (status === "AVAILABLE") {
        return imageUrn;
      }

      if (status === "PROCESSING_FAILED" || status === "WAITING_UPLOAD") {
        throw new Error(`LinkedIn image processing failed: status=${status}`);
      }
    } catch (pollErr) {
      if (pollErr.response?.status === 404 && attempt < maxAttempts) {
        continue; 
      }
      if (attempt === maxAttempts) {
        throw new Error(`Image processing timed out after ${maxAttempts} attempts`);
      }
    }
  }

  throw new Error("Image processing did not complete within polling window");
}






async function restPublish(content, hashtags, imageUrl) {
  let token, authorUrn;
  const target = getPublishTarget();

  try {
    token = await getLinkedInAccessToken();
    authorUrn = target === "organization"
      ? await getLinkedInOrgUrn()
      : await getLinkedInPersonUrn();
  } catch {
    const targetLabel = target === "organization" ? "organization page" : "personal profile";
    throw new Error(
      `LinkedIn credentials not configured for ${targetLabel} publishing. ` +
      "Connect via /auth/linkedin"
    );
  }

  const hashtagString = hashtags.length > 0
    ? `\n\n${hashtags.join(" ")}`
    : "";
  const fullContent = `${content}${hashtagString}`;

  // Build the post payload
  const payload = {
    author: authorUrn,
    commentary: fullContent,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false
  };

  
  if (imageUrl) {
    platformLog("info", "linkedin_image_download_start", { imageUrl });

    const { buffer, contentType } = await downloadImage(imageUrl);

    
    
    const cleanBuffer = stripMetadata(buffer, contentType);

    platformLog("info", "linkedin_image_downloaded", {
      bytes: cleanBuffer.length,
      contentType
    });

    const imageUrn = await uploadImageToLinkedIn(
      token, authorUrn, cleanBuffer, contentType
    );

    payload.content = {
      media: {
        id: imageUrn
      }
    };

    platformLog("info", "linkedin_image_attached", { imageUrn });
  }

  
  try {
    const response = await axios.post(
      `${LINKEDIN_REST}/posts`,
      payload,
      { headers: restHeaders(token) }
    );

    const location = response.headers["location"] || "";
    const postId = response.headers["x-restli-id"]
      || decodeURIComponent(location.split("/").pop())
      || null;

    if (!postId) {
      await logActivity("warn", "linkedin_post_no_id", {
        status: response.status,
        mode: "rest"
      });
    }

    await logActivity("info", "linkedin_post_published", {
      postId,
      status: response.status,
      contentLength: fullContent.length,
      hasImage: !!imageUrl,
      mode: "rest",
      target: getPublishTarget()
    });

    platformLog("info", "linkedin_post_published", {
      postId, hasImage: !!imageUrl, mode: "rest",
      target: getPublishTarget()
    });

    return { success: true, postId };
  } catch (err) {
    const errorDetail = err.response?.data || err.message;
    const statusCode = err.response?.status;

    await logActivity("error", "linkedin_post_failed", {
      status: statusCode,
      error: errorDetail,
      hasImage: !!imageUrl,
      mode: "rest",
      target: getPublishTarget()
    });

    if (statusCode === 401) {
      throw new Error("LinkedIn access token expired. Reconnect via /auth/linkedin");
    }
    if (statusCode === 422) {
      throw new Error(`LinkedIn rejected the post: ${JSON.stringify(errorDetail)}`);
    }

    throw new Error(`LinkedIn API error (${statusCode}): ${JSON.stringify(errorDetail)}`);
  }
}











export async function publishPost(content, hashtags = [], imageUrl = null, targetOverride = null) {
  const mode = getPublishMode();
  
  
  
  
  
  
  
  
  const target = (targetOverride === "personal" || targetOverride === "organization")
    ? targetOverride
    : getPublishTarget();
  const tenant = currentTenantId() || "unknown";

  platformLog("info", "publish", {
    tenant,
    mode,
    target,
    hasImage: !!imageUrl,
    imageOutcome: !imageUrl ? "none"
      : mode === "text-posting" ? "ignored"
      : "attached"
  });

  if (mode === "text-posting") {
    if (imageUrl) {
      platformLog("warn", "linkedin_image_ignored_text_posting_mode", {
        imageUrl,
        reason: "LINKEDIN_PUBLISH_MODE=text-posting does not support images"
      });
    }
    return legacyPublishPost(content, hashtags);
  }

  return restPublish(content, hashtags, imageUrl);
}


export { getPublishMode };
