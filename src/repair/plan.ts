// Building a retarget plan. The proposer (an agent or a person) supplies the
// facts it relies on; this module only fixes the identity of the intent and
// fingerprints the payload, so retries are recognisable and edits are not.

import { createHash } from "node:crypto";
import type { RepairPlan, SourceRef } from "../contracts.ts";

export type PlanInput = Omit<RepairPlan, "action" | "intentKey" | "payloadFingerprint">;

// The fields that define the change. Anything else (evidence, proposer) can
// differ between retries without changing what the plan does.
export function canonicalPayload(p: Pick<RepairPlan, "tenantId" | "billingAccountId" | "paymentLineId" | "entitlementId" | "feature" | "fromWorkspace" | "toWorkspace" | "expectedVersion" | "mappingVersion">) {
  return JSON.stringify([p.tenantId, p.billingAccountId, p.paymentLineId, p.entitlementId, p.feature, p.fromWorkspace, p.toWorkspace, p.expectedVersion, p.mappingVersion]);
}

export function fingerprint(p: Parameters<typeof canonicalPayload>[0]): string {
  return createHash("sha256").update(canonicalPayload(p)).digest("hex");
}

// One intent per entitlement version: "move this entitlement, as it stood at
// version N". A second, different plan for the same version collides on the
// key and is rejected as a payload conflict.
export function intentKeyFor(tenantId: string, entitlementId: string, expectedVersion: number): string {
  return `retarget:${tenantId}:${entitlementId}:v${expectedVersion}`;
}

export function makeRetargetPlan(input: PlanInput & { evidenceRefs: SourceRef[] }): RepairPlan {
  return {
    action: "retarget_entitlement",
    ...input,
    intentKey: intentKeyFor(input.tenantId, input.entitlementId, input.expectedVersion),
    payloadFingerprint: fingerprint(input),
  };
}
