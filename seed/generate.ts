// Generates the sandbox dataset into the three sources. Deterministic per
// --seed, so the demo cast is reproducible and a different seed gives a
// held-out variant (new ids, names, workspaces and times).
//
//   npx tsx seed/generate.ts                 # seed "demo", anchored at now
//   npx tsx seed/generate.ts --seed holdout-1 --at 2026-10-24T09:00:00Z
//
// Every injected fault is synthetic and labelled as such in seed/out/demo.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/sources.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const SEED = flag("seed") ?? "demo";
const T = new Date(flag("at") ?? new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString());

// --- deterministic randomness ---------------------------------------------------
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedNum = [...SEED].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261);
const rand = mulberry32(seedNum);
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const jitter = (minutes: number) => Math.round((rand() - 0.5) * 2 * minutes);
const at = (days: number, minutes = 0) => new Date(T.getTime() + days * 86_400_000 + minutes * 60_000);

const COMPANY = ["Acme", "Globex", "Initech", "Umbrella", "Hooli", "Vandelay", "Stark", "Wayne", "Tyrell", "Soylent", "Cyberdyne", "Wonka", "Gringotts", "Monarch", "Pied Piper", "Aperture", "Oscorp", "Dunder", "Prestige", "Massive"];
const SUFFIX = ["Labs", "Analytics", "Logistics", "Health", "Studio", "Foods", "Robotics", "Energy", "Media", "Freight"];

// --- in-memory rows ------------------------------------------------------------
type Row = Record<string, unknown>;
const billing = { products: [] as Row[], product_features: [] as Row[], billing_accounts: [] as Row[], payment_lines: [] as Row[] };
const wmap = { workspace_mappings: [] as Row[], migration_events: [] as Row[] };
const ent = { entitlements: [] as Row[], grant_events: [] as Row[], provisioning_runs: [] as Row[], sandbox_sessions: [] as Row[] };

type Kind = "stale_mapping" | "healthy" | "healthy_migrated" | "in_window" | "no_mapping" | "mapping_conflict" | "payment_failed";
const EXPECT: Record<Kind, { access: 200 | 403; finding: string }> = {
  stale_mapping: { access: 403, finding: "repair_candidate" },
  healthy: { access: 200, finding: "consistent" },
  healthy_migrated: { access: 200, finding: "consistent" },
  in_window: { access: 403, finding: "processing" },
  no_mapping: { access: 403, finding: "needs_verification" },
  mapping_conflict: { access: 403, finding: "needs_verification" },
  payment_failed: { access: 403, finding: "not_entitled" },
};
const cast: Row[] = [];
const PRODUCT = "pro-monthly";
const FEATURE = "reports";

function addTenant(tenant: string) {
  billing.products.push({ tenant_id: tenant, product_id: PRODUCT, name: "Pro (monthly)" });
  billing.product_features.push({ tenant_id: tenant, product_id: PRODUCT, feature: FEATURE });
}

