// Read-only fact loading for one customer (tenant + billing account).
//
// Two read paths return the same InvestigationContext shape:
//   via Zetaris  - what the investigation agents use. The payment -> entitlement
//                  -> grant -> run trail is ONE cross-source query, joined by
//                  Zetaris across the billing and entitlements datasources.
//   direct       - what the repair executor uses right before it writes, so a
//                  cached federated view can never authorise a change.
//
// Every query here is fixed and parameterised by validated ids. Nothing in this
// module accepts free SQL.

import type {
  Entitlement, GrantEvent, InvestigationContext, MigrationEvent, PaymentLine,
  ProvisioningRun, ReadCoverage, SourceName, SourceRef, WorkspaceMapping,
} from "../contracts.ts";
import { pool } from "../sources.ts";
import { records, Zetaris } from "../zetaris.ts";

export const ROW_LIMIT = 500;
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

export function assertId(name: string, value: string): string {
  if (!ID.test(value)) throw new Error(`invalid ${name}: ${JSON.stringify(value)}`);
  return value;
}

// Zetaris returns "2026-10-19 07:24:00.0" (UTC); Postgres returns Date.
export function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?/.exec(s);
  if (m) return new Date(`${m[1]}T${m[2]}Z`).toISOString();
  return new Date(s).toISOString();
}
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

const ref = (source: SourceName, table: string, key: Record<string, string>, via: SourceRef["via"], version?: number | null): SourceRef =>
  version === null || version === undefined ? { source, table, key, via } : { source, table, key, via, version };

type Raw = Record<string, unknown>;

// ---- row mappers shared by both paths -------------------------------------------

function toPayment(r: Raw, via: SourceRef["via"], features: string[]): PaymentLine {
  return {
    tenantId: String(r.tenant_id), paymentLineId: String(r.payment_line_id), billingAccountId: String(r.billing_account_id),
    productId: String(r.product_id), features, periodStart: iso(r.period_start)!, periodEnd: iso(r.period_end)!,
    amountCents: Number(r.amount_cents), currency: String(r.currency), status: String(r.status) as PaymentLine["status"],
    paidAt: iso(r.paid_at), recordVersion: Number(r.record_version),
    ref: ref("billing", "payment_lines", { tenant_id: String(r.tenant_id), payment_line_id: String(r.payment_line_id) }, via, Number(r.record_version)),
  };
}

function toMapping(r: Raw, via: SourceRef["via"]): WorkspaceMapping {
  return {
    tenantId: String(r.tenant_id), mappingId: String(r.mapping_id), billingAccountId: String(r.billing_account_id),
    workspaceId: String(r.workspace_id), validFrom: iso(r.valid_from)!, validTo: iso(r.valid_to),
    mappingVersion: Number(r.mapping_version), sourceRef: String(r.source_ref),
    ref: ref("workspace_map", "workspace_mappings", { tenant_id: String(r.tenant_id), mapping_id: String(r.mapping_id) }, via, Number(r.mapping_version)),
  };
}

function toMigration(r: Raw, via: SourceRef["via"]): MigrationEvent {
  return {
    tenantId: String(r.tenant_id), migrationId: String(r.migration_id), billingAccountId: String(r.billing_account_id),
    fromWorkspace: String(r.from_workspace), toWorkspace: String(r.to_workspace), effectiveAt: iso(r.effective_at)!,
    sourceRef: String(r.source_ref),
    ref: ref("workspace_map", "migration_events", { tenant_id: String(r.tenant_id), migration_id: String(r.migration_id) }, via),
  };
}

function toEntitlement(r: Raw, via: SourceRef["via"], p = ""): Entitlement {
  return {
    tenantId: String(r[`${p}tenant_id`]), entitlementId: String(r[`${p}entitlement_id`]), paymentLineId: String(r[`${p}payment_line_id`]),
    feature: String(r[`${p}feature`]), periodStart: iso(r[`${p}period_start`])!, periodEnd: iso(r[`${p}period_end`])!,
    targetWorkspaceId: String(r[`${p}target_workspace_id`]), status: String(r[`${p}status`]) as Entitlement["status"],
    version: Number(r[`${p}version`]), updatedAt: iso(r[`${p}updated_at`])!,
    ref: ref("entitlements", "entitlements", { tenant_id: String(r[`${p}tenant_id`]), entitlement_id: String(r[`${p}entitlement_id`]) }, via, Number(r[`${p}version`])),
  };
}

function toGrant(r: Raw, via: SourceRef["via"], p = ""): GrantEvent {
  return {
    tenantId: String(r[`${p}tenant_id`]), eventId: String(r[`${p}event_id`]), entitlementId: String(r[`${p}entitlement_id`]),
    eventType: String(r[`${p}event_type`]) as GrantEvent["eventType"], targetWorkspaceId: String(r[`${p}target_workspace_id`]),
    mappingVersionUsed: num(r[`${p}mapping_version_used`]), actor: String(r[`${p}actor`]), at: iso(r[`${p}at`])!,
    receiptId: str(r[`${p}receipt_id`]),
    ref: ref("entitlements", "grant_events", { tenant_id: String(r[`${p}tenant_id`]), event_id: String(r[`${p}event_id`]) }, via),
  };
}

