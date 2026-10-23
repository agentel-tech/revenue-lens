// The investigation tools an agent may call. Each is read-only, takes
// validated ids (never SQL), runs a fixed query through Zetaris, and returns
// facts with source refs plus read coverage. Shapes are OpenAI-compatible
// function definitions, so src/llm-client.ts can pass them straight through.
//
// Deliberately absent: free SQL, the admin Zetaris client, and anything that
// writes. Writes go only through src/repair/executor.ts.

import type { CheckResult, InvestigationContext, ReadCoverage } from "../contracts.ts";
import { checkContext } from "./checks.ts";
import { ZetarisFacts } from "./context.ts";

export interface ToolDef {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, { type: string; description: string }>; required: string[]; additionalProperties: false };
  run(args: Record<string, unknown>, observedAt: Date): Promise<unknown>;
}

const customerParams = {
  type: "object" as const,
  properties: {
    tenant_id: { type: "string", description: "Tenant (the SaaS operator), e.g. t-northwind" },
    billing_account_id: { type: "string", description: "The customer's billing account, e.g. ba-1a2b3c" },
  },
  required: ["tenant_id", "billing_account_id"],
  additionalProperties: false as const,
};

const facts = new ZetarisFacts();
const ids = (a: Record<string, unknown>) => [String(a.tenant_id ?? ""), String(a.billing_account_id ?? "")] as const;

export const investigationTools: ToolDef[] = [
  {
    name: "get_payments",
    description: "Billing source: the customer's payment lines (status, paid_at, service period, currency) and the features each product unlocks.",
    parameters: customerParams,
    async run(a) {
      const coverage: ReadCoverage[] = [];
      const [t, b] = ids(a);
      return { payments: await facts.payments(t, b, coverage), coverage };
    },
  },
  {
    name: "get_workspace_mappings",
    description: "Workspace-map source: every mapping row for the customer (workspace, valid_from/valid_to, version, source ticket) and migration events. Overlapping rows are returned as they are.",
    parameters: customerParams,
    async run(a) {
      const coverage: ReadCoverage[] = [];
      const [t, b] = ids(a);
      return { ...(await facts.mappings(t, b, coverage)), coverage };
    },
  },
  {
    name: "get_entitlement_trail",
    description: "Cross-source (billing + entitlements, joined in Zetaris): for each payment line, its entitlement (target workspace, version), the grant history (including the mapping version each grant used) and the provisioning run log. Paid lines with no entitlement are kept.",
    parameters: customerParams,
    async run(a) {
      const coverage: ReadCoverage[] = [];
      const [t, b] = ids(a);
      return { ...(await facts.trail(t, b, coverage)), coverage };
    },
  },
  {
    name: "check_conditions",
    description: "Runs the deterministic gates (payment in force, unique current mapping, entitlement on the mapped workspace, prior ownership, stale-mapping cause) on all facts for the customer at the observation time. Returns pass/fail per condition with the records relied on, and what evidence is missing.",
    parameters: customerParams,
    async run(a, observedAt): Promise<{ check: CheckResult; context: InvestigationContext }> {
      const [t, b] = ids(a);
      const context = await facts.context(t, b, observedAt);
      return { check: checkContext(context), context };
    },
  },
];

export function toolSpecs() {
  return investigationTools.map(({ name, description, parameters }) => ({ type: "function" as const, function: { name, description, parameters } }));
}

export async function callTool(name: string, args: Record<string, unknown>, observedAt = new Date()): Promise<unknown> {
  const tool = investigationTools.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool ${name}`);
  return tool.run(args, observedAt);
}
