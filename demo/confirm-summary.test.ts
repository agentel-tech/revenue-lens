import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRepairConfirmView,
  repairConfirmRequestBody,
  repairConfirmViewIsComplete,
} from "./confirm-summary.ts";

test("buildRepairConfirmView exposes account, entitlement version, workspaces, intentKey", () => {
  const view = buildRepairConfirmView({
    runId: "run-abc",
    tenantId: "t-northwind",
    billingAccountId: "ba-d2063d",
    accountName: "Acme Freight",
    plan: {
      intentKey: "retarget:t-northwind:ent-1:v1",
      entitlementId: "ent-1",
      expectedVersion: 1,
      fromWorkspace: "ws-old",
      toWorkspace: "ws-new",
      feature: "reports",
      paymentLineId: "pl-1",
    },
  });
  assert.equal(repairConfirmViewIsComplete(view), true);
  assert.equal(view.title, "Confirm repair");
  assert.match(view.accountLabel, /Acme Freight/);
  assert.match(view.accountLabel, /ba-d2063d/);
  assert.equal(view.entitlementLabel, "ent-1 · v1");
  assert.equal(view.workspaceLabel, "ws-old → ws-new");
  assert.equal(view.intentKey, "retarget:t-northwind:ent-1:v1");
  assert.equal(view.isRetry, false);

  const retry = buildRepairConfirmView({
    runId: "run-abc",
    tenantId: "t-northwind",
    billingAccountId: "ba-d2063d",
    accountName: "Acme Freight",
    plan: view,
    isRetry: true,
  });
  assert.equal(retry.title, "Retry same repair");
  assert.equal(retry.isRetry, true);
});

test("repairConfirmRequestBody requires explicit confirm:true and matching intentKey only", () => {
  const view = buildRepairConfirmView({
    runId: "run-1",
    tenantId: "t",
    billingAccountId: "ba",
    plan: {
      intentKey: "retarget:t:ent-1:v1",
      entitlementId: "ent-1",
      expectedVersion: 1,
      fromWorkspace: "a",
      toWorkspace: "b",
      feature: "reports",
      paymentLineId: "pl",
    },
  });
  assert.deepEqual(repairConfirmRequestBody(view), { confirm: true, intentKey: "retarget:t:ent-1:v1" });
  assert.equal("plan" in repairConfirmRequestBody(view), false);
});

test("incomplete views are refused (no silent auto-accept shape)", () => {
  assert.equal(repairConfirmViewIsComplete(null), false);
  assert.equal(repairConfirmViewIsComplete({ runId: "x" }), false);
  assert.throws(() => repairConfirmRequestBody({} as never), /incomplete/);
});
