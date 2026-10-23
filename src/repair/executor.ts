// The only write path. Executes a retarget plan against the entitlements
// source with the column-scoped rl_executor role.
//
// Order of operations:
//   1. plan integrity: shape, ids, fingerprint recomputed from the payload
//   2. idempotency: an existing receipt for (tenant, intentKey) returns
//      "replayed" if the payload matches, "payload_conflict" if not
//   3. fresh re-check: facts re-read DIRECTLY from all three sources (never
//      via Zetaris) and the same deterministic checks must say
//      repair_candidate, with the plan matching those facts exactly
//   4. one transaction: lock the entitlement, re-verify version and target,
//      insert the receipt, retarget + bump version, append a grant event
//
// Not claimed: atomicity across databases. The mapping is re-read just before
// the transaction; a mapping change after that read is caught on the next run.

import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { ExecutionReceipt, RepairPlan } from "../contracts.ts";
import { checkContext, mappingsValidAt } from "../data/checks.ts";
import { assertId, directContext } from "../data/context.ts";
import { pool } from "../sources.ts";
import { fingerprint } from "./plan.ts";

const now = () => new Date().toISOString();
const rid = (p: string) => `${p}-${randomBytes(6).toString("hex")}`;

function reject(reason: ExecutionReceipt["reason"], detail: string, extra: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return { outcome: "rejected", reason, detail, at: now(), ...extra };
}

async function existingReceipt(db: pg.Pool | pg.PoolClient, plan: RepairPlan): Promise<ExecutionReceipt | null> {
  const { rows } = await db.query("SELECT * FROM repair_receipts WHERE tenant_id = $1 AND intent_key = $2", [plan.tenantId, plan.intentKey]);
  const r = rows[0];
  if (!r) return null;
  if (r.payload_fingerprint !== plan.payloadFingerprint) {
    return reject("payload_conflict", `intent ${plan.intentKey} was already executed with a different payload (receipt ${r.receipt_id})`, { receiptId: r.receipt_id });
  }
  return {
    outcome: "replayed", detail: `intent ${plan.intentKey} already applied; returning the original receipt`,
    receiptId: r.receipt_id, entitlementId: r.entitlement_id, fromWorkspace: r.from_workspace, toWorkspace: r.to_workspace,
    previousVersion: r.expected_version, newVersion: r.new_version, at: new Date(r.created_at).toISOString(),
  };
}

