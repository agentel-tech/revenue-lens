// Recovery acceptance, end to end against the real sources and the running
// sandbox service. Reseeds first (repairs mutate data).
//
//   npm run sandbox            # in another terminal
//   npx tsx scripts/verify-recovery.ts
//
// Checks: main customer 403 -> repair -> 200; retry returns the original
// receipt and grants nothing new; payload conflict, stale version, concurrent
// double-submit; every non-candidate is refused with zero writes.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RepairPlan } from "../src/contracts.ts";
import { checkContext, mappingsValidAt } from "../src/data/checks.ts";
import { ZetarisFacts } from "../src/data/context.ts";
import { executeRetarget } from "../src/repair/executor.ts";
import { makeRetargetPlan } from "../src/repair/plan.ts";
import { pool } from "../src/sources.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = process.env.SANDBOX_URL ?? "http://127.0.0.1:8790";
let failed = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

await fetch(`${SANDBOX}/healthz`).catch(() => {
  console.error(`sandbox service not reachable at ${SANDBOX}; run: npm run sandbox`);
  process.exit(2);
});

execFileSync("npx", ["tsx", "seed/generate.ts", "--seed", "recovery"], { cwd: root, stdio: "ignore" });
const { cast } = JSON.parse(fs.readFileSync(path.join(root, "seed/out/recovery.json"), "utf8"));
const byRole = (role: string) => cast.find((c: { role: string }) => c.role === role);
const zf = new ZetarisFacts();
const ent = pool("entitlements", "owner");

const access = async (c: { current_workspace: string; token: string }) =>
  (await fetch(`${SANDBOX}/w/${c.current_workspace}/features/reports`, { headers: { Authorization: `Bearer ${c.token}` } })).status;
const writes = async () => {
  const { rows } = await ent.query("SELECT (SELECT count(*) FROM repair_receipts) AS receipts, (SELECT count(*) FROM grant_events) AS events, (SELECT count(*) FROM entitlements) AS ents, (SELECT sum(version) FROM entitlements) AS versions");
  return JSON.stringify(rows[0]);
};

// A plan built only from facts read through Zetaris, as an agent would.
async function planFor(c: { tenant_id: string; billing_account_id: string }, overrides: Partial<RepairPlan> = {}) {
  const ctx = await zf.context(c.tenant_id, c.billing_account_id);
  const check = checkContext(ctx);
  const line = check.lines[0];
  const e = ctx.entitlements.find((x) => x.paymentLineId === line.paymentLineId);
  const current = mappingsValidAt(ctx.mappings, ctx.observedAt);
  const p = ctx.payments[0];
  const plan = makeRetargetPlan({
    tenantId: c.tenant_id, billingAccountId: c.billing_account_id, paymentLineId: p.paymentLineId,
    entitlementId: e?.entitlementId ?? "ent-none", feature: line.feature ?? "reports",
    fromWorkspace: e?.targetWorkspaceId ?? "ws-none", toWorkspace: current[0]?.workspaceId ?? "ws-unknown",
    expectedVersion: e?.version ?? 1, mappingVersion: current[0]?.mappingVersion ?? 0,
    evidenceRefs: line.conditions.flatMap((x) => x.refs), proposedBy: "verify-recovery",
  });
  return { plan: { ...plan, ...overrides }, status: line.status };
}

// ---- main customer: 403 -> repair -> 200 -------------------------------------------
const main = byRole("main");
ok((await access(main)) === 403, "main customer is denied before repair", `(${main.billing_account_id} @ ${main.current_workspace})`);
const { plan, status } = await planFor(main);
ok(status === "repair_candidate", "Zetaris facts classify main as repair_candidate");
const first = await executeRetarget(plan);
ok(first.outcome === "applied", "retarget applied", `${first.fromWorkspace} -> ${first.toWorkspace} v${first.previousVersion}->v${first.newVersion} ${first.receiptId}`);
ok((await access(main)) === 200, "main customer is served after repair (real sandbox request)");

