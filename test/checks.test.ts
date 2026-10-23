import { test } from "node:test";
import assert from "node:assert/strict";
import type { InvestigationContext, WorkspaceMapping } from "../src/contracts.ts";
import { checkContext } from "../src/data/checks.ts";
import { fingerprint, makeRetargetPlan } from "../src/repair/plan.ts";

const T = "2026-10-23T12:00:00.000Z";
const ago = (days: number, min = 0) => new Date(new Date(T).getTime() - days * 86_400_000 - min * 60_000).toISOString();
const ref = { source: "billing" as const, table: "x", key: {}, via: "direct" as const };
const mapping = (ws: string, v: number, from: string, to: string | null): WorkspaceMapping =>
  ({ tenantId: "t", mappingId: `m${v}${ws}`, billingAccountId: "ba", workspaceId: ws, validFrom: from, validTo: to, mappingVersion: v, sourceRef: "s", ref });

function ctx(over: Partial<InvestigationContext> = {}): InvestigationContext {
  return {
    tenantId: "t", billingAccountId: "ba", observedAt: T,
    payments: [{ tenantId: "t", paymentLineId: "pl", billingAccountId: "ba", productId: "pro", features: ["reports"], periodStart: ago(2), periodEnd: ago(-28), amountCents: 100, currency: "USD", status: "paid", paidAt: ago(2), recordVersion: 1, ref }],
    mappings: [mapping("ws-old", 1, ago(200), ago(10)), mapping("ws-new", 2, ago(10), null)],
    migrations: [],
    entitlements: [{ tenantId: "t", entitlementId: "e", paymentLineId: "pl", feature: "reports", periodStart: ago(2), periodEnd: ago(-28), targetWorkspaceId: "ws-old", status: "active", version: 1, updatedAt: ago(2), ref }],
    grants: [{ tenantId: "t", eventId: "g", entitlementId: "e", eventType: "grant", targetWorkspaceId: "ws-old", mappingVersionUsed: 1, actor: "wf", at: ago(2), receiptId: null, ref }],
    runs: [],
    coverage: [{ tool: "x", via: "direct", rows: 1, complete: true }],
    ...over,
  };
}
const status = (c: InvestigationContext) => checkContext(c).lines[0].status;
const cond = (c: InvestigationContext, id: string) => checkContext(c).lines[0].conditions.find((x) => x.id === id);

test("stale mapping grant is a repair candidate, and the cause is recorded", () => {
  assert.equal(status(ctx()), "repair_candidate");
  assert.equal(cond(ctx(), "grant.used_stale_mapping")?.passed, true);
});

test("entitlement on the current workspace is consistent", () => {
  const c = ctx();
  c.entitlements[0].targetWorkspaceId = "ws-new";
  assert.equal(status(c), "consistent");
});

test("overlapping current mappings need verification, never repair", () => {
  const c = ctx({ mappings: [mapping("ws-old", 1, ago(200), null), mapping("ws-new", 2, ago(10), null)] });
  assert.equal(status(c), "needs_verification");
  assert.match(checkContext(c).lines[0].missing[0], /authoritative/);
});

test("no mapping at all needs verification", () => {
  assert.equal(status(ctx({ mappings: [] })), "needs_verification");
});

test("target never owned by this account needs verification", () => {
  const c = ctx();
  c.entitlements[0].targetWorkspaceId = "ws-stranger";
  assert.equal(status(c), "needs_verification");
});

test("missing entitlement: processing inside the window, needs verification after", () => {
  const recent = ctx({ entitlements: [], grants: [] });
  recent.payments[0].paidAt = ago(0, 10);
  assert.equal(status(recent), "processing");
  const late = ctx({ entitlements: [], grants: [] });
  assert.equal(status(late), "needs_verification");
});

test("failed payment or ended period is not entitled", () => {
  const failed = ctx();
  failed.payments[0].status = "failed";
  failed.payments[0].paidAt = null;
  assert.equal(status(failed), "not_entitled");
  const ended = ctx();
  ended.payments[0].periodEnd = ago(1);
  assert.equal(status(ended), "not_entitled");
});

test("an incomplete read blocks any conclusion", () => {
  assert.equal(status(ctx({ coverage: [{ tool: "get_entitlement_trail", via: "zetaris", rows: 500, complete: false }] })), "needs_verification");
});

test("plan identity: same payload same fingerprint; evidence does not change it", () => {
  const base = { tenantId: "t", billingAccountId: "ba", paymentLineId: "pl", entitlementId: "e", feature: "reports", fromWorkspace: "ws-old", toWorkspace: "ws-new", expectedVersion: 1, mappingVersion: 2, proposedBy: "a" };
  const p1 = makeRetargetPlan({ ...base, evidenceRefs: [] });
  const p2 = makeRetargetPlan({ ...base, evidenceRefs: [ref], proposedBy: "b" });
  assert.equal(p1.intentKey, p2.intentKey);
  assert.equal(p1.payloadFingerprint, p2.payloadFingerprint);
  assert.notEqual(fingerprint({ ...base, toWorkspace: "ws-x" }), p1.payloadFingerprint);
});
