// Load seeded cast for the demo operator UI. Tokens stay server-side only.
// Cohort members are loaded for bounded tenant scans; the default selector
// shows featured (non-cohort) accounts only. Seed role/kind/expected are
// never used as diagnosis — roles stay server-side only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Browser-facing cast fields — no seed role / expected-status labels, no tokens. */
export interface CastMemberPublic {
  tenantId: string;
  billingAccountId: string;
  name: string;
  currentWorkspace: string;
  paymentLineId: string;
}

export interface CastMemberPrivate extends CastMemberPublic {
  /** Seed cast role for server-side bookkeeping only — never sent to the browser. */
  role: string;
  token: string;
}

export function loadCast(seed = "demo"): { observedAt: string; members: CastMemberPrivate[] } {
  const file = path.join(root, "seed", "out", `${seed}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    observed_at: string;
    cast: Array<Record<string, unknown>>;
  };
  // Include cohort rows for tenant scan coverage; UI featured list filters them out.
  const members: CastMemberPrivate[] = raw.cast.map((c) => ({
    role: String(c.role),
    tenantId: String(c.tenant_id),
    billingAccountId: String(c.billing_account_id),
    name: String(c.name),
    currentWorkspace: String(c.current_workspace),
    paymentLineId: String(c.payment_line_id),
    token: String(c.token),
  }));
  return { observedAt: raw.observed_at, members };
}

/** Featured accounts for the default operator selector (excludes cohort fillers). */
export function featuredMembers(members: CastMemberPrivate[]): CastMemberPrivate[] {
  return members.filter((m) => m.role !== "cohort");
}

export function membersForTenant(members: CastMemberPrivate[], tenantId: string): CastMemberPrivate[] {
  return members.filter((m) => m.tenantId === tenantId);
}

export function publicAccounts(members: CastMemberPrivate[]): CastMemberPublic[] {
  return members.map(({ tenantId, billingAccountId, name, currentWorkspace, paymentLineId }) => ({
    tenantId,
    billingAccountId,
    name,
    currentWorkspace,
    paymentLineId,
  }));
}

export function findMember(
  members: CastMemberPrivate[],
  tenantId: string,
  billingAccountId: string,
): CastMemberPrivate | undefined {
  return members.find((m) => m.tenantId === tenantId && m.billingAccountId === billingAccountId);
}

export function distinctTenants(members: CastMemberPrivate[]): string[] {
  return [...new Set(members.map((m) => m.tenantId))].sort();
}