const again = await executeRetarget(plan);
ok(again.outcome === "replayed" && again.receiptId === first.receiptId, "retry returns the original receipt", again.receiptId);
const lineRows = await ent.query("SELECT count(*)::int AS n, max(version) AS v FROM entitlements WHERE tenant_id = $1 AND payment_line_id = $2", [plan.tenantId, plan.paymentLineId]);
ok(lineRows.rows[0].n === 1 && lineRows.rows[0].v === 2, "still exactly one entitlement for the line, at v2", JSON.stringify(lineRows.rows[0]));
const hist = await ent.query("SELECT event_type, target_workspace_id, receipt_id FROM grant_events WHERE tenant_id = $1 AND entitlement_id = $2 ORDER BY at", [plan.tenantId, plan.entitlementId]);
ok(hist.rows.length === 2 && hist.rows[0].event_type === "grant" && hist.rows[1].event_type === "retarget", "history keeps the original grant and appends one retarget", hist.rows.map((r) => `${r.event_type}:${r.target_workspace_id}`).join(" "));

const conflicting = { ...plan, toWorkspace: "ws-elsewhere" };
conflicting.payloadFingerprint = (await import("../src/repair/plan.ts")).fingerprint(conflicting);
const conflict = await executeRetarget(conflicting);
ok(conflict.outcome === "rejected" && conflict.reason === "payload_conflict", "same intent, different payload is refused", conflict.reason);

const tampered = await executeRetarget({ ...plan, toWorkspace: "ws-elsewhere" });
ok(tampered.outcome === "rejected" && tampered.reason === "invalid_plan", "plan edited without a new fingerprint is refused", tampered.reason);

// Zetaris readback: the federated view should reflect the repair.
const after = await zf.context(main.tenant_id, main.billing_account_id);
const zEnt = after.entitlements.find((e) => e.entitlementId === plan.entitlementId);
ok(zEnt?.targetWorkspaceId === plan.toWorkspace && zEnt?.version === 2, "Zetaris reads the repaired entitlement", `${zEnt?.targetWorkspaceId} v${zEnt?.version}`);
ok(checkContext(after).lines[0].status === "consistent", "post-repair check via Zetaris is consistent");

// ---- version changed between plan and execution -----------------------------------
const cohortFaults = cast.filter((c: { role: string; kind: string }) => c.role === "cohort" && c.kind === "stale_mapping");
const [vc, race] = cohortFaults;
const { plan: stalePlan } = await planFor(vc);
await ent.query("UPDATE entitlements SET version = version + 1 WHERE tenant_id = $1 AND entitlement_id = $2", [stalePlan.tenantId, stalePlan.entitlementId]); // a concurrent change
const vcRes = await executeRetarget(stalePlan);
ok(vcRes.outcome === "rejected" && vcRes.reason === "version_changed", "plan made against an older version is refused", vcRes.reason);
ok((await access(vc)) === 403, "...and the customer is untouched");

// ---- concurrent double-submit --------------------------------------------------------
const { plan: racePlan } = await planFor(race);
const [r1, r2] = await Promise.all([executeRetarget(racePlan), executeRetarget(racePlan)]);
const outcomes = [r1.outcome, r2.outcome].sort().join(",");
ok(outcomes === "applied,replayed", "two simultaneous submits: one applies, the other gets the same receipt", outcomes);
const raceEvents = await ent.query("SELECT count(*)::int AS n FROM grant_events WHERE tenant_id = $1 AND entitlement_id = $2 AND event_type = 'retarget'", [racePlan.tenantId, racePlan.entitlementId]);
ok(raceEvents.rows[0].n === 1, "exactly one retarget event recorded", `${raceEvents.rows[0].n}`);
ok((await access(race)) === 200, "raced customer is served");

// ---- non-candidates: refused, zero writes ----------------------------------------------
for (const role of ["healthy", "healthy-migrated", "in-window", "insufficient-evidence", "mapping-conflict", "payment-failed", "other-tenant-collision"]) {
  const c = byRole(role);
  const before = await writes();
  // Point the plan somewhere else, so the refusal must come from the fresh
  // fact check rather than from the plan being trivially invalid.
  const { plan: base, status: st } = await planFor(c);
  const p = base.fromWorkspace === base.toWorkspace ? makeRetargetPlan({ ...base, toWorkspace: "ws-not-theirs" }) : base;
  const res = await executeRetarget(p);
  const unchanged = (await writes()) === before;
  ok(res.outcome === "rejected" && res.reason !== "invalid_plan" && unchanged, `${role.padEnd(22)} refused by fresh check, zero writes`, `${st} -> ${res.reason}: ${res.detail}`);
}

await ent.end();
console.log(failed ? `\n${failed} check(s) failed` : "\nall recovery checks passed");
process.exit(failed ? 1 : 0);
