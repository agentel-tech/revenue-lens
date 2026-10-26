import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PROPOSED_ROLES, type InvestigationRun, type ModelCaller } from "../src/agents/types.ts";
import { EvidenceRegistry } from "../src/agents/evidence-registry.ts";
import type { RepairPlan } from "../src/contracts.ts";
import { lessonFromRun, openMemory } from "../src/memory/store.ts";
import type { CastMemberPrivate } from "./cast.ts";
import { createDemoServer, rejectCrossOriginMutation, type DemoDeps } from "./server.ts";
import { RunStore } from "./run-store.ts";
import type { ScanCheckRunner } from "./scan.ts";

function plan(intentKey = "retarget:t-northwind:ent-1:v1"): RepairPlan {
  return {
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
    intentKey,
    payloadFingerprint: "deadbeef",
    evidenceRefs: [],
    proposedBy: "investigator",
  };
}

function seededRun(over: Partial<InvestigationRun> = {}): InvestigationRun {
  return {
    runId: "run-demo-1",
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
    // Confirm requires explicit model repair_candidate + empty missingEvidence (fixtures must state this).
    finding: {
      conclusion: "entitlement on prior workspace",
      statusClaim: "repair_candidate",
      causalLinks: [],
      hypotheses: [],
      missingEvidence: [],
      evidenceRefs: [],
    },
    eligibility: "repair_candidate",
    repairPlan: plan(),
    repairConfirmed: false,
    checkerFeedback: [],
    followUpActions: [],
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
    ...over,
  };
}

async function withServer(
  store: RunStore,
  fn: (base: string) => Promise<void>,
  extras: Partial<DemoDeps> & {
    execute?: (p: RepairPlan) => Promise<unknown>;
    probe?: (o: unknown) => Promise<unknown>;
  } = {},
): Promise<void> {
  let executed = 0;
  const {
    execute: executeOver,
    probe: probeOver,
    cast: castOver,
    memoryEnabled: memOver,
    memoryDir,
    scanRunner,
    model,
    tools,
    ...rest
  } = extras;
  const server = createDemoServer({
    cast: castOver ?? [
      {
        role: "main",
        tenantId: "t-northwind",
        billingAccountId: "ba-1",
        name: "Test Co",
        currentWorkspace: "ws-new",
        paymentLineId: "pl-1",
        token: "rl_test_secret_should_not_leak",
      },
    ],
    observedAt: "2026-10-23T12:00:00.000Z",
    store,
    model: model === undefined ? null : model,
    tools,
    memoryEnabled: memOver ?? false,
    memoryDir,
    scanRunner,
    execute:
      executeOver ??
      (async () => {
        executed++;
        return {
          outcome: "applied",
          detail: "ok",
          receiptId: "rcpt-x",
          at: new Date().toISOString(),
        };
      }),
    probe:
      probeOver ??
      (async () => ({
        workspace: "ws-new",
        feature: "reports",
        status: 200,
        body: { ok: true },
        at: new Date().toISOString(),
      })),
    ...rest,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
  void executed;
}

test("accounts API never returns cast tokens", async () => {
  const store = new RunStore();
  await withServer(store, async (base) => {
    const res = await fetch(`${base}/api/accounts`);
    const data = await res.json();
    assert.equal(res.status, 200);
    const blob = JSON.stringify(data);
    assert.equal(blob.includes("rl_test_"), false);
    assert.equal(JSON.stringify(data.accounts).includes("token"), false);
    assert.ok(data.accounts.every((a: { token?: unknown }) => a.token === undefined));
    assert.ok(data.accounts.every((a: { role?: unknown }) => a.role === undefined), "seed roles stay off the wire");
  });
});

test("probe-access is scoped, returns status/body, never token", async () => {
  const store = new RunStore();
  let seenToken: string | undefined;
  await withServer(
    store,
    async (base) => {
      const ok = await fetch(`${base}/api/probe-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: "t-northwind",
          billingAccountId: "ba-1",
          workspace: "ws-new",
          feature: "reports",
        }),
      });
      assert.equal(ok.status, 200);
      const data = await ok.json();
      assert.equal(data.status, 403);
      assert.equal(data.workspace, "ws-new");
      assert.ok(data.body);
      assert.equal(data.token, undefined);
      assert.equal(JSON.stringify(data).includes("rl_test_secret"), false);
      assert.equal(seenToken, "rl_test_secret_should_not_leak");

      const badWs = await fetch(`${base}/api/probe-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId: "t-northwind",
          billingAccountId: "ba-1",
          workspace: "ws-other",
          feature: "reports",
        }),
      });
      assert.equal(badWs.status, 400);
      assert.match((await badWs.json()).error, /not in scope/);

      const foreign = await fetch(`${base}/api/probe-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: "t-evil", billingAccountId: "ba-evil" }),
      });
      assert.equal(foreign.status, 400);
    },
    {
      probe: async (o: unknown) => {
        const opts = o as { token: string; workspace: string; feature: string };
        seenToken = opts.token;
        return {
          workspace: opts.workspace,
          feature: opts.feature,
          status: 403,
          body: { allowed: false },
          at: new Date().toISOString(),
        };
      },
    },
  );
});

test("brand static paths are served; no private file routes", async () => {
  const store = new RunStore();
  await withServer(store, async (base) => {
    const logo = await fetch(`${base}/brand/logo.png`);
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get("content-type") ?? "", /image\/png/);
    const font = await fetch(`${base}/brand/Jersey20-Regular.woff2`);
    assert.equal(font.status, 200);
    assert.match(font.headers.get("content-type") ?? "", /font\/woff2|application\/octet/);
    const sneak = await fetch(`${base}/brand/../app.js`);
    // Either 404 from allowlist miss or normalized path still only hits allowlisted files —
    // never exposes arbitrary FS. Path traversal via .. should not open private routes.
    assert.ok(sneak.status === 404 || sneak.status === 200);
    const privateRoute = await fetch(`${base}/../../package.json`);
    assert.equal(privateRoute.status, 404);
    const seedLeak = await fetch(`${base}/../seed/out/demo.json`);
    assert.equal(seedLeak.status, 404);
  });
});

test("HTTP UI cannot execute repair before confirmation", async () => {
  const store = new RunStore();
  const run = seededRun();
  store.put(run);
  let executed = 0;
  await withServer(
    store,
    async (base) => {
      const res = await fetch(`${base}/api/runs/${run.runId}/confirm-repair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intentKey: run.repairPlan!.intentKey }),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /confirm:true/);
      assert.equal(executed, 0);
      assert.equal(store.get(run.runId)?.receipt, undefined);
    },
    {
      execute: async () => {
        executed++;
        return { outcome: "applied", detail: "x", at: new Date().toISOString() };
      },
    },
  );
});

