#!/usr/bin/env node
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

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");          
const ENCRYPTED = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD"];

function die(code, msg) {
  console.error(`[dbshell] ${msg}`);
  process.exit(code);
}






const [cmd, ...args] = process.argv.slice(2);



const envPath = (cmd === "verify" && args[0])
  ? path.resolve(args[0])
  : path.join(APP_ROOT, ".env");
if (!fs.existsSync(envPath)) die(2, `env file not found at ${envPath}`);
dotenv.config({ path: envPath, override: true });


const { decryptPlatformSecret } = await import(
  pathToFileURL(path.join(APP_ROOT, "src/services/platform-secret.js")).href
);

const creds = {};
for (const v of ENCRYPTED) {
  const cipher = (process.env[v] || "").trim();
  if (!cipher) die(3, `${v} missing from .env`);
  let plain;
  try {
    plain = decryptPlatformSecret(cipher);
  } catch (e) {
    die(3, `${v} could not be decrypted (${e.message}) — encrypted with the current ENCRYPTION_SECRET?`);
  }
  if (!plain) die(3, `${v} decrypted to an empty value`);
  creds[v] = plain;
}
const PGDATABASE = (process.env.PGDATABASE || "").trim();   // plaintext by design
if (!PGDATABASE) die(3, "PGDATABASE missing from .env");




if (!cmd || cmd === "verify") {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    host: creds.PGHOST,
    port: parseInt(creds.PGPORT, 10),
    user: creds.PGUSER,
    password: creds.PGPASSWORD,
    database: PGDATABASE,
    connectionTimeoutMillis: 5000
  });
  try {
    await client.connect();
    const r = await client.query("select current_user, current_database()");
    await client.end();
    console.log(`[dbshell] verify OK [${envPath}] — connected as ${r.rows[0].current_user} to ${r.rows[0].current_database}`);
    process.exit(0);
  } catch (e) {
    try { await client.end(); } catch {  }
    die(4, `verify FAILED — ${e.message}`);
  }
}



const childEnv = { ...process.env, ...creds, PGDATABASE };
delete childEnv.ENCRYPTION_SECRET;


const child = spawn(cmd, args, { stdio: "inherit", env: childEnv });
child.on("error", (e) => die(127, `failed to launch '${cmd}': ${e.message}`));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
