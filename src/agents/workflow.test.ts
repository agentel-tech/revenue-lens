import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckResult, InvestigationContext, ReadCoverage, SourceRef, WorkspaceMapping } from "../contracts.ts";
import { asBoolean, parseInvestigatorDecision, parseCheckerDecision, parseFindingLegacy } from "./decisions.ts";
import { independentCausalSupport, materializeFinding, isRefObserved } from "./evidence.ts";
import { tryBuildRepairPlan, runInvestigation } from "./workflow.ts";
import type { ModelCaller, ToolRunner } from "./types.ts";

const T = "2026-10-23T12:00:00.000Z";
const ref = (source: SourceRef["source"], table: string, key: Record<string, string>, version = 1): SourceRef => ({
  source,
  table,
  key,
  via: "zetaris",
  version,
});

const ago = (days: number) => new Date(new Date(T).getTime() - days * 86_400_000).toISOString();

function mapping(ws: string, v: number, from: string, to: string | null): WorkspaceMapping {
  return {
    tenantId: "t-northwind",
    mappingId: `m-${ws}-${v}`,
    billingAccountId: "ba-1",
    workspaceId: ws,
    validFrom: from,
    validTo: to,
    mappingVersion: v,
    sourceRef: "s",
    ref: ref("workspace_map", "workspace_mappings", { mapping_id: `m-${ws}-${v}`, tenant_id: "t-northwind" }),
  };
}

function completeCoverage(): ReadCoverage[] {
  return [
    { tool: "get_payments", via: "zetaris", rows: 1, complete: true },
    { tool: "get_workspace_mappings", via: "zetaris", rows: 2, complete: true },
    { tool: "get_entitlement_trail", via: "zetaris", rows: 1, complete: true },
    { tool: "check_conditions", via: "zetaris", rows: 1, complete: true },
  ];
}

function repairCandidateCheck(opts?: { stalePassed?: boolean }): CheckResult {
  return {
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    observedAt: T,
    lines: [
      {
        paymentLineId: "pl-1",
        feature: "reports",
        status: "repair_candidate",
        conditions: [
          {
            id: "grant.used_stale_mapping",
            passed: opts?.stalePassed ?? false,
            detail: opts?.stalePassed ? "grant used closed mapping" : "no original grant event found",
            refs: [ref("entitlements", "entitlements", { entitlement_id: "ent-1", tenant_id: "t-northwind" })],
          },
        ],
        missing: [],
      },
    ],
  };
}

function repairContext(): InvestigationContext {
  return {
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    observedAt: T,
    payments: [
      {
        tenantId: "t-northwind",
        paymentLineId: "pl-1",
        billingAccountId: "ba-1",
        productId: "pro",
        features: ["reports"],
        periodStart: ago(2),
        periodEnd: ago(-28),
        amountCents: 100,
        currency: "USD",
        status: "paid",
        paidAt: ago(2),
        recordVersion: 1,
        ref: ref("billing", "payment_lines", { payment_line_id: "pl-1", tenant_id: "t-northwind" }),
      },
    ],
    mappings: [mapping("ws-old", 1, ago(200), ago(10)), mapping("ws-new", 2, ago(10), null)],
    migrations: [],
    entitlements: [
      {
        tenantId: "t-northwind",
        entitlementId: "ent-1",
        paymentLineId: "pl-1",
        feature: "reports",
        periodStart: ago(2),
        periodEnd: ago(-28),
        targetWorkspaceId: "ws-old",
        status: "active",
        version: 1,
        updatedAt: ago(2),
        ref: ref("entitlements", "entitlements", { entitlement_id: "ent-1", tenant_id: "t-northwind" }),
      },
    ],
    grants: [],
    runs: [],
    coverage: completeCoverage(),
  };
}

const observedFromCtx = () => {
  const c = repairContext();
  return [c.payments[0].ref, c.mappings[0].ref, c.mappings[1].ref, c.entitlements[0].ref];
};

