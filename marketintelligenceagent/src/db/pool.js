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

import pg from "pg";
import { decryptPlatformSecret } from "../services/platform-secret.js";

const ENCRYPTED_VARS = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD"];

function decryptRequired(name) {
  const cipher = (process.env[name] || "").trim();
  if (!cipher) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  let plain;
  try {
    plain = decryptPlatformSecret(cipher);
  } catch (e) {
    throw new Error(
      `${name} could not be decrypted — is it encrypted with the current ` +
      `ENCRYPTION_SECRET? (${e.message})`
    );
  }
  if (!plain) {
    throw new Error(`${name} decrypted to an empty value`);
  }
  return plain;
}

// Decrypt the four secret connection vars. PGDATABASE stays plaintext.
const conn = {};
for (const v of ENCRYPTED_VARS) conn[v] = decryptRequired(v);

const database = (process.env.PGDATABASE || "").trim();
if (!database) {
  throw new Error("Missing required environment variable: PGDATABASE");
}

const port = parseInt(conn.PGPORT, 10);
if (!Number.isInteger(port) || port < 1) {
  throw new Error("PGPORT did not decrypt to a valid port number");
}






for (const v of ENCRYPTED_VARS) delete process.env[v];



export const connectionInfo = {
  host: conn.PGHOST,
  port,
  user: conn.PGUSER,
  database
};

export const pool = new pg.Pool({
  host: conn.PGHOST,
  port,
  user: conn.PGUSER,
  password: conn.PGPASSWORD,
  database,
  
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});




export async function query(text, params) {
  return pool.query(text, params);
}



export async function closePool() {
  await pool.end();
}
