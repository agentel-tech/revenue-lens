import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROPOSED_ROLES, type InvestigationRun } from "../agents/types.ts";
import { EvidenceRegistry } from "../agents/evidence-registry.ts";
import {
  lessonFromRun,
  MEMORY_EMBEDDING_DISCLOSURE,
  openMemory,
} from "./store.ts";

function completedRun(over: Partial<InvestigationRun> = {}): InvestigationRun {
  return {
    runId: "run-mem-1",
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    observedAt: "2026-10-23T12:00:00.000Z",
    status: "completed",
    model: { model: "test", provider: "openai-compatible", available: true },
    proposedRoles: PROPOSED_ROLES,
    identityBound: false,
    trace: [
      {
        step: 1,
        role: "checker",
        action: "model",
        decision: { kind: "accept", note: "ok" },
        at: "2026-10-23T12:00:00.000Z",
      },
    ],
    coverage: [{ tool: "check_conditions", via: "zetaris", rows: 1, complete: true }],
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
              detail: "stale",
              refs: [{ source: "entitlements", table: "grant_events", key: { event_id: "g1" }, via: "zetaris" }],
            },
          ],
        },
      ],
    },
    eligibility: "repair_candidate",
    finding: {
      conclusion: "MODEL PROSE THAT MUST NOT BECOME AUTHORITATIVE LESSON TEXT",
      statusClaim: "repair_candidate",
      causalLinks: [],
      hypotheses: [],
      missingEvidence: [],
      evidenceRefs: [{ source: "entitlements", table: "entitlements", key: { entitlement_id: "ent-1" }, via: "zetaris" }],
    },
    followUpActions: [],
    checkerFeedback: [],
    repairConfirmed: false,
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
    ...over,
  };
}

test("lessonFromRun skips incomplete / unavailable / unaccepted runs", () => {
  assert.equal(lessonFromRun(completedRun({ status: "unavailable" })), null);
  assert.equal(
    lessonFromRun(
      completedRun({
        trace: [{ step: 1, role: "checker", action: "model", decision: { kind: "reject", feedback: "no" }, at: "x" }],
      }),
    ),
    null,
  );
  assert.equal(
    lessonFromRun(
      completedRun({
        finding: {
          conclusion: "x",
          statusClaim: "repair_candidate",
          causalLinks: [],
          hypotheses: [],
          missingEvidence: ["more"],
          evidenceRefs: [],
        },
      }),
    ),
    null,
  );
});

test("empty coverage rejected", () => {
  assert.equal(lessonFromRun(completedRun({ coverage: [] })), null);
  assert.equal(
    lessonFromRun(
      completedRun({
        coverage: [{ tool: "check_conditions", via: "zetaris", rows: 1, complete: false }],
      }),
    ),
    null,
  );
});

test("lastCheck scope mismatch rejected", () => {
  assert.equal(
    lessonFromRun(
      completedRun({
        lastCheck: {
          tenantId: "t-other",
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
                  detail: "stale",
                  refs: [{ source: "entitlements", table: "grant_events", key: { event_id: "g1" }, via: "zetaris" }],
                },
              ],
            },
          ],
        },
      }),
    ),
    null,
  );
  assert.equal(
    lessonFromRun(
      completedRun({
        lastCheck: {
          tenantId: "t-northwind",
          billingAccountId: "ba-OTHER",
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
                  detail: "stale",
                  refs: [{ source: "entitlements", table: "grant_events", key: { event_id: "g1" }, via: "zetaris" }],
                },
              ],
            },
          ],
        },
      }),
    ),
    null,
  );
});

test("statusClaim / eligibility disagreement rejected — no confident repair lesson from uncertainty", () => {
  assert.equal(
    lessonFromRun(
      completedRun({
        eligibility: "needs_verification",
        finding: {
          conclusion: "model claimed repair anyway",
          statusClaim: "repair_candidate",
          causalLinks: [],
          hypotheses: [],
          missingEvidence: [],
          evidenceRefs: [],
        },
      }),
    ),
    null,
  );
  assert.equal(lessonFromRun(completedRun({ eligibility: undefined })), null);
});

test("unresolved line.missing and conditions without refs rejected", () => {
  assert.equal(
    lessonFromRun(
      completedRun({
        lastCheck: {
          tenantId: "t-northwind",
          billingAccountId: "ba-1",
          observedAt: "2026-10-23T12:00:00.000Z",
          lines: [
            {
              paymentLineId: "pl-1",
              feature: "reports",
              status: "repair_candidate",
              missing: ["need mapping version"],
              conditions: [
                {
                  id: "grant.used_stale_mapping",
                  passed: true,
                  detail: "stale",
                  refs: [{ source: "entitlements", table: "grant_events", key: { event_id: "g1" }, via: "zetaris" }],
                },
              ],
            },
          ],
        },
      }),
    ),
    null,
  );
  assert.equal(
    lessonFromRun(
      completedRun({
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
              conditions: [{ id: "grant.used_stale_mapping", passed: true, detail: "stale", refs: [] }],
            },
          ],
        },
      }),
    ),
    null,
  );
});

