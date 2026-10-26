import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceRef } from "../contracts.ts";
import { runInvestigation } from "./workflow.ts";
import type { ModelCaller, ToolRunner } from "./types.ts";
import { assertSafeFinishReason } from "./provider.ts";

const T = "2026-10-23T12:00:00.000Z";
const payRef: SourceRef = {
  source: "billing",
  table: "payment_lines",
  key: { payment_line_id: "pl-1", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 1,
};

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
          periodStart: T,
          periodEnd: "2099-01-01T00:00:00.000Z",
          amountCents: 1,
          currency: "USD",
          paidAt: T,
          recordVersion: 1,
          ref: payRef,
        },
      ],
      coverage: [{ tool: "get_payments", via: "zetaris", rows: 1, complete: true }],
    };
  }
  return { coverage: [{ tool: name, via: "zetaris", rows: 0, complete: true }] };
};

test("investigator schema correction: raw SourceRef then evidenceId succeeds", async () => {
  let inv = 0;
  const model: ModelCaller = async (_m, opts) => {
    if (opts.role === "checker") {
      return {
        text: JSON.stringify({ kind: "accept", note: "ok" }),
        providerResponseId: null,
        finishReason: "stop",
        model: "t",
        provider: "openai-compatible",
      };
    }
    inv++;
    if (inv === 1) {
      return {
        text: JSON.stringify({ kind: "call_tool", tool: "get_payments", seeking: "payments" }),
        providerResponseId: null,
        model: "t",
        provider: "openai-compatible",
      };
    }
    if (inv === 2) {
      // Invalid: embedding SourceRef object inside evidenceIds
      return {
        text: JSON.stringify({
          kind: "propose_finding",
          finding: {
            conclusion: "paid",
            statusClaim: "unknown",
            causalLinks: [],
            hypotheses: [],
            missingEvidence: [],
            evidenceIds: [{ source: "grant_events", table: "grant_events", key: { event_id: "g1" }, via: "zetaris" }],
          },
        }),
        providerResponseId: null,
        model: "t",
        provider: "openai-compatible",
      };
    }
    return {
      text: JSON.stringify({
        kind: "propose_finding",
        finding: {
          conclusion: "payment observed",
          statusClaim: "unknown",
          causalLinks: [],
          hypotheses: [],
          missingEvidence: ["mappings"],
          evidenceIds: ["e1"],
        },
      }),
      providerResponseId: null,
      model: "t",
      provider: "openai-compatible",
    };
  };

  const run = await runInvestigation(
    { tenantId: "t-northwind", billingAccountId: "ba-1", observedAt: T },
    { model, tools },
  );
  assert.equal(run.status, "completed");
  assert.ok(run.followUpActions.some((a) => a.startsWith("schema_correction:investigator:")));
  assert.equal(run.finding?.evidenceRefs[0]?.source, "billing");
  assert.deepEqual(run.finding?.evidenceRefs[0]?.key, payRef.key);
});

test("investigator repeated invalid exhausts single correction then invalid_model_response", async () => {
  let inv = 0;
  const model: ModelCaller = async () => {
    inv++;
    return {
      text: JSON.stringify({
        kind: "propose_finding",
        finding: {
          conclusion: "x",
          statusClaim: "unknown",
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
  const run = await runInvestigation(
    { tenantId: "t-northwind", billingAccountId: "ba-1", observedAt: T },
    { model, tools: async () => ({ coverage: [] }) },
  );
  assert.equal(run.status, "invalid_model_response");
  assert.equal(run.followUpActions.filter((a) => a.startsWith("schema_correction:investigator:")).length, 1);
  assert.equal(inv, 2);
  assert.equal(run.repairPlan, undefined);
  assert.ok(!run.trace.some((t) => t.action === "tool"));
});

test("checker schema correction then accept", async () => {
  let inv = 0;
  let chk = 0;
  const model: ModelCaller = async (_m, opts) => {
    if (opts.role === "investigator") {
      inv++;
      if (inv === 1) {
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
            conclusion: "paid line present",
            statusClaim: "unknown",
            causalLinks: [],
            hypotheses: [],
            missingEvidence: [],
            evidenceIds: ["e1"],
          },
        }),
        providerResponseId: null,
        model: "t",
        provider: "openai-compatible",
      };
    }
    chk++;
    if (chk === 1) {
      return {
        text: JSON.stringify({ kind: "need_evidence", feedback: "more", suggestedTool: "run_sql" }),
        providerResponseId: null,
        model: "t",
        provider: "openai-compatible",
      };
    }
    return {
      text: JSON.stringify({ kind: "accept", note: "schema fixed" }),
      providerResponseId: null,
      model: "t",
      provider: "openai-compatible",
    };
  };
  const run = await runInvestigation(
    { tenantId: "t-northwind", billingAccountId: "ba-1", observedAt: T },
    { model, tools },
  );
  assert.equal(run.status, "completed");
  assert.ok(run.followUpActions.some((a) => a.startsWith("schema_correction:checker:")));
  assert.equal(chk, 2);
});

test("assertSafeFinishReason rejects length and content_filter", () => {
  assert.doesNotThrow(() => assertSafeFinishReason("stop"));
  assert.doesNotThrow(() => assertSafeFinishReason(undefined));
  assert.throws(() => assertSafeFinishReason("length"), /finish_reason rejected: length/);
  assert.throws(() => assertSafeFinishReason("content_filter"), /finish_reason rejected: content_filter/);
});

test("finish_reason length rejected before parse even with valid-looking JSON", async () => {
  const model: ModelCaller = async () => ({
    text: JSON.stringify({ kind: "stop", reason: "looks valid" }),
    providerResponseId: "id-1",
    finishReason: "length",
    model: "t",
    provider: "openai-compatible",
  });
  const run = await runInvestigation(
    { tenantId: "t-northwind", billingAccountId: "ba-1", observedAt: T },
    { model, tools: async () => ({}) },
  );
  assert.equal(run.status, "invalid_model_response");
  assert.match(String((run.trace[0]?.decision as { detail?: string })?.detail), /finish_reason rejected: length/);
});
