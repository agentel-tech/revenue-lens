import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckResult, SourceRef } from "../contracts.ts";
import { emptyGathered, ingestToolFact, resolveRepairSuggestion } from "./evidence.ts";
import { parseAndResolveFinding, parseFindingLegacy, parseModelRepairSelection } from "./decisions.ts";
import { tryBuildRepairPlan } from "./workflow.ts";

const T = "2026-10-23T12:00:00.000Z";
const SCOPE = { tenantId: "t-northwind", billingAccountId: "ba-1" };
const ago = (days: number) => new Date(new Date(T).getTime() - days * 86_400_000).toISOString();

const payRef: SourceRef = {
  source: "billing",
  table: "payment_lines",
  key: { payment_line_id: "pl-1", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 1,
};
const payOtherRef: SourceRef = {
  source: "billing",
  table: "payment_lines",
  key: { payment_line_id: "pl-other", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 1,
};
const mapOldRef: SourceRef = {
  source: "workspace_map",
  table: "workspace_mappings",
  key: { mapping_id: "m-ws-old-1", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 1,
};
const mapNewRef: SourceRef = {
  source: "workspace_map",
  table: "workspace_mappings",
  key: { mapping_id: "m-ws-new-2", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 2,
};
const entRef: SourceRef = {
  source: "entitlements",
  table: "entitlements",
  key: { entitlement_id: "ent-1", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 1,
};
const grantRef: SourceRef = {
  source: "entitlements",
  table: "grant_events",
  key: { event_id: "g1", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 1,
};

function payment(lineId: string, ref: SourceRef) {
  return {
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    paymentLineId: lineId,
    productId: "pro",
    features: ["reports"],
    periodStart: ago(2),
    periodEnd: ago(-28),
    amountCents: 100,
    currency: "USD",
    status: "paid" as const,
    paidAt: ago(2),
    recordVersion: 1,
    ref,
  };
}

function mapping(ws: string, v: number, ref: SourceRef, from: string, to: string | null) {
  return {
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    mappingId: ref.key.mapping_id!,
    workspaceId: ws,
    validFrom: from,
    validTo: to,
    mappingVersion: v,
    sourceRef: "s",
    ref,
  };
}

function entitlement() {
  return {
    tenantId: "t-northwind",
    entitlementId: "ent-1",
    paymentLineId: "pl-1",
    feature: "reports",
    periodStart: ago(2),
    periodEnd: ago(-28),
    targetWorkspaceId: "ws-old",
    status: "active" as const,
    version: 1,
    updatedAt: ago(2),
    ref: entRef,
  };
}

function ingestStandardTrail(g: ReturnType<typeof emptyGathered>) {
  ingestToolFact(
    g,
    {
      payments: [payment("pl-1", payRef)],
      coverage: [{ tool: "get_payments", via: "zetaris", rows: 1, complete: true }],
    },
    SCOPE.tenantId,
    SCOPE.billingAccountId,
  );
  ingestToolFact(
    g,
    {
      mappings: [
        mapping("ws-old", 1, mapOldRef, ago(200), ago(10)),
        mapping("ws-new", 2, mapNewRef, ago(10), null),
      ],
      coverage: [{ tool: "get_workspace_mappings", via: "zetaris", rows: 2, complete: true }],
    },
    SCOPE.tenantId,
    SCOPE.billingAccountId,
  );
  ingestToolFact(
    g,
    {
      entitlements: [entitlement()],
      grants: [],
      runs: [],
      coverage: [{ tool: "get_entitlement_trail", via: "zetaris", rows: 1, complete: true }],
    },
    SCOPE.tenantId,
    SCOPE.billingAccountId,
  );
}

function repairCheck(): CheckResult {
  return {
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    observedAt: T,
    lines: [
      {
        paymentLineId: "pl-1",
        feature: "reports",
        status: "repair_candidate",
        missing: [],
        conditions: [
          {
            id: "mapping.unique_current",
            passed: true,
            detail: "current ws-new",
            refs: [mapNewRef],
          },
          {
            id: "entitlement.on_current_workspace",
            passed: false,
            detail: "on ws-old",
            refs: [entRef, mapNewRef],
          },
          {
            id: "payment.paid",
            passed: true,
            detail: "paid",
            refs: [payRef],
          },
        ],
      },
    ],
  };
}

test("legacy repairSuggestion parser stays isolated (full fields, rejects bad versions)", () => {
  assert.throws(() =>
    parseFindingLegacy({
      conclusion: "x",
      statusClaim: "repair_candidate",
      evidenceRefs: [],
      causalLinks: [],
      hypotheses: [],
      missingEvidence: [],
      repairSuggestion: {
        paymentLineId: "pl-1",
        entitlementId: "ent-1",
        feature: "reports",
        fromWorkspace: "a",
        toWorkspace: "b",
        expectedVersion: 1.5,
        mappingVersion: 2,
      },
    }),
  );
  const ok = parseFindingLegacy({
    conclusion: "x",
    statusClaim: "repair_candidate",
    evidenceRefs: [payRef],
    causalLinks: [],
    hypotheses: [],
    missingEvidence: [],
    repairSuggestion: {
      paymentLineId: "pl-1",
      entitlementId: "ent-1",
      feature: "reports",
      fromWorkspace: "ws-old",
      toWorkspace: "ws-new",
      expectedVersion: 1,
      mappingVersion: 2,
    },
  });
  assert.equal(ok.repairSuggestion?.expectedVersion, 1);
  assert.equal(ok.repairSuggestion?.paymentEvidenceId, undefined);
});

test("model repairSelection rejects expectedVersion and other derived fields", () => {
  assert.throws(
    () =>
      parseModelRepairSelection({
        paymentEvidenceId: "e1",
        entitlementEvidenceId: "e4",
        currentMappingEvidenceId: "e3",
        expectedVersion: 2,
      }),
    /expectedVersion is not accepted/,
  );
  assert.throws(
    () =>
      parseModelRepairSelection({
        paymentEvidenceId: "e1",
        entitlementEvidenceId: "e4",
        currentMappingEvidenceId: "e3",
        paymentLineId: "pl-1",
      }),
    /paymentLineId is not accepted/,
  );
});

test("unknown evidence IDs fail closed", () => {
  const g = emptyGathered();
  ingestStandardTrail(g);
  assert.throws(
    () =>
      resolveRepairSuggestion(
        { paymentEvidenceId: "e99", entitlementEvidenceId: "e4", currentMappingEvidenceId: "e3" },
        g.evidence,
        SCOPE,
      ),
    /unknown or foreign/,
  );
});

test("wrong-table / wrong-kind evidence IDs fail closed", () => {
  const g = emptyGathered();
  ingestStandardTrail(g);
  ingestToolFact(
    g,
    {
      grants: [
        {
          tenantId: "t-northwind",
          eventId: "g1",
          entitlementId: "ent-1",
          eventType: "grant",
          targetWorkspaceId: "ws-old",
          mappingVersionUsed: 1,
          actor: "x",
          at: ago(2),
          receiptId: null,
          ref: grantRef,
        },
      ],
    },
    SCOPE.tenantId,
    SCOPE.billingAccountId,
  );
  // e1 payment, e2 old map, e3 new map, e4 entitlement, e5 grant
  assert.throws(
    () =>
      resolveRepairSuggestion(
        { paymentEvidenceId: "e5", entitlementEvidenceId: "e4", currentMappingEvidenceId: "e3" },
        g.evidence,
        SCOPE,
      ),
    /payment record|wrong source\/table/,
  );
  assert.throws(
    () =>
      resolveRepairSuggestion(
        { paymentEvidenceId: "e1", entitlementEvidenceId: "e2", currentMappingEvidenceId: "e3" },
        g.evidence,
        SCOPE,
      ),
    /entitlement record|wrong source\/table/,
  );
});

test("mismatched payment line between payment and entitlement evidence fails", () => {
  const g = emptyGathered();
  ingestToolFact(
    g,
    { payments: [payment("pl-1", payRef), payment("pl-other", payOtherRef)] },
    SCOPE.tenantId,
    SCOPE.billingAccountId,
  );
  ingestToolFact(
    g,
    { mappings: [mapping("ws-new", 2, mapNewRef, ago(10), null)] },
    SCOPE.tenantId,
    SCOPE.billingAccountId,
  );
  ingestToolFact(g, { entitlements: [entitlement()] }, SCOPE.tenantId, SCOPE.billingAccountId);
  // e1=pl-1, e2=pl-other, e3=map, e4=ent(pl-1)
  assert.throws(
    () =>
      resolveRepairSuggestion(
        { paymentEvidenceId: "e2", entitlementEvidenceId: "e4", currentMappingEvidenceId: "e3" },
        g.evidence,
        SCOPE,
      ),
    /do not match the same payment line/,
  );
});

test("exact version preservation: entitlement v1 wins even when mapping is v2", () => {
  const g = emptyGathered();
  ingestStandardTrail(g);
  const sug = resolveRepairSuggestion(
    { paymentEvidenceId: "e1", entitlementEvidenceId: "e4", currentMappingEvidenceId: "e3" },
    g.evidence,
    SCOPE,
  );
  assert.equal(sug.expectedVersion, 1);
  assert.equal(sug.mappingVersion, 2);
  assert.equal(sug.fromWorkspace, "ws-old");
  assert.equal(sug.toWorkspace, "ws-new");
  assert.equal(sug.paymentLineId, "pl-1");
  assert.equal(sug.entitlementId, "ent-1");
  assert.equal(sug.feature, "reports");
});

test("valid candidate plan from evidence-ID repair suggestion", () => {
  const g = emptyGathered();
  ingestStandardTrail(g);
  const finding = parseAndResolveFinding(
    {
      conclusion: "retarget",
      statusClaim: "repair_candidate",
      causalLinks: [],
      hypotheses: [],
      missingEvidence: [],
      evidenceIds: ["e1", "e3", "e4"],
      repairSuggestion: {
        paymentEvidenceId: "e1",
        entitlementEvidenceId: "e4",
        currentMappingEvidenceId: "e3",
      },
    },
    g.evidence,
    SCOPE,
  );
  assert.equal(finding.repairSuggestion?.expectedVersion, 1);

  const ctx = {
    tenantId: SCOPE.tenantId,
    billingAccountId: SCOPE.billingAccountId,
    observedAt: T,
    payments: [payment("pl-1", payRef)],
    mappings: [
      mapping("ws-old", 1, mapOldRef, ago(200), ago(10)),
      mapping("ws-new", 2, mapNewRef, ago(10), null),
    ],
    migrations: [],
    entitlements: [entitlement()],
    grants: [],
    runs: [],
    coverage: [
      { tool: "get_payments", via: "zetaris" as const, rows: 1, complete: true },
      { tool: "get_workspace_mappings", via: "zetaris" as const, rows: 2, complete: true },
      { tool: "get_entitlement_trail", via: "zetaris" as const, rows: 1, complete: true },
      { tool: "check_conditions", via: "zetaris" as const, rows: 1, complete: true },
    ],
  };
  const built = tryBuildRepairPlan({
    tenantId: SCOPE.tenantId,
    billingAccountId: SCOPE.billingAccountId,
    finding,
    check: repairCheck(),
    coverage: ctx.coverage,
    context: ctx,
  });
  assert.ok(built.plan);
  assert.equal(built.plan!.expectedVersion, 1);
  assert.equal(built.plan!.mappingVersion, 2);
  assert.equal(built.plan!.toWorkspace, "ws-new");
});

test("payments/mappings/trail then check_conditions still preserves record kind/version for resolve", () => {
  const g = emptyGathered();
  ingestStandardTrail(g);
  assert.equal(g.evidence.lookup("e1").fact.kind, "payment");
  assert.equal(g.evidence.lookup("e3").fact.kind, "mapping");
  assert.equal(g.evidence.lookup("e4").fact.kind, "entitlement");
  assert.equal(g.evidence.lookup("e4").fact.version, 1);
  assert.equal(g.evidence.lookup("e3").fact.mappingVersion, 2);

  ingestToolFact(
    g,
    {
      check: repairCheck(),
      context: {
        tenantId: SCOPE.tenantId,
        billingAccountId: SCOPE.billingAccountId,
        observedAt: T,
        payments: [payment("pl-1", payRef)],
        mappings: [
          mapping("ws-old", 1, mapOldRef, ago(200), ago(10)),
          mapping("ws-new", 2, mapNewRef, ago(10), null),
        ],
        migrations: [],
        entitlements: [entitlement()],
        grants: [],
        runs: [],
        coverage: [{ tool: "check_conditions", via: "zetaris", rows: 1, complete: true }],
      },
      coverage: [{ tool: "check_conditions", via: "zetaris", rows: 1, complete: true }],
    },
    SCOPE.tenantId,
    SCOPE.billingAccountId,
  );

  assert.equal(g.evidence.lookup("e1").fact.kind, "payment", "condition_ref must not demote payment");
  assert.equal(g.evidence.lookup("e3").fact.kind, "mapping", "condition_ref must not demote mapping");
  assert.equal(g.evidence.lookup("e4").fact.kind, "entitlement", "condition_ref must not demote entitlement");
  assert.equal(g.evidence.lookup("e4").fact.version, 1);
  assert.equal(g.evidence.lookup("e3").fact.mappingVersion, 2);
  assert.ok(Array.isArray(g.evidence.lookup("e1").fact.conditionAnnotations));

  const sug = resolveRepairSuggestion(
    { paymentEvidenceId: "e1", entitlementEvidenceId: "e4", currentMappingEvidenceId: "e3" },
    g.evidence,
    SCOPE,
  );
  assert.equal(sug.expectedVersion, 1);
  assert.equal(sug.mappingVersion, 2);
});

test("condition_ref registered first is replaced by later authoritative record", () => {
  const g = emptyGathered();
  ingestToolFact(
    g,
    {
      check: {
        tenantId: SCOPE.tenantId,
        billingAccountId: SCOPE.billingAccountId,
        observedAt: T,
        lines: [
          {
            paymentLineId: "pl-1",
            feature: "reports",
            status: "needs_verification",
            missing: ["payment row"],
            conditions: [{ id: "payment.paid", passed: false, detail: "cited only", refs: [payRef] }],
          },
        ],
      },
    },
    SCOPE.tenantId,
    SCOPE.billingAccountId,
  );
  assert.equal(g.evidence.lookup("e1").fact.kind, "condition_ref");

  ingestToolFact(
    g,
    { payments: [payment("pl-1", payRef)] },
    SCOPE.tenantId,
    SCOPE.billingAccountId,
  );
  const fact = g.evidence.lookup("e1").fact;
  assert.equal(fact.kind, "payment");
  assert.equal(fact.paymentLineId, "pl-1");
  assert.ok(Array.isArray(fact.conditionAnnotations));
});
