// Tool runner that force-binds tenant/account from the operator request.
// Model-supplied tenant_id / billing_account_id are ignored.

import { callTool } from "../data/tools.ts";
import type { AllowedToolName, ToolRunner } from "./types.ts";
import { ALLOWED_TOOLS } from "./types.ts";

export function createLockedToolRunner(tenantId: string, billingAccountId: string): ToolRunner {
  return async (name, _args, observedAt) => {
    if (!ALLOWED_TOOLS.includes(name)) throw new Error(`tool not allowlisted: ${name}`);
    // Always the request ids — never the model's.
    return callTool(
      name,
      { tenant_id: tenantId, billing_account_id: billingAccountId },
      observedAt,
    );
  };
}

export function assertNoWriteTool(name: string): void {
  const banned = ["execute", "repair", "retarget", "write", "sql", "query"];
  if (banned.some((b) => name.toLowerCase().includes(b)) && !ALLOWED_TOOLS.includes(name as AllowedToolName)) {
    throw new Error(`write/repair tools are not exposable to the model: ${name}`);
  }
}