test("asBoolean rejects string false and other coercions", () => {
  assert.equal(asBoolean(true, "t"), true);
  assert.equal(asBoolean(false, "f"), false);
  assert.throws(() => asBoolean("false", "x"));
  assert.throws(() => asBoolean("true", "x"));
  assert.throws(() => asBoolean(0, "x"));
  assert.throws(() => asBoolean(1, "x"));
});

test("legacy finding parser rejects string supported and bad versions", () => {
  assert.throws(() =>
    parseFindingLegacy({
      conclusion: "x",
      statusClaim: "repair_candidate",
      evidenceRefs: [],
      causalLinks: [{ cause: "a", effect: "b", refs: [], supported: "false" }],
      hypotheses: [],
      missingEvidence: [],
    }),
  );
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
        expectedVersion: 0,
        mappingVersion: 2,
      },
    }),
  );
  assert.throws(() =>
    parseFindingLegacy({
      conclusion: "x",
      statusClaim: "not_a_status",
      evidenceRefs: [],
      causalLinks: [],
      hypotheses: [],
      missingEvidence: [],
    }),
  );
});

test("model-supplied responseId is ignored (not provider metadata)", () => {
  const d = parseInvestigatorDecision(
    JSON.stringify({
      kind: "stop",
      reason: "enough",
      responseId: "provider-looking-id-do-not-trust",
    }),
  );
  assert.equal(d.kind, "stop");
  assert.equal("responseId" in d, false);
});

test("unsupported evidence refs fail closed on materialize", () => {
  const finding = parseFindingLegacy({
    conclusion: "x",
    statusClaim: "repair_candidate",
    evidenceRefs: [ref("billing", "payment_lines", { payment_line_id: "pl-forged" })],
    causalLinks: [],
    hypotheses: [],
    missingEvidence: [],
  });
  assert.throws(() => materializeFinding(finding, observedFromCtx(), repairCandidateCheck()));
});

test("model supported:true never upgrades causal links (inference only)", () => {
  const entRef = ref("entitlements", "entitlements", { entitlement_id: "ent-1", tenant_id: "t-northwind" });
  const link = {
    cause: "grant used stale mapping v1",
    effect: "entitlement on old workspace",
    refs: [entRef],
    supported: false,
    modelClaimedSupported: true,
  };
  // Even when grant.used_stale_mapping passed, prose links stay unsupported.
  assert.equal(independentCausalSupport(link, repairCandidateCheck({ stalePassed: false })), false);
  assert.equal(independentCausalSupport(link, repairCandidateCheck({ stalePassed: true })), false);

  const finding = materializeFinding(
    {
      conclusion: "stale",
      statusClaim: "repair_candidate",
      causalLinks: [link],
      hypotheses: [],
      missingEvidence: [],
      evidenceRefs: [entRef],
    },
    [entRef],
    repairCandidateCheck({ stalePassed: true }),
  );
  assert.equal(finding.causalLinks[0].modelClaimedSupported, true);
  assert.equal(finding.causalLinks[0].supported, false, "model causal links remain inference");
});

test("refsMatch requires exact key equality (tenant_id alone must not match every row)", () => {
  const observed = ref("entitlements", "entitlements", {
    tenant_id: "t-northwind",
    entitlement_id: "ent-1",
  });
  const subsetOnly = ref("entitlements", "entitlements", { tenant_id: "t-northwind" });
  const exact = ref("entitlements", "entitlements", {
    tenant_id: "t-northwind",
    entitlement_id: "ent-1",
  });
  const extraKey = ref("entitlements", "entitlements", {
    tenant_id: "t-northwind",
    entitlement_id: "ent-1",
    payment_line_id: "pl-1",
  });
  assert.equal(isRefObserved(subsetOnly, [observed]), false);
  assert.equal(isRefObserved(exact, [observed]), true);
  assert.equal(isRefObserved(extraKey, [observed]), false);
});

