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

import os from "os";



let _boundAddress = null;

export function setBoundAddress(addr) {
  _boundAddress = addr;
}

export function getServerAddress() {
  const fallbackPort = parseInt(process.env.DASHBOARD_PORT || "3001", 10);

  
  const baseUrl = process.env.APP_BASE_URL;
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      const proto = parsed.protocol.replace(":", "");
      const host = parsed.hostname;
      const explicitPort = parsed.port
        ? parseInt(parsed.port, 10)
        : (proto === "https" ? 443 : 80);
      const isStandardPort =
        (proto === "https" && explicitPort === 443) ||
        (proto === "http" && explicitPort === 80);

      return {
        host,
        port: explicitPort,
        proto,
        origin: `${proto}://${host}${isStandardPort ? "" : ":" + explicitPort}`,
        display: `${host}${isStandardPort ? "" : ":" + explicitPort}`
      };
    } catch {
      
    }
  }

  
  const boundPort = _boundAddress?.port || fallbackPort;
  const rawAddr = _boundAddress?.address;

  
  
  let host;
  if (rawAddr && rawAddr !== "::" && rawAddr !== "0.0.0.0" && rawAddr !== "127.0.0.1") {
    host = rawAddr;
  } else {
    
    
    host = "localhost";
  }

  const proto = "http"; 

  return {
    host,
    port: boundPort,
    proto,
    origin: `${proto}://${host}:${boundPort}`,
    display: `${host}:${boundPort}`
  };
}

export function getServerUrl(path) {
  const addr = getServerAddress();
  return addr.origin + (path.startsWith("/") ? path : "/" + path);
}
