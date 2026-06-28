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

import { AsyncLocalStorage } from "node:async_hooks";
import { pool } from "./pool.js";

const als = new AsyncLocalStorage();





export function currentTenantId() {
  const store = als.getStore();
  return store ? store.tenantId : null;
}






export function currentClient() {
  const store = als.getStore();
  return store ? store.client : null;
}












export async function withTenant(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    
    
    
    
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      [tenantId]
    );
    const result = await als.run({ tenantId, client }, () => fn(client));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