test("unrelated model causal link does not inherit support from any-line stale condition", () => {
  const payRef = ref("billing", "payment_lines", { payment_line_id: "pl-1", tenant_id: "t-northwind" });
  const unrelated = {
    cause: "customer changed password on stale device",
    effect: "reports feature unavailable",
    refs: [payRef],
    supported: false,
    modelClaimedSupported: true,
  };
  const check = repairCandidateCheck({ stalePassed: true });
  // Previously a regex + ANY grant.used_stale_mapping pass would wrongly promote this.
  assert.equal(independentCausalSupport(unrelated, check), false);
  const finding = materializeFinding(
    {
      conclusion: "unrelated prose",
      statusClaim: "repair_candidate",
      causalLinks: [unrelated],
      hypotheses: [],
      missingEvidence: [],
      evidenceRefs: [payRef],
    },
    [payRef],
    check,
  );
  assert.equal(finding.causalLinks[0].supported, false);
});

test("no evidence cannot yield a repair plan", () => {
  const built = tryBuildRepairPlan({
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    finding: {
      conclusion: "maybe stale",
      statusClaim: "repair_candidate",
      causalLinks: [],
      hypotheses: [],
      missingEvidence: [],
      evidenceRefs: [],
      repairSuggestion: {
        paymentLineId: "pl-1",
        entitlementId: "ent-1",
        feature: "reports",
        fromWorkspace: "ws-old",
        toWorkspace: "ws-new",
        expectedVersion: 1,
        mappingVersion: 2,
      },
    },
    check: repairCandidateCheck(),
    coverage: completeCoverage(),
    context: repairContext(),
  });
  assert.equal(built.plan, undefined);
  assert.match(built.reason ?? "", /evidenceRefs/i);
});

test("incomplete reads cannot yield a repair plan", () => {
  const built = tryBuildRepairPlan({
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    finding: {
      conclusion: "stale",
      statusClaim: "repair_candidate",
      causalLinks: [],
      hypotheses: [],
      missingEvidence: [],
      evidenceRefs: [ref("billing", "payment_lines", { payment_line_id: "pl-1", tenant_id: "t-northwind" })],
      repairSuggestion: {
        paymentLineId: "pl-1",
        entitlementId: "ent-1",
        feature: "reports",
        fromWorkspace: "ws-old",
        toWorkspace: "ws-new",
        expectedVersion: 1,
        mappingVersion: 2,
      },
    },
    check: repairCandidateCheck(),
    coverage: [{ tool: "get_entitlement_trail", via: "zetaris", rows: 500, complete: false }],
    context: repairContext(),
  });
  assert.equal(built.plan, undefined);
  assert.match(built.reason ?? "", /incomplete/i);
});

test("conflicting / non-candidate gate cannot yield a repair plan", () => {
  const check = repairCandidateCheck();
  check.lines[0].status = "needs_verification";
  check.lines[0].missing = ["which of the overlapping mappings is authoritative"];
  const built = tryBuildRepairPlan({
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    finding: {
      conclusion: "conflict",
      statusClaim: "needs_verification",
      causalLinks: [],
      hypotheses: [],
      missingEvidence: ["authoritative mapping"],
      evidenceRefs: [ref("workspace_map", "workspace_mappings", { mapping_id: "m1" })],
      repairSuggestion: {
        paymentLineId: "pl-1",
        entitlementId: "ent-1",
        feature: "reports",
        fromWorkspace: "ws-old",
        toWorkspace: "ws-new",
        expectedVersion: 1,
        mappingVersion: 2,
      },
    },
    check,
    coverage: completeCoverage(),
    context: repairContext(),
  });
  assert.equal(built.plan, undefined);
  assert.match(built.reason ?? "", /needs_verification|not repair_candidate/i);
});