function addAccount(tenant: string, kind: Kind, role: string, opts: { workspaceId?: string } = {}) {
  const acct = `ba-${hex(6)}`;
  const name = `${pick(COMPANY)} ${pick(SUFFIX)}`;
  const created = at(-200, jitter(600));
  billing.billing_accounts.push({ tenant_id: tenant, billing_account_id: acct, name, created_at: created });

  const wsOld = opts.workspaceId ?? `ws-${hex(6)}`;
  const wsNew = `ws-${hex(6)}`;
  let current = wsOld;
  const ticket = `MIG-${1000 + Math.floor(rand() * 9000)}`;

  // workspace mapping history
  const migrated = kind === "stale_mapping" || kind === "healthy_migrated";
  const migrationAt = kind === "stale_mapping" ? at(-10, jitter(240)) : at(-20, jitter(240));
  if (kind !== "no_mapping") {
    wmap.workspace_mappings.push({
      tenant_id: tenant, mapping_id: `map-${hex(8)}`, billing_account_id: acct, workspace_id: wsOld,
      valid_from: created, valid_to: migrated ? migrationAt : null, mapping_version: 1,
      source_ref: `SIGNUP-${acct}`, recorded_at: created,
    });
  }
  if (migrated) {
    current = wsNew;
    wmap.workspace_mappings.push({
      tenant_id: tenant, mapping_id: `map-${hex(8)}`, billing_account_id: acct, workspace_id: wsNew,
      valid_from: migrationAt, valid_to: null, mapping_version: 2, source_ref: ticket, recorded_at: migrationAt,
    });
    wmap.migration_events.push({
      tenant_id: tenant, migration_id: `mig-${hex(8)}`, billing_account_id: acct,
      from_workspace: wsOld, to_workspace: wsNew, effective_at: migrationAt, source_ref: ticket,
    });
  }
  // The customer reports the denial from wsNew; the evidence cannot settle
  // whether wsNew is right (no mapping at all, or two valid ones).
  if (kind === "no_mapping" || kind === "mapping_conflict") current = wsNew;
  if (kind === "mapping_conflict") {
    // a second open mapping with no migration behind it: two valid targets at once
    wmap.workspace_mappings.push({
      tenant_id: tenant, mapping_id: `map-${hex(8)}`, billing_account_id: acct, workspace_id: wsNew,
      valid_from: at(-15, jitter(240)), valid_to: null, mapping_version: 2, source_ref: `IMPORT-${hex(4)}`, recorded_at: at(-15),
    });
  }

  // payment
  const paidAt = kind === "in_window" ? at(0, -(5 + Math.floor(rand() * 15))) : at(-(1 + Math.floor(rand() * 4)), jitter(300));
  const line = `pl-${hex(8)}`;
  const periodStart = paidAt;
  const periodEnd = at(30 + (paidAt.getTime() - T.getTime()) / 86_400_000);
  billing.payment_lines.push({
    tenant_id: tenant, payment_line_id: line, billing_account_id: acct, product_id: PRODUCT,
    period_start: periodStart, period_end: periodEnd, amount_cents: pick([4900, 9900, 19900]), currency: "USD",
    status: kind === "payment_failed" ? "failed" : "paid", paid_at: kind === "payment_failed" ? null : paidAt, record_version: 1,
  });

  // provisioning run + grant
  const runStart = new Date(paidAt.getTime() + 60_000);
  if (kind === "in_window") {
    ent.provisioning_runs.push({ tenant_id: tenant, run_id: `run-${hex(8)}`, payment_line_id: line, status: "pending", target_used: null, mapping_version_used: null, started_at: runStart, finished_at: null });
  } else if (kind !== "payment_failed") {
    // stale_mapping: the workflow read mapping v1 (already closed) and granted to the old workspace
    const target = kind === "healthy" || kind === "healthy_migrated" ? current : wsOld;
    const mv = kind === "no_mapping" ? null : kind === "healthy_migrated" ? 2 : 1;
    const grantedAt = new Date(runStart.getTime() + 90_000);
    const eid = `ent-${hex(8)}`;
    ent.provisioning_runs.push({ tenant_id: tenant, run_id: `run-${hex(8)}`, payment_line_id: line, status: "success", target_used: target, mapping_version_used: mv, started_at: runStart, finished_at: grantedAt });
    ent.entitlements.push({ tenant_id: tenant, entitlement_id: eid, payment_line_id: line, feature: FEATURE, period_start: periodStart, period_end: periodEnd, target_workspace_id: target, status: "active", version: 1, created_at: grantedAt, updated_at: grantedAt });
    ent.grant_events.push({ tenant_id: tenant, event_id: `evt-${hex(8)}`, entitlement_id: eid, event_type: "grant", target_workspace_id: target, mapping_version_used: mv, actor: "provisioning-workflow", at: grantedAt, receipt_id: null });
  }

  // the customer's user signs in to the workspace they actually use today
  const token = `rl_test_${hex(24)}`;
  ent.sandbox_sessions.push({ token, tenant_id: tenant, user_id: `user-${hex(6)}`, workspace_id: current });
  cast.push({ role, kind, synthetic_fault: kind === "stale_mapping", tenant_id: tenant, billing_account_id: acct, name, payment_line_id: line, current_workspace: current, token, expected_access: EXPECT[kind].access, expected_finding: EXPECT[kind].finding });
}

// --- the dataset ----------------------------------------------------------------
const TENANT = "t-northwind";
const OTHER = "t-contoso";
addTenant(TENANT);
addTenant(OTHER);

addAccount(TENANT, "stale_mapping", "main");
addAccount(TENANT, "healthy", "healthy");
addAccount(TENANT, "healthy_migrated", "healthy-migrated");
addAccount(TENANT, "in_window", "in-window");
addAccount(TENANT, "no_mapping", "insufficient-evidence");
addAccount(TENANT, "mapping_conflict", "mapping-conflict");
addAccount(TENANT, "payment_failed", "payment-failed");
const cohort: Kind[] = ["stale_mapping", "stale_mapping", "stale_mapping", "healthy_migrated", "healthy_migrated", "payment_failed", ...Array(18).fill("healthy")];
for (const k of cohort.sort(() => rand() - 0.5)) addAccount(TENANT, k, "cohort");
// another tenant whose workspace id collides with the main customer's: access
// and joins must be tenant-scoped or this row leaks across tenants
addAccount(OTHER, "healthy", "other-tenant-collision", { workspaceId: cast[0].current_workspace as string });

// --- write ----------------------------------------------------------------------
async function load(source: "billing" | "workspace_map" | "entitlements", tables: Record<string, Row[]>) {
  const db = pool(source, "owner");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`TRUNCATE ${Object.keys(tables).reverse().join(", ")} CASCADE`);
    for (const [table, rows] of Object.entries(tables)) {
      for (const row of rows) {
        const cols = Object.keys(row);
        await client.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((c) => row[c]));
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await db.end();
  }
}

await load("billing", billing);
await load("workspace_map", wmap);
await load("entitlements", { ...ent, repair_receipts: [] });

const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });
const out = { seed: SEED, observed_at: T.toISOString(), note: "Synthetic sandbox data. stale_mapping rows are injected faults.", cast };
fs.writeFileSync(path.join(outDir, `${SEED}.json`), JSON.stringify(out, null, 2));

const count = (o: Record<string, Row[]>) => Object.entries(o).map(([k, v]) => `${k}=${v.length}`).join(" ");
console.log(`seed=${SEED} observed_at=${T.toISOString()}`);
console.log(`billing: ${count(billing)}`);
console.log(`workspace_map: ${count(wmap)}`);
console.log(`entitlements: ${count(ent)}`);
console.log(`cast written to seed/out/${SEED}.json (tokens are local test values)`);
