// Deterministic condition checks over an InvestigationContext. These are the
// gates, not the investigation: each condition reports pass/fail with the
// records it relied on, so an agent (or a person) can see exactly which fact
// decides the status and what evidence is missing. The repair executor runs the
// same checks on freshly read facts before it writes.

import type { CaseStatus, CheckResult, ConditionResult, Entitlement, InvestigationContext, LineCheck, PaymentLine, WorkspaceMapping } from "../contracts.ts";
import { PROVISIONING_WINDOW_MINUTES, withinProvisioningWindow } from "../rules.ts";

const t = (s: string) => new Date(s).getTime();

export function mappingsValidAt(mappings: WorkspaceMapping[], at: string): WorkspaceMapping[] {
  return mappings.filter((m) => t(m.validFrom) <= t(at) && (m.validTo === null || t(at) < t(m.validTo)));
}

export function checkContext(ctx: InvestigationContext): CheckResult {
  const lines: LineCheck[] = [];
  const incomplete = ctx.coverage.filter((c) => !c.complete);
  for (const p of ctx.payments) {
    const features = p.features.length ? p.features : [null];
    for (const feature of features) lines.push(checkLine(ctx, p, feature, incomplete.map((c) => c.tool)));
  }
  return { tenantId: ctx.tenantId, billingAccountId: ctx.billingAccountId, observedAt: ctx.observedAt, lines };
}

function checkLine(ctx: InvestigationContext, p: PaymentLine, feature: string | null, incompleteReads: string[]): LineCheck {
  const conditions: ConditionResult[] = [];
  const missing: string[] = [];
  const done = (status: CaseStatus): LineCheck => ({ paymentLineId: p.paymentLineId, feature, status, conditions, missing });
  const add = (id: string, passed: boolean, detail: string, refs = [p.ref]) => {
    conditions.push({ id, passed, detail, refs });
    return passed;
  };

  if (!add("reads.complete", incompleteReads.length === 0, incompleteReads.length ? `incomplete reads: ${incompleteReads.join(", ")}` : "all reads complete", [])) {
    missing.push("complete source reads");
    return done("needs_verification");
  }
  if (!add("payment.paid", p.status === "paid" && p.paidAt !== null, `payment status ${p.status}`)) return done("not_entitled");
  const inPeriod = t(p.periodStart) <= t(ctx.observedAt) && t(ctx.observedAt) < t(p.periodEnd);
  if (!add("payment.period_active", inPeriod, `service period ${p.periodStart} .. ${p.periodEnd}`)) return done("not_entitled");
  if (!add("product.feature_known", feature !== null, feature ? `product ${p.productId} unlocks ${feature}` : `no feature mapped for product ${p.productId}`)) {
    missing.push(`product_features for ${p.productId}`);
    return done("needs_verification");
  }

  const ent: Entitlement | undefined = ctx.entitlements.find((e) => e.paymentLineId === p.paymentLineId && e.feature === feature);
  if (!ent) {
    const recent = withinProvisioningWindow(new Date(p.paidAt!), new Date(ctx.observedAt));
    if (add("provisioning.window", recent, `paid ${p.paidAt}; window ${PROVISIONING_WINDOW_MINUTES} min`)) {
      add("entitlement.exists", false, "no entitlement yet; inside the provisioning window");
      return done("processing");
    }
    add("entitlement.exists", false, "paid, past the provisioning window, and no entitlement exists");
    missing.push("an entitlement for this payment line (retarget cannot create one)");
    return done("needs_verification");
  }
  add("entitlement.exists", true, `entitlement ${ent.entitlementId} v${ent.version} -> ${ent.targetWorkspaceId}`, [ent.ref]);
  if (!add("entitlement.active", ent.status === "active", `entitlement status ${ent.status}`, [ent.ref])) {
    missing.push("why the entitlement was revoked");
    return done("needs_verification");
  }

  const current = mappingsValidAt(ctx.mappings, ctx.observedAt);
  if (current.length === 0) {
    add("mapping.unique_current", false, "no workspace mapping is valid now", ctx.mappings.map((m) => m.ref));
    missing.push("an authoritative workspace mapping for this account");
    return done("needs_verification");
  }
  if (current.length > 1) {
    add("mapping.unique_current", false, `${current.length} mappings valid at once: ${current.map((m) => `${m.workspaceId} (v${m.mappingVersion}, ${m.sourceRef})`).join(", ")}`, current.map((m) => m.ref));
    missing.push("which of the overlapping mappings is authoritative");
    return done("needs_verification");
  }
  const cur = current[0];
  add("mapping.unique_current", true, `current workspace ${cur.workspaceId} (v${cur.mappingVersion}, ${cur.sourceRef})`, [cur.ref]);

  if (add("entitlement.on_current_workspace", ent.targetWorkspaceId === cur.workspaceId, `entitlement targets ${ent.targetWorkspaceId}; mapping says ${cur.workspaceId}`, [ent.ref, cur.ref])) {
    return done("consistent");
  }

  // Off target. A retarget is admissible only when the old target is a
  // workspace this account demonstrably held under an earlier mapping.
  const prior = ctx.mappings.find((m) => m.workspaceId === ent.targetWorkspaceId && m.mappingVersion < cur.mappingVersion);
  if (!add("target.prior_mapping", prior !== undefined, prior ? `${ent.targetWorkspaceId} was this account's workspace under v${prior.mappingVersion} until ${prior.validTo}` : `${ent.targetWorkspaceId} never belonged to this account`, prior ? [prior.ref, ent.ref] : [ent.ref])) {
    missing.push(`ownership of ${ent.targetWorkspaceId}`);
    return done("needs_verification");
  }
  // Cause, recorded for the explanation: the original grant used a mapping
  // version that was already closed when it was issued.
  const grant = ctx.grants.find((g) => g.entitlementId === ent.entitlementId && g.eventType === "grant");
  if (grant) {
    const used = ctx.mappings.find((m) => m.mappingVersion === grant.mappingVersionUsed);
    const stale = used?.validTo != null && t(used.validTo) <= t(grant.at);
    add("grant.used_stale_mapping", stale, used ? `grant at ${grant.at} used v${used.mappingVersion}, valid until ${used.validTo ?? "open"}` : `grant used mapping v${grant.mappingVersionUsed ?? "unknown"}`, [grant.ref, ...(used ? [used.ref] : [])]);
  } else {
    add("grant.used_stale_mapping", false, "no original grant event found", [ent.ref]);
  }
  return done("repair_candidate");
}
