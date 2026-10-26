import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckResult, LineCheck } from "../src/contracts.ts";
import type { CastMemberPrivate } from "./cast.ts";
import {
  SCAN_CONCURRENCY,
  SCAN_MAX_PAYMENT_LINES,
  SCAN_SCOPE_NOTE,
  SCAN_TIMEOUT_MS,
  scanTenant,
  type ScanCheckRunner,
} from "./scan.ts";

const T = "2026-10-23T12:00:00.000Z";

function member(
  over: Partial<CastMemberPrivate> & Pick<CastMemberPrivate, "billingAccountId" | "paymentLineId">,
): CastMemberPrivate {
  return {
    role: over.role ?? "cohort",
    tenantId: over.tenantId ?? "t-northwind",
    billingAccountId: over.billingAccountId,
    name: over.name ?? over.billingAccountId,
    currentWorkspace: over.currentWorkspace ?? "ws-x",
    paymentLineId: over.paymentLineId,
    token: over.token ?? "rl_test_secret_never_in_scan",
  };
}

function paidConditions(paymentLineId: string, paid = true): LineCheck["conditions"] {
  return [
    {
      id: "payment.paid",
      passed: paid,
      detail: paid ? "paid" : "failed",
      refs: [{ source: "billing", table: "payment_lines", key: { payment_line_id: paymentLineId }, via: "zetaris" }],
    },
    {
      id: "payment.period_active",
      passed: paid,
      detail: paid ? "in period" : "expired",
      refs: [{ source: "billing", table: "payment_lines", key: { payment_line_id: paymentLineId }, via: "zetaris" }],
    },
  ];
}

function checkFor(
  tenantId: string,
  billingAccountId: string,
  paymentLineId: string,
  status: CheckResult["lines"][0]["status"],
  complete = true,
  extraLines: LineCheck[] = [],
): { check: CheckResult; coverage: { tool: string; via: "zetaris"; rows: number; complete: boolean }[] } {
  return {
    check: {
      tenantId,
      billingAccountId,
      observedAt: T,
      lines: [
        {
          paymentLineId,
          feature: "reports",
          status,
          missing: status === "needs_verification" ? ["more evidence"] : [],
          conditions: paidConditions(paymentLineId, status !== "not_entitled"),
        },
        ...extraLines,
      ],
    },
    coverage: [{ tool: "check_conditions", via: "zetaris", rows: 1, complete }],
  };
}

test("default wall-clock budget is 180s (live Zetaris pace); tests still inject short timeouts", () => {
  assert.equal(SCAN_TIMEOUT_MS, 180_000);
  assert.equal(SCAN_MAX_PAYMENT_LINES, 50);
  assert.equal(SCAN_CONCURRENCY, 2);
});

test("scan isolates tenant — foreign accounts are never read", async () => {
  const seen: string[] = [];
  const members = [
    member({ billingAccountId: "ba-a", paymentLineId: "pl-a", tenantId: "t-northwind" }),
    member({ billingAccountId: "ba-b", paymentLineId: "pl-b", tenantId: "t-contoso", name: "Other" }),
  ];
  const runner: ScanCheckRunner = async (t, ba) => {
    seen.push(`${t}:${ba}`);
    return checkFor(t, ba, ba === "ba-a" ? "pl-a" : "pl-b", "consistent");
  };
  const result = await scanTenant({
    tenantId: "t-northwind",
    members,
    observedAt: T,
    runner,
    concurrency: 1,
  });
  assert.deepEqual(seen, ["t-northwind:ba-a"]);
  assert.equal(result.rows.every((r) => r.tenantId === "t-northwind"), true);
  assert.equal(result.repairsProposed, false);
  assert.equal(result.scopeNote, SCAN_SCOPE_NOTE);
  assert.match(result.scopeNote, /permitted synthetic/i);
  assert.equal(result.timeoutMs, SCAN_TIMEOUT_MS);
  assert.equal(JSON.stringify(result).includes("rl_test_"), false);
});