function toRun(r: Raw, via: SourceRef["via"], p = ""): ProvisioningRun {
  return {
    tenantId: String(r[`${p}tenant_id`]), runId: String(r[`${p}run_id`]), paymentLineId: String(r[`${p}payment_line_id`]),
    status: String(r[`${p}status`]) as ProvisioningRun["status"], targetUsed: str(r[`${p}target_used`]),
    mappingVersionUsed: num(r[`${p}mapping_version_used`]), startedAt: iso(r[`${p}started_at`])!, finishedAt: iso(r[`${p}finished_at`]),
    ref: ref("entitlements", "provisioning_runs", { tenant_id: String(r[`${p}tenant_id`]), run_id: String(r[`${p}run_id`]) }, via),
  };
}

const uniqBy = <T,>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];

// ---- via Zetaris ---------------------------------------------------------------------

export class ZetarisFacts {
  constructor(private z = new Zetaris()) {}

  private async q(tool: string, statement: string, coverage: ReadCoverage[]) {
    const r = await this.z.sql(statement, ROW_LIMIT);
    const complete = r.total < ROW_LIMIT;
    coverage.push({ tool, via: "zetaris", rows: r.total, complete, note: complete ? undefined : `row limit ${ROW_LIMIT} reached` });
    return records(r) as Raw[];
  }

  // Payments with their features (billing only).
  async payments(tenant: string, account: string, coverage: ReadCoverage[] = []): Promise<PaymentLine[]> {
    const t = assertId("tenant_id", tenant), a = assertId("billing_account_id", account);
    const rows = await this.q("get_payments", `
      SELECT p.*, f.feature AS f_feature
        FROM rl_billing.payment_lines p
        LEFT JOIN rl_billing.product_features f ON f.tenant_id = p.tenant_id AND f.product_id = p.product_id
       WHERE p.tenant_id = '${t}' AND p.billing_account_id = '${a}'`, coverage);
    const byLine = new Map<string, { row: Raw; features: string[] }>();
    for (const r of rows) {
      const e = byLine.get(String(r.payment_line_id)) ?? { row: r, features: [] };
      if (r.f_feature) e.features.push(String(r.f_feature));
      byLine.set(String(r.payment_line_id), e);
    }
    return [...byLine.values()].map(({ row, features }) => toPayment(row, "zetaris", features));
  }

  // Mapping history and migration events (workspace_map only). Every row is
  // returned, overlapping or not: conflicts are for the checks to find.
  async mappings(tenant: string, account: string, coverage: ReadCoverage[] = []) {
    const t = assertId("tenant_id", tenant), a = assertId("billing_account_id", account);
    const m = await this.q("get_workspace_mappings", `
      SELECT * FROM rl_workspace_map.workspace_mappings
       WHERE tenant_id = '${t}' AND billing_account_id = '${a}' ORDER BY mapping_version, valid_from`, coverage);
    const g = await this.q("get_migration_events", `
      SELECT * FROM rl_workspace_map.migration_events
       WHERE tenant_id = '${t}' AND billing_account_id = '${a}' ORDER BY effective_at`, coverage);
    return { mappings: m.map((r) => toMapping(r, "zetaris")), migrations: g.map((r) => toMigration(r, "zetaris")) };
  }