test("tenant/account scope mismatch refuses plan even with repair_candidate", () => {
  const ctx = repairContext();
  ctx.tenantId = "t-other";
  const built = tryBuildRepairPlan({
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    finding: {
      conclusion: "stale",
      statusClaim: "repair_candidate",
      causalLinks: [],
      hypotheses: [],
      missingEvidence: [],
      evidenceRefs: [ref("billing", "payment_lines", { payment_line_id: "pl-1" })],
      repairSuggestion: {
        paymentLineId: "pl-1",
        entitlementId: "ent-1",
        feature: "reports",
        fromWorkspace: "ws-old",
        toWorkspace: "ws-new",
        expectedVersion: 1,
        mappingVersion: 2,
      },
    },
    check: repairCandidateCheck(),
    coverage: completeCoverage(),
    context: ctx,
  });
  assert.equal(built.plan, undefined);
  assert.match(built.reason ?? "", /scope mismatch/i);
});

function eligibleFinding(over: Partial<import("./types.ts").FindingProposal> = {}) {
  return {
    conclusion: "entitlement on prior workspace after migration",
    statusClaim: "repair_candidate" as const,
    causalLinks: [
      {
        cause: "grant used closed mapping v1",
        effect: "reports entitlement targets ws-old",
        refs: [ref("entitlements", "entitlements", { entitlement_id: "ent-1", tenant_id: "t-northwind" })],
        supported: false,
        modelClaimedSupported: true,
      },
    ],
    hypotheses: [],
    missingEvidence: [] as string[],
    evidenceRefs: [
      ref("entitlements", "entitlements", { entitlement_id: "ent-1", tenant_id: "t-northwind" }),
      ref("workspace_map", "workspace_mappings", { mapping_id: "m-ws-new-2", tenant_id: "t-northwind" }),
    ],
    repairSuggestion: {
      paymentLineId: "pl-1",
      entitlementId: "ent-1",
      feature: "reports",
      fromWorkspace: "ws-old",
      toWorkspace: "ws-new",
      expectedVersion: 1,
      mappingVersion: 2,
    },
    ...over,
  };
}

test("supported repair_candidate with fresh scoped context yields a plan", () => {
  const built = tryBuildRepairPlan({
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    finding: eligibleFinding(),
    check: repairCandidateCheck({ stalePassed: true }),
    coverage: completeCoverage(),
    context: repairContext(),
  });
  assert.ok(built.plan);
  assert.equal(built.plan!.toWorkspace, "ws-new");
});

test("model uncertainty never upgrades to plan even when gate is repair_candidate", () => {
  const claims = ["needs_verification", "unknown", "processing", "consistent"] as const;
  for (const statusClaim of claims) {
    const built = tryBuildRepairPlan({
      tenantId: "t-northwind",
      billingAccountId: "ba-1",
      finding: eligibleFinding({ statusClaim }),
      check: repairCandidateCheck({ stalePassed: true }),
      coverage: completeCoverage(),
      context: repairContext(),
    });
    assert.equal(built.plan, undefined, statusClaim);
    assert.match(built.reason ?? "", /not repair_candidate|uncertainty/i, statusClaim);
  }
  const missing = tryBuildRepairPlan({
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    finding: eligibleFinding({ statusClaim: "repair_candidate", missingEvidence: ["need grant event"] }),
    check: repairCandidateCheck({ stalePassed: true }),
    coverage: completeCoverage(),
    context: repairContext(),
  });
  assert.equal(missing.plan, undefined);
  assert.match(missing.reason ?? "", /missingEvidence/i);
});