test("scan enforces max 50 distinct payment lines (not merely accounts)", async () => {
  const members = Array.from({ length: 60 }, (_, i) =>
    member({ billingAccountId: `ba-${i}`, paymentLineId: `pl-${i}`, name: `Cust ${i}` }),
  );
  let calls = 0;
  const runner: ScanCheckRunner = async (t, ba) => {
    calls++;
    const pl = members.find((m) => m.billingAccountId === ba)!.paymentLineId;
    return checkFor(t, ba, pl, "consistent");
  };
  const result = await scanTenant({
    tenantId: "t-northwind",
    members,
    observedAt: T,
    runner,
    maxPaymentLines: SCAN_MAX_PAYMENT_LINES,
    concurrency: 2,
  });
  assert.equal(result.scannedLines, 50);
  assert.equal(result.rows.length, 50);
  assert.equal(result.maxPaymentLines, 50);
  assert.equal(result.partial, true);
  assert.ok(result.partialReasons.some((r) => /cap 50/i.test(r)));
  assert.ok(calls <= 60);
  assert.equal(result.repairsProposed, false);
});

test("duplicate features / same payment_line_id do not inflate cap, candidate, or paid counters", async () => {
  const runner: ScanCheckRunner = async (t, ba) =>
    checkFor(t, ba, "pl-1", "repair_candidate", true, [
      {
        paymentLineId: "pl-1",
        feature: "api",
        status: "repair_candidate",
        missing: [],
        conditions: paidConditions("pl-1", true),
      },
      {
        paymentLineId: "pl-1",
        feature: "exports",
        status: "consistent",
        missing: [],
        conditions: paidConditions("pl-1", true),
      },
    ]);
  const dupMembers = [
    member({ billingAccountId: "ba-1", paymentLineId: "pl-1" }),
    member({ billingAccountId: "ba-1", paymentLineId: "pl-1", name: "Dup cast row" }),
  ];
  let calls = 0;
  const countingRunner: ScanCheckRunner = async (t, ba, at) => {
    calls++;
    return runner(t, ba, at);
  };
  const result = await scanTenant({
    tenantId: "t-northwind",
    members: dupMembers,
    observedAt: T,
    runner: countingRunner,
    concurrency: 1,
  });
  assert.equal(calls, 1, "duplicate tenant/account cast rows must not double-read");
  assert.equal(result.scannedLines, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.candidateLines, 1);
  assert.equal(result.distinctPaidInForceLines, 1);
  assert.equal(result.distinctCustomers, 1);
});

test("explicit payment evidence absent → paid/in-force count stays zero (no non-not_entitled fallback)", async () => {
  const result = await scanTenant({
    tenantId: "t-northwind",
    members: [member({ billingAccountId: "ba-1", paymentLineId: "pl-1" })],
    observedAt: T,
    runner: async (t, ba) => ({
      check: {
        tenantId: t,
        billingAccountId: ba,
        observedAt: T,
        lines: [
          {
            paymentLineId: "pl-1",
            feature: "reports",
            status: "consistent",
            missing: [],
            conditions: [
              {
                id: "mapping.unique_current",
                passed: true,
                detail: "one mapping",
                refs: [{ source: "workspace_map", table: "mappings", key: { mapping_id: "m1" }, via: "zetaris" }],
              },
            ],
          },
        ],
      },
      coverage: [{ tool: "check_conditions", via: "zetaris", rows: 1, complete: true }],
    }),
  });
  assert.equal(result.distinctPaidInForceLines, 0);
  assert.equal(result.scannedLines, 1);
});

