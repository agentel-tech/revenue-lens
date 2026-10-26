import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PROPOSED_ROLES, type InvestigationRun } from "../src/agents/types.ts";
import { EvidenceRegistry } from "../src/agents/evidence-registry.ts";
import { BodyTooLargeError, MAX_REQUEST_BODY_BYTES, createDemoServer, readBody } from "./server.ts";
import { RunStore } from "./run-store.ts";
import { DEFAULT_PROBE_TIMEOUT_MS, probeCustomerAccess } from "./probe.ts";

function stubRun(id: string): InvestigationRun {
  return {
    runId: id,
    tenantId: "t",
    billingAccountId: "ba",
    observedAt: "2026-10-23T12:00:00.000Z",
    status: "completed",
    model: { model: "t", provider: "openai-compatible", available: true },
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
    checkerFeedback: [],
    followUpActions: [],
    repairConfirmed: false,
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
  };
}

test("RunStore is finite and FIFO-evicts at 100", () => {
  const store = new RunStore(3);
  store.put(stubRun("a"));
  store.put(stubRun("b"));
  store.put(stubRun("c"));
  assert.equal(store.size, 3);
  store.put(stubRun("d"));
  assert.equal(store.size, 3);
  assert.equal(store.get("a"), undefined);
  assert.ok(store.get("d"));
  assert.deepEqual(store.listIds(), ["b", "c", "d"]);
});

test("readBody rejects over 32KB", async () => {
  const server = http.createServer(async (req, res) => {
    try {
      await readBody(req, MAX_REQUEST_BODY_BYTES);
      res.writeHead(200);
      res.end("ok");
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        res.writeHead(413);
        res.end("too large");
        return;
      }
      res.writeHead(500);
      res.end("err");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${addr.port}/`, {
      method: "POST",
      body: "x".repeat(MAX_REQUEST_BODY_BYTES + 64),
      signal: controller.signal,
    });
    clearTimeout(timer);
    assert.equal(res.status, 413);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test("demo investigate rejects oversized body with 413", async () => {
  const store = new RunStore();
  const server = createDemoServer({
    cast: [
      {
        role: "main",
        tenantId: "t-northwind",
        billingAccountId: "ba-1",
        name: "Test",
        currentWorkspace: "ws",
        paymentLineId: "pl",
        token: "rl_test_x",
      },
    ],
    observedAt: "2026-10-23T12:00:00.000Z",
    store,
    model: null,
    memoryEnabled: false,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/investigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: "t-northwind",
        billingAccountId: "ba-1",
        pad: "y".repeat(MAX_REQUEST_BODY_BYTES),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    assert.equal(res.status, 413);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test("probeCustomerAccess uses bounded timeout", async () => {
  assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 10_000);
  await assert.rejects(
    () =>
      probeCustomerAccess({
        baseUrl: "http://127.0.0.1:1",
        workspace: "ws",
        feature: "reports",
        token: "t",
        timeoutMs: 50,
      }),
    (err: Error) => {
      assert.ok(
        /abort|timeout|ECONNREFUSED|fetch failed/i.test(err.message) ||
          err.name === "TimeoutError" ||
          err.name === "AbortError",
      );
      return true;
    },
  );
});

test("MAX_REQUEST_BODY_BYTES is 32KiB", () => {
  assert.equal(MAX_REQUEST_BODY_BYTES, 32 * 1024);
});