test("checker feedback causes a genuine next tool action and receives gathered facts", async () => {
  const toolCalls: string[] = [];
  let checkerSawMappings = false;
  const payRef = ref("billing", "payment_lines", { payment_line_id: "pl-1", tenant_id: "t-northwind" });
  const mapRef = ref("workspace_map", "workspace_mappings", { mapping_id: "m-ws-new-2", tenant_id: "t-northwind" });
  const entRef = ref("entitlements", "entitlements", { entitlement_id: "ent-1", tenant_id: "t-northwind" });

  const tools: ToolRunner = async (name) => {
    toolCalls.push(name);
    if (name === "get_payments") {
      return {
        payments: [
          {
            tenantId: "t-northwind",
            billingAccountId: "ba-1",
            paymentLineId: "pl-1",
            status: "paid",
            features: ["reports"],
            productId: "pro",
            periodStart: ago(2),
            periodEnd: ago(-28),
            amountCents: 100,
            currency: "USD",
            paidAt: ago(2),
            recordVersion: 1,
            ref: payRef,
          },
        ],
        coverage: [{ tool: "get_payments", via: "zetaris", rows: 1, complete: true }],
      };
    }
    if (name === "get_workspace_mappings") {
      return {
        mappings: repairContext().mappings,
        migrations: [],
        coverage: [{ tool: "get_workspace_mappings", via: "zetaris", rows: 2, complete: true }],
      };
    }
    if (name === "get_entitlement_trail") {
      return {
        entitlements: repairContext().entitlements,
        grants: [],
        runs: [],
        coverage: [{ tool: "get_entitlement_trail", via: "zetaris", rows: 1, complete: true }],
      };
    }
    if (name === "check_conditions") {
      return { check: repairCandidateCheck({ stalePassed: true }), context: repairContext(), coverage: completeCoverage() };
    }
    return { coverage: [{ tool: name, via: "zetaris", rows: 0, complete: true }] };
  };

  let invCall = 0;
  const model: ModelCaller = async (messages, opts) => {
    if (opts.role === "checker") {
      const blob = messages.map((m) => m.content).join("\n");
      // Must receive actual gathered records, not only a status summary
      assert.match(blob, /"payments"/);
      assert.match(blob, /UNTRUSTED/);
      assert.match(blob, /evidenceId/);
      assert.equal(blob.includes('"source":"billing"'), false, "raw SourceRefs must not appear in checker payload");
      if (blob.includes("ws-old") || blob.includes("evidenceCatalog")) checkerSawMappings = true;
      if (opts.callIndex === 1) {
        return {
          text: JSON.stringify({
            kind: "need_evidence",
            feedback: "Need workspace mapping history to confirm prior ownership of ws-old",
            suggestedTool: "get_workspace_mappings",
          }),
          providerResponseId: null,
          model: "test-model",
          provider: "openai-compatible",
        };
      }
      return {
        text: JSON.stringify({ kind: "accept", note: "evidence now supports prior ownership" }),
        providerResponseId: null,
        model: "test-model",
        provider: "openai-compatible",
      };
    }

    invCall++;
    if (invCall === 1) {
      return {
        text: JSON.stringify({ kind: "call_tool", tool: "get_payments", seeking: "confirm paid period and features" }),
        providerResponseId: null,
        model: "test-model",
        provider: "openai-compatible",
      };
    }
    if (invCall === 2) {
      return {
        text: JSON.stringify({
          kind: "propose_finding",
          finding: {
            conclusion: "likely stale mapping",
            statusClaim: "repair_candidate",
            causalLinks: [],
            hypotheses: [{ id: "h1", claim: "stale mapping", status: "active", evidenceIds: ["e1"] }],
            missingEvidence: [],
            evidenceIds: ["e1"],
          },
        }),
        providerResponseId: null,
        model: "test-model",
        provider: "openai-compatible",
      };
    }
    if (invCall === 3) {
      return {
        text: JSON.stringify({
          kind: "call_tool",
          tool: "get_workspace_mappings",
          seeking: "discriminate current vs prior workspace ownership",
        }),
        providerResponseId: null,
        model: "test-model",
        provider: "openai-compatible",
      };
    }
    if (invCall === 4) {
      return {
        text: JSON.stringify({
          kind: "call_tool",
          tool: "get_entitlement_trail",
          seeking: "entitlement target and grant history",
        }),
        providerResponseId: null,
        model: "test-model",
        provider: "openai-compatible",
      };
    }
    // After payments(e1), mappings(e2,e3), entitlement(e4)
    return {
      text: JSON.stringify({
        kind: "propose_finding",
        finding: {
          conclusion: "entitlement on prior workspace; unique current mapping ws-new",
          statusClaim: "repair_candidate",
          causalLinks: [
            {
              cause: "grant used stale closed mapping",
              effect: "entitlement still on ws-old",
              evidenceIds: ["e4"],
              supported: true,
            },
          ],
          hypotheses: [
            { id: "h1", claim: "stale mapping grant", status: "supported", evidenceIds: ["e3"] },
            { id: "h2", claim: "never paid", status: "excluded", exclusionReason: "payment paid", evidenceIds: ["e1"] },
          ],
          missingEvidence: [],
          evidenceIds: ["e1", "e3", "e4"],
          repairSuggestion: {
            paymentEvidenceId: "e1",
            entitlementEvidenceId: "e4",
            currentMappingEvidenceId: "e3",
          },
        },
      }),
      providerResponseId: null,
      model: "test-model",
      provider: "openai-compatible",
    };
  };

  const run = await runInvestigation(
    { tenantId: "t-northwind", billingAccountId: "ba-1", observedAt: T },
    { model, tools },
  );

  assert.equal(run.status, "completed");
  assert.ok(toolCalls.includes("get_payments"));
  assert.ok(toolCalls.includes("get_workspace_mappings"), "checker feedback must trigger a real follow-up tool");
  const mapIdx = toolCalls.indexOf("get_workspace_mappings");
  const payIdx = toolCalls.indexOf("get_payments");
  assert.ok(mapIdx > payIdx);
  assert.ok(run.followUpActions.some((a) => a.includes("get_workspace_mappings")));
  assert.ok(run.checkerFeedback?.some((f) => /mapping/i.test(f)));
  assert.ok(run.repairPlan, "accepted finding with fresh gate should build plan");
  assert.equal(run.repairPlan!.expectedVersion, 1, "expectedVersion must come from entitlement record, not mapping v2");
  assert.equal(run.repairPlan!.mappingVersion, 2);
  assert.ok(toolCalls.filter((t) => t === "check_conditions").length >= 1, "fresh check_conditions required before plan");
  // Resolved finding keeps complete original SourceRefs for Why/plan
  assert.equal(run.finding?.evidenceRefs[0]?.source, "billing");
  assert.equal(run.finding?.evidenceRefs[0]?.table, "payment_lines");
  const modelSteps = run.trace.filter((t) => t.action === "model");
  assert.ok(modelSteps.every((t) => typeof t.callId === "string" && t.callId.length > 0));
  assert.ok(modelSteps.every((t) => t.providerResponseId === null));
  assert.ok(checkerSawMappings || run.gathered.mappings.length > 0);
  assert.equal(run.finding?.causalLinks[0]?.modelClaimedSupported, true);
  assert.equal(run.finding?.causalLinks[0]?.supported, false);
  assert.ok(run.lastCheck?.lines.some((l) => l.conditions.some((c) => c.id === "grant.used_stale_mapping" && c.passed)));
});