test("incomplete coverage and read errors label unknown / partial; errors never count as paid", async () => {
  const members = [
    member({ billingAccountId: "ba-ok", paymentLineId: "pl-ok", name: "Ok Co" }),
    member({ billingAccountId: "ba-inc", paymentLineId: "pl-inc", name: "Incomplete Co" }),
    member({ billingAccountId: "ba-err", paymentLineId: "pl-err", name: "Err Co" }),
  ];
  const runner: ScanCheckRunner = async (t, ba) => {
    if (ba === "ba-err") throw new Error("zetaris timeout");
    if (ba === "ba-inc") return checkFor(t, ba, "pl-inc", "repair_candidate", false);
    return checkFor(t, ba, "pl-ok", "consistent", true);
  };
  const result = await scanTenant({
    tenantId: "t-northwind",
    members,
    observedAt: T,
    runner,
    concurrency: 1,
  });
  assert.equal(result.partial, true);
  assert.ok(result.unknownLines >= 1);
  assert.ok(result.rows.some((r) => r.billingAccountId === "ba-inc" && r.status === "unknown" && r.complete === false));
  assert.ok(result.rows.some((r) => r.billingAccountId === "ba-err" && /read error/i.test(r.reason)));
  assert.equal(result.rows.find((r) => r.billingAccountId === "ba-err") && result.distinctPaidInForceLines >= 0, true);
  // Error placeholder must not be in paid set: only ba-ok has explicit paid evidence when complete.
  assert.equal(result.distinctPaidInForceLines, 1);
  assert.equal(result.repairsProposed, false);
  assert.ok(result.distinctCustomers >= 1);
  assert.ok(result.distinctCustomers <= 3);
});

test("options clamp: maxPaymentLines <=50, concurrency <=2", async () => {
  const members = Array.from({ length: 3 }, (_, i) =>
    member({ billingAccountId: `ba-${i}`, paymentLineId: `pl-${i}` }),
  );
  const result = await scanTenant({
    tenantId: "t-northwind",
    members,
    observedAt: T,
    runner: async (t, ba) => checkFor(t, ba, members.find((m) => m.billingAccountId === ba)!.paymentLineId, "consistent"),
    maxPaymentLines: 999,
    concurrency: 99,
  });
  assert.equal(result.maxPaymentLines, SCAN_MAX_PAYMENT_LINES);
  assert.equal(result.concurrency, SCAN_CONCURRENCY);
});

test("timeout never-resolving injected runner finishes within budget; no hung scan", async () => {
  const t0 = Date.now();
  const result = await scanTenant({
    tenantId: "t-northwind",
    members: [
      member({ billingAccountId: "ba-a", paymentLineId: "pl-a" }),
      member({ billingAccountId: "ba-b", paymentLineId: "pl-b" }),
    ],
    observedAt: T,
    timeoutMs: 40,
    concurrency: 2,
    runner: () => new Promise(() => {}),
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `scan hung ${elapsed}ms`);
  assert.equal(result.partial, true);
  assert.ok(result.partialReasons.some((r) => /time budget/i.test(r)));
  assert.equal(result.timeoutMs, 40, "injected short timeout must apply (not live 180s default)");
  assert.equal(result.rows.length, 0);
  assert.equal(result.scannedLines, 0);
  assert.equal(result.distinctCustomers, 0);
  assert.equal(result.distinctPaidInForceLines, 0);
  assert.equal(result.candidateLines, 0);
});

test("late in-flight result after timeout is ignored", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const resultPromise = scanTenant({
    tenantId: "t-northwind",
    members: [
      member({ billingAccountId: "ba-a", paymentLineId: "pl-a" }),
      member({ billingAccountId: "ba-b", paymentLineId: "pl-b" }),
    ],
    observedAt: T,
    timeoutMs: 30,
    concurrency: 2,
    runner: async (t, ba) => {
      await gate;
      return checkFor(t, ba, ba === "ba-a" ? "pl-a" : "pl-b", "repair_candidate");
    },
  });
  await new Promise((r) => setTimeout(r, 60));
  release();
  const result = await resultPromise;
  assert.equal(result.rows.length, 0);
  assert.equal(result.candidateLines, 0);
  assert.equal(result.distinctPaidInForceLines, 0);
  assert.equal(result.distinctCustomers, 0);
  assert.ok(result.partialReasons.some((r) => /in-flight/i.test(r)));
});

test("scan never invents write plans or currency totals", async () => {
  const result = await scanTenant({
    tenantId: "t-northwind",
    members: [member({ billingAccountId: "ba-1", paymentLineId: "pl-1" })],
    observedAt: T,
    runner: async (t, ba) => checkFor(t, ba, "pl-1", "repair_candidate"),
  });
  assert.equal(result.repairsProposed, false);
  assert.equal("revenue" in result, false);
  assert.equal("totalCents" in result, false);
  assert.ok(result.rows[0].recordIds.some((id) => id.includes("pl-1")));
});