  // The cross-source trail: billing.payment_lines LEFT JOIN entitlements,
  // grant history and provisioning runs. LEFT JOINs keep a paid line that has
  // no entitlement, which is itself evidence.
  async trail(tenant: string, account: string, coverage: ReadCoverage[] = []) {
    const t = assertId("tenant_id", tenant), a = assertId("billing_account_id", account);
    const rows = await this.q("get_entitlement_trail", `
      SELECT p.payment_line_id AS pl,
             e.tenant_id AS e_tenant_id, e.entitlement_id AS e_entitlement_id, e.payment_line_id AS e_payment_line_id,
             e.feature AS e_feature, e.period_start AS e_period_start, e.period_end AS e_period_end,
             e.target_workspace_id AS e_target_workspace_id, e.status AS e_status, e.version AS e_version, e.updated_at AS e_updated_at,
             g.tenant_id AS g_tenant_id, g.event_id AS g_event_id, g.entitlement_id AS g_entitlement_id, g.event_type AS g_event_type,
             g.target_workspace_id AS g_target_workspace_id, g.mapping_version_used AS g_mapping_version_used,
             g.actor AS g_actor, g.at AS g_at, g.receipt_id AS g_receipt_id,
             r.tenant_id AS r_tenant_id, r.run_id AS r_run_id, r.payment_line_id AS r_payment_line_id, r.status AS r_status,
             r.target_used AS r_target_used, r.mapping_version_used AS r_mapping_version_used,
             r.started_at AS r_started_at, r.finished_at AS r_finished_at
        FROM rl_billing.payment_lines p
        LEFT JOIN rl_entitlements.entitlements e ON e.tenant_id = p.tenant_id AND e.payment_line_id = p.payment_line_id
        LEFT JOIN rl_entitlements.grant_events g ON g.tenant_id = e.tenant_id AND g.entitlement_id = e.entitlement_id
        LEFT JOIN rl_entitlements.provisioning_runs r ON r.tenant_id = p.tenant_id AND r.payment_line_id = p.payment_line_id
       WHERE p.tenant_id = '${t}' AND p.billing_account_id = '${a}'`, coverage);
    return {
      entitlements: uniqBy(rows.filter((r) => r.e_entitlement_id).map((r) => toEntitlement(r, "zetaris", "e_")), (x) => x.entitlementId),
      grants: uniqBy(rows.filter((r) => r.g_event_id).map((r) => toGrant(r, "zetaris", "g_")), (x) => x.eventId).sort((x, y) => x.at.localeCompare(y.at)),
      runs: uniqBy(rows.filter((r) => r.r_run_id).map((r) => toRun(r, "zetaris", "r_")), (x) => x.runId),
    };
  }

  async context(tenant: string, account: string, observedAt = new Date()): Promise<InvestigationContext> {
    const coverage: ReadCoverage[] = [];
    const payments = await this.payments(tenant, account, coverage);
    const { mappings, migrations } = await this.mappings(tenant, account, coverage);
    const { entitlements, grants, runs } = await this.trail(tenant, account, coverage);
    return { tenantId: tenant, billingAccountId: account, observedAt: observedAt.toISOString(), payments, mappings, migrations, entitlements, grants, runs, coverage };
  }
}

// ---- direct (executor re-read) ---------------------------------------------------------

export async function directContext(tenant: string, account: string, observedAt = new Date()): Promise<InvestigationContext> {
  const t = assertId("tenant_id", tenant), a = assertId("billing_account_id", account);
  const coverage: ReadCoverage[] = [];
  const read = async (source: SourceName, tool: string, sql: string, params: unknown[]) => {
    const db = pool(source, "executor");
    try {
      const { rows } = await db.query(sql, params);
      coverage.push({ tool, via: "direct", rows: rows.length, complete: true });
      return rows as Raw[];
    } finally {
      await db.end();
    }
  };
  const pRows = await read("billing", "get_payments",
    `SELECT p.*, coalesce(array_agg(f.feature) FILTER (WHERE f.feature IS NOT NULL), '{}') AS features
       FROM payment_lines p LEFT JOIN product_features f ON f.tenant_id = p.tenant_id AND f.product_id = p.product_id
      WHERE p.tenant_id = $1 AND p.billing_account_id = $2 GROUP BY p.tenant_id, p.payment_line_id`, [t, a]);
  const payments = pRows.map((r) => toPayment(r, "direct", (r.features as string[]) ?? []));
  const lines = payments.map((p) => p.paymentLineId);
  const mRows = await read("workspace_map", "get_workspace_mappings",
    "SELECT * FROM workspace_mappings WHERE tenant_id = $1 AND billing_account_id = $2 ORDER BY mapping_version, valid_from", [t, a]);
  const gRows = await read("workspace_map", "get_migration_events",
    "SELECT * FROM migration_events WHERE tenant_id = $1 AND billing_account_id = $2 ORDER BY effective_at", [t, a]);
  const eRows = await read("entitlements", "get_entitlements",
    "SELECT * FROM entitlements WHERE tenant_id = $1 AND payment_line_id = ANY($2)", [t, lines]);
  const ids = eRows.map((r) => String(r.entitlement_id));
  const grRows = await read("entitlements", "get_grant_events",
    "SELECT * FROM grant_events WHERE tenant_id = $1 AND entitlement_id = ANY($2) ORDER BY at", [t, ids]);
  const rRows = await read("entitlements", "get_provisioning_runs",
    "SELECT * FROM provisioning_runs WHERE tenant_id = $1 AND payment_line_id = ANY($2)", [t, lines]);
  return {
    tenantId: t, billingAccountId: a, observedAt: observedAt.toISOString(), payments,
    mappings: mRows.map((r) => toMapping(r, "direct")), migrations: gRows.map((r) => toMigration(r, "direct")),
    entitlements: eRows.map((r) => toEntitlement(r, "direct")), grants: grRows.map((r) => toGrant(r, "direct")),
    runs: rRows.map((r) => toRun(r, "direct")), coverage,
  };
}
