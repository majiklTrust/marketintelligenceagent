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

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');



const LOG_DIR = path.join(process.cwd(), 'data');
const LOG_FILE = path.join(LOG_DIR, 'traffic.log');

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });



const WATCH_DOMAINS = [
  'linkedin.com',
  'api.linkedin.com',
  'www.linkedin.com',
  'licdn.com',
  'platform.linkedin.com',
  'media.licdn.com'
];

function isWatchedDomain(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return WATCH_DOMAINS.some(d => h === d || h.endsWith('.' + d));
}

function isWatchedIngress(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return u.includes('/auth/linkedin') || u.includes('/api/linkedin');
}

function log(direction, entry) {
  const ts = new Date().toISOString();
  const payload = `${direction} ${JSON.stringify(entry)}`;
  const fileLine = `[${ts}] ${payload}`;

  
  logStream.write(fileLine + '\n');

  
  const showOnConsole =
    (direction === 'EGRESS' && isWatchedDomain(entry.host)) ||
    (direction === 'INGRESS' && isWatchedIngress(entry.url));

  if (showOnConsole) {
    const color = direction === 'EGRESS' ? '33' : '36';
    process.stdout.write(`[${ts}] \x1b[${color}m${payload}\x1b[0m\n`);
  }
}



const SENSITIVE = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);

function safeHeaders(headers) {
  if (!headers) return {};
  const safe = {};
  for (const [key, val] of Object.entries(headers)) {
    if (SENSITIVE.has(key.toLowerCase())) {
      const str = String(val);
      safe[key] = str.substring(0, 12) + '...[REDACTED]';
    } else {
      safe[key] = val;
    }
  }
  return safe;
}



function patchModule(mod, protocol) {
  const originalRequest = mod.request;

  mod.request = function patchedRequest(options, callback) {
    const startTime = Date.now();

    
    let method, hostname, portNum, reqPath;
    if (typeof options === 'string') {
      const u = new URL(options);
      method = 'GET';
      hostname = u.hostname;
      portNum = u.port || (protocol === 'https' ? 443 : 80);
      reqPath = u.pathname + u.search;
    } else if (options instanceof URL) {
      method = 'GET';
      hostname = options.hostname;
      portNum = options.port || (protocol === 'https' ? 443 : 80);
      reqPath = options.pathname + options.search;
    } else {
      method = options.method || 'GET';
      hostname = options.hostname || options.host || 'unknown';
      portNum = options.port || (protocol === 'https' ? 443 : 80);
      reqPath = options.path || '/';
    }

    const entry = {
      method,
      host: hostname,
      port: portNum,
      path: reqPath,
      protocol
    };

    
    if (options.headers) {
      entry.requestHeaders = safeHeaders(options.headers);
    }

    const req = originalRequest.call(mod, options, function (res) {
      const elapsed = Date.now() - startTime;
      entry.status = res.statusCode;
      entry.responseHeaders = safeHeaders(res.headers);
      entry.elapsed_ms = elapsed;

      
      if (res.statusCode >= 400) {
        const chunks = [];
        const origEmit = res.emit.bind(res);
        res.emit = function (event, ...args) {
          if (event === 'data') chunks.push(args[0]);
          if (event === 'end') {
            const body = Buffer.concat(chunks).toString('utf8').substring(0, 500);
            entry.responseBody = body;
            log('EGRESS', entry);
          }
          return origEmit(event, ...args);
        };
      } else {
        log('EGRESS', entry);
      }

      if (callback) callback(res);
    });

    req.on('error', (err) => {
      entry.error = err.message;
      entry.elapsed_ms = Date.now() - startTime;
      log('EGRESS', entry);
    });

    return req;
  };

  
  mod.get = function patchedGet(options, callback) {
    const req = mod.request(options, callback);
    req.end();
    return req;
  };
}

patchModule(http, 'http');
patchModule(https, 'https');





const originalCreateServer = http.createServer;

http.createServer = function patchedCreateServer(requestListener) {
  const wrappedListener = function (req, res) {
    const startTime = Date.now();

    
    res.on('finish', () => {
      const elapsed = Date.now() - startTime;
      log('INGRESS', {
        method: req.method,
        url: req.url,
        status: res.statusCode,
        elapsed_ms: elapsed,
        userAgent: (req.headers['user-agent'] || '').substring(0, 80),
        origin: req.headers['origin'] || req.headers['referer'] || 'direct'
      });
    });

    if (requestListener) requestListener(req, res);
  };

  return originalCreateServer.call(http, wrappedListener);
};



console.log('\x1b[32m[TRAFFIC MONITOR] Active — all traffic logged to data/traffic.log\x1b[0m');
console.log('\x1b[32m[TRAFFIC MONITOR] Console shows LinkedIn traffic only (yellow=egress, cyan=ingress)\x1b[0m');