test("foreign evidence id fail closed without repair plan", async () => {
  const tools: ToolRunner = async (name) => {
    if (name === "get_payments") {
      return {
        payments: [
          {
            tenantId: "t-northwind",
            billingAccountId: "ba-1",
            paymentLineId: "pl-1",
            status: "paid",
            features: ["reports"],
            productId: "pro",
            periodStart: ago(2),
            periodEnd: ago(-28),
            amountCents: 1,
            currency: "USD",
            paidAt: ago(2),
            recordVersion: 1,
            ref: ref("billing", "payment_lines", { payment_line_id: "pl-1", tenant_id: "t-northwind" }),
          },
        ],
        coverage: [{ tool: "get_payments", via: "zetaris", rows: 1, complete: true }],
      };
    }
    return { check: repairCandidateCheck(), context: repairContext(), coverage: completeCoverage() };
  };
  let n = 0;
  const model: ModelCaller = async () => {
    n++;
    if (n === 1) {
      return {
        text: JSON.stringify({ kind: "call_tool", tool: "get_payments", seeking: "pay" }),
        providerResponseId: null,
        model: "t",
        provider: "openai-compatible",
      };
    }
    return {
      text: JSON.stringify({
        kind: "propose_finding",
        finding: {
          conclusion: "x",
          statusClaim: "repair_candidate",
          causalLinks: [],
          hypotheses: [],
          missingEvidence: [],
          evidenceIds: ["e99"],
        },
      }),
      providerResponseId: null,
      model: "t",
      provider: "openai-compatible",
    };
  };
  const run = await runInvestigation({ tenantId: "t-northwind", billingAccountId: "ba-1", observedAt: T }, { model, tools });
  assert.ok(run.status === "invalid_model_response" || run.status === "unsupported_decision");
  assert.equal(run.repairPlan, undefined);
  assert.ok(run.gathered.evidence.has("e1"), "tool read still registered e1");
  assert.equal(run.gathered.evidence.has("e99"), false);
});

