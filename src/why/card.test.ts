import { test } from "node:test";
import assert from "node:assert/strict";
import type { InvestigationRun } from "../agents/types.ts";
import { PROPOSED_ROLES } from "../agents/types.ts";
import { EvidenceRegistry } from "../agents/evidence-registry.ts";
import { buildWhyCard } from "./card.ts";
import { whyCardToHtml } from "./html.ts";
import { whyCardToMarkdown } from "./markdown.ts";
import { escapeHtml } from "./escape.ts";

function baseRun(over: Partial<InvestigationRun> = {}): InvestigationRun {
  return {
    runId: "run-1",
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    observedAt: "2026-10-23T12:00:00.000Z",
    status: "completed",
    model: { model: "test", provider: "openai-compatible", available: true },
    proposedRoles: PROPOSED_ROLES,
    identityBound: false,
    trace: [],
    coverage: [],
    gathered: {
      payments: [],
      mappings: [],
      migrations: [],
      entitlements: [],
      grants: [],
      runs: [],
      coverage: [],
      observedRefs: [],
      evidence: new EvidenceRegistry(),
    },
    finding: {
      conclusion: "Entitlement may sit on a prior workspace",
      statusClaim: "repair_candidate",
      causalLinks: [
        {
          cause: "grant used stale mapping",
          effect: "wrong workspace",
          refs: [],
          supported: false,
          modelClaimedSupported: true,
        },
      ],
      hypotheses: [],
      missingEvidence: [],
      evidenceRefs: [],
    },
    checkerFeedback: [],
    followUpActions: [],
    repairConfirmed: false,
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
    ...over,
  };
}

test("Why card never reports recovery before receipt plus successful probe", () => {
  const planned = buildWhyCard(
    baseRun({
      repairPlan: {
        action: "retarget_entitlement",
        tenantId: "t-northwind",
        billingAccountId: "ba-1",
        paymentLineId: "pl-1",
        entitlementId: "ent-1",
        feature: "reports",
        fromWorkspace: "ws-old",
        toWorkspace: "ws-new",
        expectedVersion: 1,
        mappingVersion: 2,
        intentKey: "retarget:t:ent-1:v1",
        payloadFingerprint: "abc",
        evidenceRefs: [],
        proposedBy: "investigator",
      },
    }),
  );
  assert.equal(planned.customerRecovered, false);
  assert.equal(planned.repair.state, "planned_not_executed");

  const executedOnly = buildWhyCard(
    baseRun({
      repairPlan: planned.repair.state === "planned_not_executed" ? planned.repair.plan : undefined,
      receipt: {
        outcome: "applied",
        detail: "moved",
        receiptId: "rcpt-1",
        at: "2026-10-23T12:01:00.000Z",
      },
      accessProbe: { workspace: "ws-new", feature: "reports", status: 403, body: {}, at: "2026-10-23T12:01:01.000Z" },
    }),
  );
  assert.equal(executedOnly.customerRecovered, false);
  assert.equal(executedOnly.repair.state, "executed");

  const recovered = buildWhyCard(
    baseRun({
      repairPlan: planned.repair.state === "planned_not_executed" ? planned.repair.plan : undefined,
      receipt: {
        outcome: "applied",
        detail: "moved",
        receiptId: "rcpt-1",
        at: "2026-10-23T12:01:00.000Z",
      },
      accessProbe: { workspace: "ws-new", feature: "reports", status: 200, body: {}, at: "2026-10-23T12:01:01.000Z" },
    }),
  );
  assert.equal(recovered.customerRecovered, true);
  assert.equal(recovered.repair.state, "recovered");
});

