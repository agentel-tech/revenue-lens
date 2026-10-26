import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceRef } from "../contracts.ts";
import { emptyGathered, ingestToolFact, toModelFacingFact, checkerFactsPayload } from "./evidence.ts";
import { parseAndResolveFinding, parseInvestigatorDecision } from "./decisions.ts";
import { runInvestigation } from "./workflow.ts";
import type { ModelCaller, ToolRunner } from "./types.ts";

const T = "2026-10-23T12:00:00.000Z";
const payRef: SourceRef = {
  source: "billing",
  table: "payment_lines",
  key: { payment_line_id: "pl-1", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 1,
};

test("evidence IDs issued only after scoped tool ingest", () => {
  const g = emptyGathered();
  assert.equal(g.evidence.size, 0);
  assert.throws(
    () =>
      parseInvestigatorDecision(
        JSON.stringify({
          kind: "propose_finding",
          finding: {
            conclusion: "x",
            statusClaim: "unknown",
            causalLinks: [],
            hypotheses: [],
            missingEvidence: [],
            evidenceIds: ["e1"],
          },
        }),
        g.evidence,
        { tenantId: "t-northwind", billingAccountId: "ba-1" },
      ),
    /unknown or foreign/,
  );

  ingestToolFact(
    g,
    {
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
    },
    "t-northwind",
    "ba-1",
  );
  assert.equal(g.evidence.size, 1);
  assert.ok(g.evidence.has("e1"));
  const facing = toModelFacingFact(
    {
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
    },
    g,
  ) as { payments: Array<{ evidenceId: string; ref?: unknown }> };
  assert.equal(facing.payments[0].evidenceId, "e1");
  assert.equal(facing.payments[0].ref, undefined);

  const checker = JSON.stringify(
    checkerFactsPayload(g, { tenantId: "t-northwind", billingAccountId: "ba-1", observedAt: T }),
  );
  assert.match(checker, /"evidenceId":"e1"/);
  assert.equal(checker.includes('"ref":'), false, "raw SourceRef fields must not appear in checker payload");
});

test("wrong/foreign evidence id fail closed; no fabricated refs", () => {
  const g = emptyGathered();
  ingestToolFact(
    g,
    {
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
    },
    "t-northwind",
    "ba-1",
  );
  const scope = { tenantId: "t-northwind", billingAccountId: "ba-1" };
  assert.throws(() => parseAndResolveFinding({
    conclusion: "x",
    statusClaim: "unknown",
    causalLinks: [],
    hypotheses: [],
    missingEvidence: [],
    evidenceIds: ["e2"],
  }, g.evidence, scope), /foreign|unknown/);
  assert.throws(() => parseAndResolveFinding({
    conclusion: "x",
    statusClaim: "unknown",
    causalLinks: [],
    hypotheses: [],
    missingEvidence: [],
    evidenceRefs: [payRef],
  }, g.evidence, scope), /evidenceRefs are not accepted/);
  assert.throws(() => parseAndResolveFinding({
    conclusion: "x",
    statusClaim: "unknown",
    causalLinks: [],
    hypotheses: [],
    missingEvidence: [],
    evidenceIds: [{ source: "billing", table: "payment_lines", key: { payment_line_id: "pl-1" }, via: "zetaris" }],
  }, g.evidence, scope), /SourceRef objects are rejected/);
});

test("resolution preserves exact original SourceRef", () => {
  const g = emptyGathered();
  ingestToolFact(
    g,
    {
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
    },
    "t-northwind",
    "ba-1",
  );
  const finding = parseAndResolveFinding({
    conclusion: "live-like",
    statusClaim: "unknown",
    causalLinks: [{ cause: "paid", effect: "period active", evidenceIds: ["e1"], supported: false }],
    hypotheses: [{ id: "h1", claim: "paid", status: "active", evidenceIds: ["e1"] }],
    missingEvidence: [],
    evidenceIds: ["e1"],
  }, g.evidence, { tenantId: "t-northwind", billingAccountId: "ba-1" });
  assert.deepEqual(finding.evidenceRefs[0], payRef);
  assert.deepEqual(finding.causalLinks[0].refs[0], payRef);
  assert.equal(finding.causalLinks[0].supported, false);
});

test("live-like finding shape + checker feedback still triggers follow-up tool", async () => {
  const toolCalls: string[] = [];
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
    if (name === "get_workspace_mappings") {
      return {
        mappings: [],
        migrations: [],
        coverage: [{ tool: "get_workspace_mappings", via: "zetaris", rows: 0, complete: true }],
      };
    }
    return { coverage: [{ tool: name, via: "zetaris", rows: 0, complete: true }] };
  };
  let inv = 0;
  const model: ModelCaller = async (_m, opts) => {
    if (opts.role === "checker") {
      if (opts.callIndex === 1) {
        return {
          text: JSON.stringify({
            kind: "need_evidence",
            feedback: "Need mappings",
            suggestedTool: "get_workspace_mappings",
          }),
          providerResponseId: null,
          model: "t",
          provider: "openai-compatible",
        };
      }
      return {
        text: JSON.stringify({ kind: "accept", note: "ok" }),
        providerResponseId: null,
        model: "t",
        provider: "openai-compatible",
      };
    }
    inv++;
    if (inv === 1) {
      return {
        text: JSON.stringify({ kind: "call_tool", tool: "get_payments", seeking: "pay" }),
        providerResponseId: null,
        model: "t",
        provider: "openai-compatible",
      };
    }
    if (inv === 2) {
      return {
        text: JSON.stringify({
          kind: "propose_finding",
          finding: {
            conclusion: "partial",
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
    }
    if (inv === 3) {
      return {
        text: JSON.stringify({
          kind: "call_tool",
          tool: "get_workspace_mappings",
          seeking: "mappings after checker",
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
          conclusion: "still incomplete",
          statusClaim: "needs_verification",
          causalLinks: [],
          hypotheses: [],
          missingEvidence: ["more"],
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
  assert.ok(toolCalls.includes("get_workspace_mappings"));
  assert.ok(run.followUpActions.some((a) => a.includes("get_workspace_mappings")));
  assert.deepEqual(run.finding?.evidenceRefs[0], payRef);
});