test("tenant/account cannot be redirected by model output", async () => {
  const seen: { tenant_id: string; billing_account_id: string }[] = [];
  const tools: ToolRunner = async (_name, args) => {
    seen.push({ ...args });
    return { coverage: [{ tool: "get_payments", via: "zetaris", rows: 0, complete: true }] };
  };
  let n = 0;
  const model: ModelCaller = async () => {
    n++;
    if (n === 1) {
      return {
        text: JSON.stringify({
          kind: "call_tool",
          tool: "get_payments",
          seeking: "try other customer",
          tenant_id: "t-evil",
          billing_account_id: "ba-evil",
        }),
        providerResponseId: null,
        model: "test",
        provider: "openai-compatible",
      };
    }
    return {
      text: JSON.stringify({ kind: "stop", reason: "done probing lock" }),
      providerResponseId: null,
      model: "test",
      provider: "openai-compatible",
    };
  };

  const run = await runInvestigation(
    { tenantId: "t-northwind", billingAccountId: "ba-locked", observedAt: T },
    { model, tools },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tenant_id, "t-northwind");
  assert.equal(seen[0].billing_account_id, "ba-locked");
  assert.equal(run.tenantId, "t-northwind");
});

test("missing LLM key reports unavailable, not a fake model run", async () => {
  const run = await runInvestigation(
    { tenantId: "t-northwind", billingAccountId: "ba-1", observedAt: T },
    { model: null },
  );
  assert.equal(run.status, "unavailable");
  assert.equal(run.model.available, false);
  assert.equal(run.repairPlan, undefined);
  assert.ok(!run.trace.some((t) => t.action === "tool"));
  assert.equal(run.trace[0]?.providerResponseId, null);
});

test("parseInvestigatorDecision rejects write-like tools", () => {
  assert.throws(() =>
    parseInvestigatorDecision(JSON.stringify({ kind: "call_tool", tool: "execute_retarget", seeking: "fix" })),
  );
});

test("default model path never invents providerResponseId", async () => {
  // Injected model returns null; workflow must record null.
  const model: ModelCaller = async () => ({
    text: JSON.stringify({ kind: "stop", reason: "stop" }),
    providerResponseId: null,
    model: "x",
    provider: "openai-compatible",
  });
  const run = await runInvestigation(
    { tenantId: "t", billingAccountId: "ba", observedAt: T },
    { model, tools: async () => ({}) },
  );
  const m = run.trace.find((t) => t.action === "model");
  assert.equal(m?.providerResponseId, null);
  assert.ok(m?.callId && !m.callId.includes("provider"));
});

test("isRefObserved requires matching source/table/key", () => {
  const o = [ref("billing", "payment_lines", { payment_line_id: "pl-1" })];
  assert.equal(isRefObserved(ref("billing", "payment_lines", { payment_line_id: "pl-1" }), o), true);
  assert.equal(isRefObserved(ref("billing", "payment_lines", { payment_line_id: "pl-2" }), o), false);
});

test("checker suggestedTool must be allowlisted enum", () => {
  assert.throws(() =>
    parseCheckerDecision(JSON.stringify({ kind: "need_evidence", feedback: "x", suggestedTool: "run_sql" })),
  );
});