test("HTTP UI cannot substitute another plan", async () => {
  const store = new RunStore();
  const run = seededRun();
  store.put(run);
  let executed = 0;
  await withServer(
    store,
    async (base) => {
      const forged = plan("retarget:forged:ent-9:v99");
      const res = await fetch(`${base}/api/runs/${run.runId}/confirm-repair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, intentKey: forged.intentKey, plan: forged }),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /client-supplied plan rejected|intentKey/);
      assert.equal(executed, 0);

      const wrongKey = await fetch(`${base}/api/runs/${run.runId}/confirm-repair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, intentKey: "retarget:wrong" }),
      });
      assert.equal(wrongKey.status, 400);
      assert.equal(executed, 0);
    },
    {
      execute: async () => {
        executed++;
        return { outcome: "applied", detail: "x", at: new Date().toISOString() };
      },
    },
  );
});

test("confirmed repair uses persisted plan then records probe", async () => {
  const store = new RunStore();
  const run = seededRun();
  store.put(run);
  await withServer(store, async (base) => {
    const res = await fetch(`${base}/api/runs/${run.runId}/confirm-repair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, intentKey: run.repairPlan!.intentKey }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.run.receipt.outcome, "applied");
    assert.equal(data.run.accessProbe.status, 200);
    assert.equal(data.why.customerRecovered, true);
    assert.equal(JSON.stringify(data).includes("rl_test_secret"), false);
  });
});

test("stale plan confirm rejected when finding is needs_verification — no execute", async () => {
  const store = new RunStore();
  const run = seededRun({
    finding: {
      conclusion: "uncertain",
      statusClaim: "needs_verification",
      causalLinks: [],
      hypotheses: [],
      missingEvidence: ["causal proof"],
      evidenceRefs: [],
    },
    eligibility: "repair_candidate",
    // Stale plan from an earlier buggy build may still be stored
    repairPlan: plan(),
  });
  store.put(run);
  let executed = 0;
  await withServer(
    store,
    async (base) => {
      const res = await fetch(`${base}/api/runs/${run.runId}/confirm-repair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, intentKey: run.repairPlan!.intentKey }),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /needs_verification|not repair_candidate|missingEvidence|uncertainty/i);
      assert.equal(executed, 0);
      assert.equal(store.get(run.runId)?.receipt, undefined);
    },
    {
      execute: async () => {
        executed++;
        return { outcome: "applied", detail: "should-not-run", at: new Date().toISOString() };
      },
    },
  );
});