test("model causal links stay inference; gate conditions render separately", () => {
  const card = buildWhyCard(
    baseRun({
      lastCheck: {
        tenantId: "t-northwind",
        billingAccountId: "ba-1",
        observedAt: "2026-10-23T12:00:00.000Z",
        lines: [
          {
            paymentLineId: "pl-1",
            feature: "reports",
            status: "repair_candidate",
            missing: [],
            conditions: [
              {
                id: "grant.used_stale_mapping",
                passed: true,
                detail: "grant used closed mapping",
                refs: [{ source: "entitlements", table: "grant_events", key: { event_id: "g1" }, via: "zetaris" }],
              },
            ],
          },
        ],
      },
    }),
  );
  assert.equal(card.inferenceCausalLinks.length, 1);
  assert.equal(card.inferenceCausalLinks[0].supported, false);
  assert.equal(card.inferenceCausalLinks[0].modelClaimedSupported, true);
  assert.equal(card.passedSourceBackedChecks.length, 1);
  assert.equal(card.passedSourceBackedChecks[0].conditionId, "grant.used_stale_mapping");
});

test("HTML export escapes untrusted data", () => {
  const card = buildWhyCard(
    baseRun({
      finding: {
        conclusion: `<script>alert("xss")</script>`,
        statusClaim: "unknown",
        causalLinks: [],
        hypotheses: [
          {
            id: "h1",
            claim: "maybe stale",
            status: "active",
            refs: [],
          },
        ],
        missingEvidence: [`</ul><img src=x onerror=alert(1)>`],
        evidenceRefs: [
          { source: "billing", table: "payment_lines", key: { payment_line_id: "pl-1" }, via: "zetaris" },
        ],
      },
    }),
  );
  const html = whyCardToHtml(card);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img"), false);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&lt;img"));
  assert.equal(/<img[^>]*onerror=/i.test(html), false);
  assert.match(html, /observedAt/);
  assert.match(html, /tag-inf/);
  assert.match(html, /why-citations/);
  assert.match(html, /why-after/);
  assert.match(html, /inference/);
  const md = whyCardToMarkdown(card);
  assert.ok(md.includes("Customer recovered: **no**"));
});

test("model vs gate disagreement is visible and write is not authorized", () => {
  const card = buildWhyCard(
    baseRun({
      eligibility: "repair_candidate",
      finding: {
        conclusion: "uncertain cause",
        statusClaim: "needs_verification",
        causalLinks: [],
        hypotheses: [],
        missingEvidence: ["discriminating grant"],
        evidenceRefs: [],
      },
      repairPlan: {
        action: "retarget_entitlement",
        tenantId: "t-northwind",
        billingAccountId: "ba-1",
        paymentLineId: "pl-1",
        entitlementId: "ent-1",
        feature: "reports",
        fromWorkspace: "ws-old",
        toWorkspace: "ws-new",
        expectedVersion: 1,
        mappingVersion: 2,
        intentKey: "retarget:t:ent-1:v1",
        payloadFingerprint: "abc",
        evidenceRefs: [],
        proposedBy: "investigator",
      },
    }),
  );
  assert.equal(card.modelStatusClaim, "needs_verification");
  assert.equal(card.eligibility, "repair_candidate");
  assert.equal(card.assessmentsDisagree, true);
  assert.equal(card.furtherInvestigationRequired, true);
  assert.equal(card.writeAuthorized, false);
  const html = whyCardToHtml(card);
  assert.match(html, /Disagreement|Further investigation/i);
  assert.match(html, /not actionable|further investigation/i);
  assert.equal(card.customerRecovered, false);
});

test("escapeHtml covers quotes and ampersands", () => {
  assert.equal(escapeHtml(`a&b<"'>`), "a&amp;b&lt;&quot;&#39;&gt;");
});

test("Why exports expose negative proposition separately from preserved model wording",()=>{
  const card=buildWhyCard(baseRun({finding:{conclusion:'review',statusClaim:'consistent',causalLinks:[],hypotheses:[{id:'negative',claim:'ambiguous <model wording>',conditionId:'entitlement.on_current_workspace',conditionExpectedPassed:false,paymentLineId:'pl-1',status:'supported',refs:[]}],missingEvidence:[],evidenceRefs:[]}}));
  const html=whyCardToHtml(card), md=whyCardToMarkdown(card);
  assert.ok(html.includes('Condition proposition:'));assert.ok(html.includes('expected <code>false</code>'));
  assert.ok(html.includes('ambiguous &lt;model wording&gt;'));assert.ok(md.includes('expected false for pl-1'));
  assert.ok(md.includes('Model wording (inference)'));
});