test("source-backed stale signal changes priority hint only — not permissions; no model prose", () => {
  const lesson = lessonFromRun(completedRun());
  assert.ok(lesson);
  assert.equal(lesson!.suggestedPriority[0], "get_workspace_mappings");
  assert.ok(lesson!.conditionIds.includes("grant.used_stale_mapping"));
  assert.match(lesson!.hint, /hint, not current fact/i);
  assert.equal(lesson!.sourceRunId, "run-mem-1");
  assert.ok(!lesson!.hint.includes("MODEL PROSE"));
  assert.ok(!JSON.stringify(lesson).includes("rl_test_"));
  assert.equal("eligibility" in lesson!, false);
  assert.equal("permission" in lesson!, false);
  assert.equal("canRepair" in lesson!, false);
});

test("H-MEM recall tenant-scoped; allowlist priority; limit clamp; reference embedding disclosure; reopen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-mem-"));
  try {
    const mem = await openMemory(dir);
    assert.match(mem.embeddingDisclosure, /reference/i);
    assert.ok(!/nvidia/i.test(mem.embeddingDisclosure) || mem.embeddingDisclosure.includes("not NVIDIA"));
    assert.equal(mem.embeddingDisclosure, MEMORY_EMBEDDING_DISCLOSURE);

    const north = lessonFromRun(completedRun({ runId: "run-n", tenantId: "t-northwind" }))!;
    const contoso = lessonFromRun(
      completedRun({
        runId: "run-c",
        tenantId: "t-contoso",
        lastCheck: {
          tenantId: "t-contoso",
          billingAccountId: "ba-1",
          observedAt: "2026-10-23T12:00:00.000Z",
          lines: [
            {
              paymentLineId: "pl-c",
              feature: "reports",
              status: "consistent",
              missing: [],
              conditions: [
                {
                  id: "payment.paid",
                  passed: true,
                  detail: "paid",
                  refs: [{ source: "billing", table: "payment_lines", key: { payment_line_id: "pl-c" }, via: "zetaris" }],
                },
              ],
            },
          ],
        },
        eligibility: "consistent",
        finding: {
          conclusion: "ok",
          statusClaim: "consistent",
          causalLinks: [],
          hypotheses: [],
          missingEvidence: [],
          evidenceRefs: [{ source: "billing", table: "payment_lines", key: { payment_line_id: "pl-c" }, via: "zetaris" }],
        },
      }),
    )!;
    assert.ok(north);
    assert.ok(contoso);
    await mem.rememberLesson(north);
    await mem.rememberLesson(contoso);

    // Inject a non-allowlisted priority into content via rememberLesson sanitizer path:
    await mem.rememberLesson({
      ...north,
      sourceRunId: "run-evil",
      suggestedPriority: ["get_workspace_mappings", "drop_table", "shell_exec", "check_conditions"],
    });

    const recalled = await mem.recallPriority("repair candidate workspace mapping", {
      tenantId: "t-northwind",
      limit: -3, // clamped to default positive
    });
    assert.ok(recalled.suggestedPriority.includes("get_workspace_mappings"));
    assert.ok(recalled.suggestedPriority.every((t) => ["get_payments", "get_workspace_mappings", "get_entitlement_trail", "check_conditions"].includes(t)));
    assert.equal(recalled.suggestedPriority.includes("drop_table"), false);
    assert.ok(recalled.memories.every((m) => m.tenantId === "t-northwind"));
    assert.equal(recalled.memories.some((m) => m.content.includes("t-contoso")), false);
    assert.equal("eligibility" in recalled, false);
    assert.ok(recalled.memories.every((m) => m.content.includes("kind=hint_not_current_fact")));

    await assert.rejects(() => mem.recallPriority("x", { tenantId: "" } as { tenantId: string }), /tenantId/);

    const mem2 = await openMemory(dir);
    assert.equal(mem2.embeddingDisclosure, MEMORY_EMBEDDING_DISCLOSURE);
    const again = await mem2.recallPriority("entitlement workspace", { tenantId: "t-northwind", limit: 2 });
    assert.ok(again.memories.length >= 1 && again.memories.length <= 2);
    assert.ok(again.memories.every((m) => !m.content.includes("rl_test_")));
    assert.ok(again.memories.every((m) => !m.content.includes("MODEL PROSE")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("historical unaudited memories remain on disk but are excluded from recall", async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rl-legacy-memory-'));
  try {
    const {loadHMEM}=await import('../engine.ts');const {HMEM}=await loadHMEM();
    const legacy=new HMEM({persistDir:dir,actor:'test'});
    legacy.add({content:'kind=hint_not_current_fact | tenant=t-northwind | sourceRun=run-old | priority=get_workspace_mappings | hint=investigate entitlement workspace mapping',type:'general',source:'legacy-test'});
    const before=fs.readFileSync(path.join(dir,'state.json'),'utf8');
    const mem=await openMemory(dir);
    const result=await mem.recallPriority('investigate entitlement workspace mapping',{tenantId:'t-northwind'});
    assert.equal(result.memories.length,0);assert.deepEqual(result.suggestedPriority,[]);
    assert.ok(before.includes('run-old'));assert.ok(fs.readFileSync(path.join(dir,'state.json'),'utf8').includes('run-old'));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