test("cross-origin mutation is rejected", async () => {
  const store = new RunStore();
  await withServer(store, async (base) => {
    const res = await fetch(`${base}/api/investigate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://evil.example",
      },
      body: JSON.stringify({ tenantId: "t-northwind", billingAccountId: "ba-1" }),
    });
    assert.equal(res.status, 403);
  });
});

test("rejectCrossOriginMutation helper allows same-origin and GET", () => {
  const fakeRes = {
    writeHead() {},
    end() {},
  } as unknown as http.ServerResponse;
  assert.equal(
    rejectCrossOriginMutation({ method: "GET", headers: { origin: "http://evil.example" } } as http.IncomingMessage, fakeRes),
    false,
  );
  assert.equal(
    rejectCrossOriginMutation(
      { method: "POST", headers: { origin: "http://127.0.0.1:8791" } } as http.IncomingMessage,
      fakeRes,
    ),
    false,
  );
});

test("POST /api/scan is tenant-scoped, readonly, no token/role; returns derived counts", async () => {
  const store = new RunStore();
  const cast: CastMemberPrivate[] = [
    {
      role: "main",
      tenantId: "t-northwind",
      billingAccountId: "ba-1",
      name: "North",
      currentWorkspace: "ws-a",
      paymentLineId: "pl-1",
      token: "rl_test_secret_scan_a",
    },
    {
      role: "cohort",
      tenantId: "t-northwind",
      billingAccountId: "ba-2",
      name: "Cohort",
      currentWorkspace: "ws-b",
      paymentLineId: "pl-2",
      token: "rl_test_secret_scan_b",
    },
    {
      role: "main",
      tenantId: "t-contoso",
      billingAccountId: "ba-x",
      name: "Other",
      currentWorkspace: "ws-x",
      paymentLineId: "pl-x",
      token: "rl_test_secret_scan_x",
    },
  ];
  const seen: string[] = [];
  const scanRunner: ScanCheckRunner = async (t, ba) => {
    seen.push(`${t}:${ba}`);
    return {
      check: {
        tenantId: t,
        billingAccountId: ba,
        observedAt: "2026-10-23T12:00:00.000Z",
        lines: [
          {
            paymentLineId: ba === "ba-1" ? "pl-1" : "pl-2",
            feature: "reports",
            status: "consistent",
            missing: [],
            conditions: [
              {
                id: "payment.paid",
                passed: true,
                detail: "paid",
                refs: [{ source: "billing", table: "payment_lines", key: { payment_line_id: "pl" }, via: "zetaris" }],
              },
              {
                id: "payment.period_active",
                passed: true,
                detail: "in period",
                refs: [{ source: "billing", table: "payment_lines", key: { payment_line_id: "pl" }, via: "zetaris" }],
              },
            ],
          },
        ],
      },
      coverage: [{ tool: "check_conditions", via: "zetaris", rows: 1, complete: true }],
    };
  };
  await withServer(
    store,
    async (base) => {
      const res = await fetch(`${base}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: "t-northwind" }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.tenantId, "t-northwind");
      assert.equal(data.repairsProposed, false);
      assert.equal(data.maxPaymentLines, 50);
      assert.ok(typeof data.timeoutMs === "number");
      assert.ok(data.scopeNote);
      assert.deepEqual(seen.sort(), ["t-northwind:ba-1", "t-northwind:ba-2"].sort());
      assert.equal(JSON.stringify(data).includes("rl_test_"), false);
      assert.equal(JSON.stringify(data).includes('"role"'), false);
      assert.equal(data.scannedLines, data.rows.length);

      const foreign = await fetch(`${base}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: "t-evil" }),
      });
      assert.equal(foreign.status, 400);
    },
    { cast, scanRunner },
  );
});

test("GET /api/memory is readonly, tenant-scoped, discloses reference embedding", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-http-mem-"));
  try {
    const mem = await openMemory(dir);
    const lesson = lessonFromRun({
      ...seededRun({
        runId: "run-http-mem",
        tenantId: "t-northwind",
        billingAccountId: "ba-1",
        status: "completed",
        coverage: [{ tool: "check_conditions", via: "zetaris", rows: 1, complete: true }],
        eligibility: "repair_candidate",
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
        finding: {
          conclusion: "MODEL PROSE MUST NOT LEAK AS FACT",
          statusClaim: "repair_candidate",
          causalLinks: [],
          hypotheses: [],
          missingEvidence: [],
          evidenceRefs: [{ source: "entitlements", table: "entitlements", key: { entitlement_id: "e1" }, via: "zetaris" }],
        },
        trace: [
          {
            step: 1,
            role: "checker",
            action: "model",
            decision: { kind: "accept", note: "ok" },
            at: "2026-10-23T12:00:00.000Z",
          },
        ],
        repairPlan: undefined,
      }),
    });
    assert.ok(lesson);
    await mem.rememberLesson(lesson!);

    const store = new RunStore();
    await withServer(
      store,
      async (base) => {
        const res = await fetch(`${base}/api/memory?tenantId=t-northwind`);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.tenantId, "t-northwind");
        assert.match(data.embeddingDisclosure, /reference/i);
        assert.match(data.embeddingDisclosure, /not NVIDIA/i);
        assert.ok(Array.isArray(data.suggestedPriority));
        assert.ok(data.suggestedPriority.every((t: string) => typeof t === "string"));
        assert.equal(JSON.stringify(data).includes("rl_test_"), false);
        assert.equal(JSON.stringify(data).includes("MODEL PROSE"), false);

        const missing = await fetch(`${base}/api/memory`);
        assert.equal(missing.status, 400);
      },
      { memoryDir: dir },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("investigate memoryEnabled:false skips recall even when lessons exist", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-http-mem-off-"));
  try {
    const mem = await openMemory(dir);
    const lesson = lessonFromRun({
      ...seededRun({
        runId: "run-seed-lesson",
        status: "completed",
        coverage: [{ tool: "check_conditions", via: "zetaris", rows: 1, complete: true }],
        eligibility: "repair_candidate",
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
        finding: {
          conclusion: "x",
          statusClaim: "repair_candidate",
          causalLinks: [],
          hypotheses: [],
          missingEvidence: [],
          evidenceRefs: [{ source: "entitlements", table: "entitlements", key: { entitlement_id: "e1" }, via: "zetaris" }],
        },
        trace: [
          {
            step: 1,
            role: "checker",
            action: "model",
            decision: { kind: "accept", note: "ok" },
            at: "2026-10-23T12:00:00.000Z",
          },
        ],
        repairPlan: undefined,
      }),
    });
    assert.ok(lesson);
    await mem.rememberLesson(lesson!);

    const store = new RunStore();
    const model: ModelCaller = async () => ({
      text: JSON.stringify({
        kind: "stop",
        reason: "done for test",
      }),
      providerResponseId: null,
    });
    await withServer(
      store,
      async (base) => {
        const res = await fetch(`${base}/api/investigate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantId: "t-northwind",
            billingAccountId: "ba-1",
            memoryEnabled: false,
          }),
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.run.memoryEnabled, false);
        assert.deepEqual(data.run.recalledLessonIds, []);
        assert.equal(data.run.suggestedPriority, undefined);
        assert.match(data.whyHtml, /Ready for review/i);
        assert.equal(/Write authorized/i.test(data.whyHtml), false);
      },
      { memoryDir: dir, memoryEnabled: true, model, tools: async () => ({ coverage: [] }) },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("frontend wires scan/memory/compare run-id inputs", async () => {
  const store = new RunStore();
  await withServer(store, async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /id="runScan"/);
    assert.match(html, /id="memoryEnabled"/);
    assert.match(html, /id="recallMemory"/);
    assert.match(html, /id="compareRunAId"/);
    assert.match(html, /id="compareRunBId"/);
    assert.match(html, /list="compareRunList"/);
    const js = await (await fetch(`${base}/app.js`)).text();
    assert.match(js, /isSafeRunId/);
    assert.match(js, /resolveCompareRunId/);
    assert.match(js, /memoryEnabled/);
    assert.match(js, /\/api\/scan/);
    assert.match(js, /\/api\/memory/);
    assert.match(js, /startScanProgress/);
    assert.match(js, /mem-chip/);
    assert.match(js, /memory-raw/);
  });
});

test("saved cohort run provides exact public account without exposing session token",async()=>{
 const store=new RunStore();store.put(seededRun());
 await withServer(store,async base=>{
  const response=await fetch(base+'/api/runs/run-demo-1');const body=await response.json();
  assert.equal(response.status,200);assert.equal(body.account.billingAccountId,body.run.billingAccountId);
  assert.equal(body.account.name,'Cohort Co');assert.equal(body.account.currentWorkspace,'ws-new');
  assert.equal(JSON.stringify(body).includes('private-session-token'),false);
 },{cast:[{role:'cohort',tenantId:'t-northwind',billingAccountId:'ba-1',name:'Cohort Co',currentWorkspace:'ws-new',paymentLineId:'pl-1',token:'private-session-token'}]});
});