export async function executeRetarget(plan: RepairPlan, opts: { actor?: string } = {}): Promise<ExecutionReceipt> {
  // 1. integrity
  try {
    for (const [k, v] of Object.entries({ tenantId: plan.tenantId, billingAccountId: plan.billingAccountId, paymentLineId: plan.paymentLineId, entitlementId: plan.entitlementId, fromWorkspace: plan.fromWorkspace, toWorkspace: plan.toWorkspace })) assertId(k, v);
  } catch (e) {
    return reject("invalid_plan", (e as Error).message);
  }
  if (plan.action !== "retarget_entitlement") return reject("invalid_plan", `unsupported action ${plan.action}`);
  if (plan.fromWorkspace === plan.toWorkspace) return reject("invalid_plan", "from and to workspace are the same");
  if (fingerprint(plan) !== plan.payloadFingerprint) return reject("invalid_plan", "payload fingerprint does not match the plan's fields");

  const db = pool("entitlements", "executor");
  try {
    // 2. idempotency
    const prior = await existingReceipt(db, plan);
    if (prior) return prior;

    // 3. fresh re-check on directly read facts
    const ctx = await directContext(plan.tenantId, plan.billingAccountId, new Date());
    const recheck = checkContext(ctx);
    const line = recheck.lines.find((l) => l.paymentLineId === plan.paymentLineId && l.feature === plan.feature);
    if (!line) return reject("plan_mismatch", `payment line ${plan.paymentLineId} / ${plan.feature} not found for this customer`, { recheck });
    if (line.status !== "repair_candidate") return reject("not_repair_candidate", `fresh check says ${line.status}`, { recheck });
    const ent = ctx.entitlements.find((e) => e.entitlementId === plan.entitlementId);
    const current = mappingsValidAt(ctx.mappings, ctx.observedAt);
    if (!ent || ent.paymentLineId !== plan.paymentLineId) return reject("plan_mismatch", "entitlement does not belong to this payment line", { recheck });
    if (ent.version !== plan.expectedVersion) return reject("version_changed", `entitlement is at v${ent.version}, plan expected v${plan.expectedVersion}`, { recheck });
    if (ent.targetWorkspaceId !== plan.fromWorkspace) return reject("plan_mismatch", `entitlement targets ${ent.targetWorkspaceId}, plan says ${plan.fromWorkspace}`, { recheck });
    if (current.length !== 1 || current[0].workspaceId !== plan.toWorkspace || current[0].mappingVersion !== plan.mappingVersion) {
      return reject("plan_mismatch", `current mapping is ${current.map((m) => `${m.workspaceId}@v${m.mappingVersion}`).join(", ") || "none"}, plan says ${plan.toWorkspace}@v${plan.mappingVersion}`, { recheck });
    }

    // 4. the transaction
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT version, target_workspace_id FROM entitlements WHERE tenant_id = $1 AND entitlement_id = $2 FOR UPDATE", [plan.tenantId, plan.entitlementId]);
      const row = locked.rows[0];
      if (!row || row.version !== plan.expectedVersion || row.target_workspace_id !== plan.fromWorkspace) {
        await client.query("ROLLBACK");
        // a concurrent submit of this same intent may have won the lock
        return (await existingReceipt(db, plan)) ?? reject("version_changed", "entitlement changed between re-check and lock", { recheck });
      }
      const receiptId = rid("rcpt");
      const at = new Date();
      try {
        await client.query(
          `INSERT INTO repair_receipts (tenant_id, receipt_id, intent_key, payload_fingerprint, entitlement_id, from_workspace, to_workspace, expected_version, new_version, evidence_refs, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [plan.tenantId, receiptId, plan.intentKey, plan.payloadFingerprint, plan.entitlementId, plan.fromWorkspace, plan.toWorkspace, plan.expectedVersion, plan.expectedVersion + 1, JSON.stringify(plan.evidenceRefs), at],
        );
      } catch (e) {
        await client.query("ROLLBACK");
        if ((e as { code?: string }).code === "23505") return (await existingReceipt(db, plan)) ?? reject("version_changed", "concurrent repair");
        throw e;
      }
      const upd = await client.query(
        "UPDATE entitlements SET target_workspace_id = $3, version = version + 1, updated_at = $4 WHERE tenant_id = $1 AND entitlement_id = $2 AND version = $5",
        [plan.tenantId, plan.entitlementId, plan.toWorkspace, at, plan.expectedVersion],
      );
      if (upd.rowCount !== 1) {
        await client.query("ROLLBACK");
        return (await existingReceipt(db, plan)) ?? reject("version_changed", "conditional update matched no row");
      }
      await client.query(
        `INSERT INTO grant_events (tenant_id, event_id, entitlement_id, event_type, target_workspace_id, mapping_version_used, actor, at, receipt_id)
         VALUES ($1, $2, $3, 'retarget', $4, $5, $6, $7, $8)`,
        [plan.tenantId, rid("evt"), plan.entitlementId, plan.toWorkspace, plan.mappingVersion, opts.actor ?? `revenue-lens-executor (${plan.proposedBy})`, at, receiptId],
      );
      await client.query("COMMIT");
      return {
        outcome: "applied", detail: `entitlement ${plan.entitlementId} moved ${plan.fromWorkspace} -> ${plan.toWorkspace}`,
        receiptId, entitlementId: plan.entitlementId, fromWorkspace: plan.fromWorkspace, toWorkspace: plan.toWorkspace,
        previousVersion: plan.expectedVersion, newVersion: plan.expectedVersion + 1, recheck, at: at.toISOString(),
      };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  } finally {
    await db.end();
  }
}
