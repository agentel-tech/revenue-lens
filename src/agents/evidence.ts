// Observed-fact registry for a single investigation run.
// Evidence refs and causal support are checked against records actually read
// in this run for the request tenant/account — never against model invention.
// Model-facing payloads use opaque evidence IDs from EvidenceRegistry.

import type {
  CheckResult,
  ConditionResult,
  Entitlement,
  GrantEvent,
  InvestigationContext,
  MigrationEvent,
  PaymentLine,
  ProvisioningRun,
  ReadCoverage,
  SourceRef,
  WorkspaceMapping,
} from "../contracts.ts";
import { EvidenceRegistry, sortedKeyEntries, withEvidenceId } from "./evidence-registry.ts";
import type {
  CausalLink,
  FindingProposal,
  GatheredFacts,
  Hypothesis,
  ModelRepairSelection,
} from "./types.ts";

export { sortedKeyEntries };

function asScopedString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`repair record missing string ${field}`);
  return v.trim();
}

function asScopedSafeInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) {
    throw new Error(`repair record invalid integer ${field}: ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * Resolve model-selected evidence IDs to trusted observed record facts.
 * Derives plan fields (including entitlement expectedVersion) from those records —
 * never from model-authored versions or workspaces.
 */
export function resolveRepairSuggestion(
  selection: ModelRepairSelection,
  registry: EvidenceRegistry,
  scope: { tenantId: string; billingAccountId: string },
): NonNullable<FindingProposal["repairSuggestion"]> {
  const pay = registry.lookup(selection.paymentEvidenceId);
  const ent = registry.lookup(selection.entitlementEvidenceId);
  const map = registry.lookup(selection.currentMappingEvidenceId);

  if (pay.fact.kind !== "payment") {
    throw new Error("paymentEvidenceId must cite a payment record");
  }
  if (pay.ref.source !== "billing" || pay.ref.table !== "payment_lines") {
    throw new Error("paymentEvidenceId has wrong source/table");
  }
  if (ent.fact.kind !== "entitlement") {
    throw new Error("entitlementEvidenceId must cite an entitlement record");
  }
  if (ent.ref.source !== "entitlements" || ent.ref.table !== "entitlements") {
    throw new Error("entitlementEvidenceId has wrong source/table");
  }
  if (map.fact.kind !== "mapping") {
    throw new Error("currentMappingEvidenceId must cite a workspace mapping record");
  }
  if (map.ref.source !== "workspace_map" || map.ref.table !== "workspace_mappings") {
    throw new Error("currentMappingEvidenceId has wrong source/table");
  }

  const payTenant = asScopedString(pay.fact.tenantId, "payment.tenantId");
  const payAccount = asScopedString(pay.fact.billingAccountId, "payment.billingAccountId");
  if (payTenant !== scope.tenantId || payAccount !== scope.billingAccountId) {
    throw new Error("payment evidence tenant/account scope mismatch");
  }

  const entTenant = asScopedString(ent.fact.tenantId, "entitlement.tenantId");
  if (entTenant !== scope.tenantId) {
    throw new Error("entitlement evidence tenant scope mismatch");
  }

  const mapTenant = asScopedString(map.fact.tenantId, "mapping.tenantId");
  const mapAccount = asScopedString(map.fact.billingAccountId, "mapping.billingAccountId");
  if (mapTenant !== scope.tenantId || mapAccount !== scope.billingAccountId) {
    throw new Error("mapping evidence tenant/account scope mismatch");
  }

  const paymentLineId = asScopedString(pay.fact.paymentLineId, "payment.paymentLineId");
  const entitlementId = asScopedString(ent.fact.entitlementId, "entitlement.entitlementId");
  const feature = asScopedString(ent.fact.feature, "entitlement.feature");
  const entPaymentLineId = asScopedString(ent.fact.paymentLineId, "entitlement.paymentLineId");
  if (entPaymentLineId !== paymentLineId) {
    throw new Error("entitlement/payment evidence IDs do not match the same payment line");
  }

  const features = pay.fact.features;
  if (!Array.isArray(features) || !features.every((f) => typeof f === "string")) {
    throw new Error("payment evidence missing features");
  }
  if (!features.includes(feature)) {
    throw new Error("entitlement feature not present on selected payment line");
  }

  const fromWorkspace = asScopedString(ent.fact.targetWorkspaceId, "entitlement.targetWorkspaceId");
  const toWorkspace = asScopedString(map.fact.workspaceId, "mapping.workspaceId");
  const expectedVersion = asScopedSafeInt(ent.fact.version, "entitlement.version");
  const mappingVersion = asScopedSafeInt(map.fact.mappingVersion, "mapping.mappingVersion");

  return {
    paymentEvidenceId: selection.paymentEvidenceId,
    entitlementEvidenceId: selection.entitlementEvidenceId,
    currentMappingEvidenceId: selection.currentMappingEvidenceId,
    paymentLineId,
    entitlementId,
    feature,
    fromWorkspace,
    toWorkspace,
    expectedVersion,
    mappingVersion,
  };
}

export function emptyGathered(): GatheredFacts {
  return {
    payments: [],
    mappings: [],
    migrations: [],
    entitlements: [],
    grants: [],
    runs: [],
    coverage: [],
    observedRefs: [],
    evidence: new EvidenceRegistry(),
  };
}

function refKey(r: SourceRef): string {
  const ver = r.version === undefined ? "" : `@v${r.version}`;
  return `${r.source}|${r.table}|${sortedKeyEntries(r.key)}|${r.via}${ver}`;
}

/**
 * Exact SourceRef match against an observed record.
 * - source, table, via must equal
 * - key maps must have identical sorted entries (no subset matches)
 * - Version policy (explicit):
 *   - if cited.version is set, observed.version must equal it
 *   - if cited.version is omitted, observed may have any version (including undefined)
 */
export function refsMatch(observed: SourceRef, cited: SourceRef): boolean {
  if (observed.source !== cited.source || observed.table !== cited.table) return false;
  if (observed.via !== cited.via) return false;
  if (sortedKeyEntries(observed.key) !== sortedKeyEntries(cited.key)) return false;
  if (cited.version !== undefined && observed.version !== cited.version) return false;
  return true;
}

export function isRefObserved(cited: SourceRef, observed: SourceRef[]): boolean {
  return observed.some((o) => refsMatch(o, cited));
}

export function assertRefsObserved(refs: SourceRef[], observed: SourceRef[], label: string): void {
  for (const r of refs) {
    if (!isRefObserved(r, observed)) {
      throw new Error(`${label}: unsupported evidence ref not observed in this run: ${refKey(r)}`);
    }
  }
}

function pushRef(
  g: GatheredFacts,
  r: SourceRef | undefined,
  tenantId: string,
  billingAccountId: string | undefined,
  fact: Record<string, unknown>,
): void {
  if (!r) return;
  if (r.key.tenant_id && r.key.tenant_id !== tenantId) return;
  if (billingAccountId && r.key.billing_account_id && r.key.billing_account_id !== billingAccountId) return;
  if (!g.observedRefs.some((o) => refKey(o) === refKey(r))) g.observedRefs.push(r);
  g.evidence.register(r, fact);
}

function paymentFact(p: PaymentLine): Record<string, unknown> {
  return {
    kind: "payment",
    tenantId: p.tenantId,
    billingAccountId: p.billingAccountId,
    paymentLineId: p.paymentLineId,
    productId: p.productId,
    features: p.features,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    amountCents: p.amountCents,
    currency: p.currency,
    status: p.status,
    paidAt: p.paidAt,
    recordVersion: p.recordVersion,
  };
}

function mappingFact(m: WorkspaceMapping): Record<string, unknown> {
  return {
    kind: "mapping",
    tenantId: m.tenantId,
    billingAccountId: m.billingAccountId,
    mappingId: m.mappingId,
    workspaceId: m.workspaceId,
    validFrom: m.validFrom,
    validTo: m.validTo,
    mappingVersion: m.mappingVersion,
    sourceRef: m.sourceRef,
  };
}

function migrationFact(m: MigrationEvent): Record<string, unknown> {
  return {
    kind: "migration",
    tenantId: m.tenantId,
    billingAccountId: m.billingAccountId,
    migrationId: m.migrationId,
    fromWorkspace: m.fromWorkspace,
    toWorkspace: m.toWorkspace,
    effectiveAt: m.effectiveAt,
    sourceRef: m.sourceRef,
  };
}

function entitlementFact(e: Entitlement): Record<string, unknown> {
  return {
    kind: "entitlement",
    tenantId: e.tenantId,
    entitlementId: e.entitlementId,
    paymentLineId: e.paymentLineId,
    feature: e.feature,
    periodStart: e.periodStart,
    periodEnd: e.periodEnd,
    targetWorkspaceId: e.targetWorkspaceId,
    status: e.status,
    version: e.version,
    updatedAt: e.updatedAt,
  };
}

function grantFact(gr: GrantEvent): Record<string, unknown> {
  return {
    kind: "grant",
    tenantId: gr.tenantId,
    eventId: gr.eventId,
    entitlementId: gr.entitlementId,
    eventType: gr.eventType,
    targetWorkspaceId: gr.targetWorkspaceId,
    mappingVersionUsed: gr.mappingVersionUsed,
    actor: gr.actor,
    at: gr.at,
  };
}

function runFact(r: ProvisioningRun): Record<string, unknown> {
  return {
    kind: "provisioning_run",
    tenantId: r.tenantId,
    runId: r.runId,
    paymentLineId: r.paymentLineId,
    status: r.status,
    targetUsed: r.targetUsed,
    mappingVersionUsed: r.mappingVersionUsed,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

function ingestPayment(g: GatheredFacts, p: PaymentLine, tenantId: string, billingAccountId: string): void {
  if (p.tenantId !== tenantId || p.billingAccountId !== billingAccountId) return;
  if (!g.payments.some((x) => x.paymentLineId === p.paymentLineId)) g.payments.push(p);
  pushRef(g, p.ref, tenantId, billingAccountId, paymentFact(p));
}

function ingestMapping(g: GatheredFacts, m: WorkspaceMapping, tenantId: string, billingAccountId: string): void {
  if (m.tenantId !== tenantId || m.billingAccountId !== billingAccountId) return;
  if (!g.mappings.some((x) => x.mappingId === m.mappingId)) g.mappings.push(m);
  pushRef(g, m.ref, tenantId, billingAccountId, mappingFact(m));
}

function ingestMigration(g: GatheredFacts, m: MigrationEvent, tenantId: string, billingAccountId: string): void {
  if (m.tenantId !== tenantId || m.billingAccountId !== billingAccountId) return;
  if (!g.migrations.some((x) => x.migrationId === m.migrationId)) g.migrations.push(m);
  pushRef(g, m.ref, tenantId, billingAccountId, migrationFact(m));
}

function ingestEntitlement(g: GatheredFacts, e: Entitlement, tenantId: string): void {
  if (e.tenantId !== tenantId) return;
  if (!g.entitlements.some((x) => x.entitlementId === e.entitlementId)) g.entitlements.push(e);
  pushRef(g, e.ref, tenantId, undefined, entitlementFact(e));
}

function ingestGrant(g: GatheredFacts, gr: GrantEvent, tenantId: string): void {
  if (gr.tenantId !== tenantId) return;
  if (!g.grants.some((x) => x.eventId === gr.eventId)) g.grants.push(gr);
  pushRef(g, gr.ref, tenantId, undefined, grantFact(gr));
}

function ingestRun(g: GatheredFacts, r: ProvisioningRun, tenantId: string): void {
  if (r.tenantId !== tenantId) return;
  if (!g.runs.some((x) => x.runId === r.runId)) g.runs.push(r);
  pushRef(g, r.ref, tenantId, undefined, runFact(r));
}

function ingestCoverage(g: GatheredFacts, coverage: ReadCoverage[] | undefined): void {
  if (!Array.isArray(coverage)) return;
  g.coverage.push(...coverage);
}

function ingestCheck(g: GatheredFacts, check: CheckResult | undefined, tenantId: string, billingAccountId: string): void {
  if (!check) return;
  if (check.tenantId !== tenantId || check.billingAccountId !== billingAccountId) return;
  g.lastCheck = check;
  for (const line of check.lines) {
    for (const c of line.conditions) {
      for (const r of c.refs) {
        pushRef(g, r, tenantId, billingAccountId, {
          kind: "condition_ref",
          conditionId: c.id,
          paymentLineId: line.paymentLineId,
          feature: line.feature,
          passed: c.passed,
          detail: c.detail,
        });
      }
    }
  }
}

export function ingestToolFact(
  g: GatheredFacts,
  fact: unknown,
  tenantId: string,
  billingAccountId: string,
): void {
  if (!fact || typeof fact !== "object") return;
  const f = fact as Record<string, unknown>;

  if (Array.isArray(f.payments)) {
    for (const p of f.payments) ingestPayment(g, p as PaymentLine, tenantId, billingAccountId);
  }
  if (Array.isArray(f.mappings)) {
    for (const m of f.mappings) ingestMapping(g, m as WorkspaceMapping, tenantId, billingAccountId);
  }
  if (Array.isArray(f.migrations)) {
    for (const m of f.migrations) ingestMigration(g, m as MigrationEvent, tenantId, billingAccountId);
  }
  if (Array.isArray(f.entitlements)) {
    for (const e of f.entitlements) ingestEntitlement(g, e as Entitlement, tenantId);
  }
  if (Array.isArray(f.grants)) {
    for (const gr of f.grants) ingestGrant(g, gr as GrantEvent, tenantId);
  }
  if (Array.isArray(f.runs)) {
    for (const r of f.runs) ingestRun(g, r as ProvisioningRun, tenantId);
  }

  ingestCoverage(g, f.coverage as ReadCoverage[] | undefined);
  ingestCheck(g, f.check as CheckResult | undefined, tenantId, billingAccountId);

  const ctx = f.context as InvestigationContext | undefined;
  if (ctx && Array.isArray(ctx.payments)) {
    if (ctx.tenantId === tenantId && ctx.billingAccountId === billingAccountId) {
      g.freshContext = {
        tenantId: ctx.tenantId,
        billingAccountId: ctx.billingAccountId,
        observedAt: ctx.observedAt,
        payments: ctx.payments,
        mappings: ctx.mappings,
        migrations: ctx.migrations,
        entitlements: ctx.entitlements,
        grants: ctx.grants,
        runs: ctx.runs,
        coverage: ctx.coverage,
      };
      for (const p of ctx.payments) ingestPayment(g, p, tenantId, billingAccountId);
      for (const m of ctx.mappings) ingestMapping(g, m, tenantId, billingAccountId);
      for (const m of ctx.migrations) ingestMigration(g, m, tenantId, billingAccountId);
      for (const e of ctx.entitlements) ingestEntitlement(g, e, tenantId);
      for (const gr of ctx.grants) ingestGrant(g, gr, tenantId);
      for (const r of ctx.runs) ingestRun(g, r, tenantId);
      ingestCoverage(g, ctx.coverage);
    }
  }
}

function rewriteCheckForModel(check: CheckResult, registry: EvidenceRegistry): object {
  return {
    tenantId: check.tenantId,
    billingAccountId: check.billingAccountId,
    observedAt: check.observedAt,
    lines: check.lines.map((line) => ({
      paymentLineId: line.paymentLineId,
      feature: line.feature,
      status: line.status,
      missing: line.missing,
      conditions: line.conditions.map((c) => ({
        id: c.id,
        passed: c.passed,
        detail: c.detail,
        evidenceIds: c.refs.map((r) => {
          const id = registry.idFor(r);
          if (!id) throw new Error(`condition ref not registered: ${c.id}`);
          return id;
        }),
      })),
    })),
  };
}

/** Tool fact for the model: full field values, `evidenceId` instead of `ref`. */
export function toModelFacingFact(fact: unknown, g: GatheredFacts): unknown {
  if (!fact || typeof fact !== "object") return fact;
  const f = fact as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (Array.isArray(f.coverage)) out.coverage = f.coverage;
  if (Array.isArray(f.payments)) {
    out.payments = (f.payments as PaymentLine[])
      .filter((p) => g.payments.some((x) => x.paymentLineId === p.paymentLineId))
      .map((p) => withEvidenceId(p, g.evidence));
  }
  if (Array.isArray(f.mappings)) {
    out.mappings = (f.mappings as WorkspaceMapping[])
      .filter((m) => g.mappings.some((x) => x.mappingId === m.mappingId))
      .map((m) => withEvidenceId(m, g.evidence));
  }
  if (Array.isArray(f.migrations)) {
    out.migrations = (f.migrations as MigrationEvent[])
      .filter((m) => g.migrations.some((x) => x.migrationId === m.migrationId))
      .map((m) => withEvidenceId(m, g.evidence));
  }
  if (Array.isArray(f.entitlements)) {
    out.entitlements = (f.entitlements as Entitlement[])
      .filter((e) => g.entitlements.some((x) => x.entitlementId === e.entitlementId))
      .map((e) => withEvidenceId(e, g.evidence));
  }
  if (Array.isArray(f.grants)) {
    out.grants = (f.grants as GrantEvent[])
      .filter((gr) => g.grants.some((x) => x.eventId === gr.eventId))
      .map((gr) => withEvidenceId(gr, g.evidence));
  }
  if (Array.isArray(f.runs)) {
    out.runs = (f.runs as ProvisioningRun[])
      .filter((r) => g.runs.some((x) => x.runId === r.runId))
      .map((r) => withEvidenceId(r, g.evidence));
  }
  if (f.check && typeof f.check === "object") {
    out.check = rewriteCheckForModel(f.check as CheckResult, g.evidence);
  }
  if (f.context && typeof f.context === "object") {
    const ctx = f.context as InvestigationContext;
    out.context = {
      tenantId: ctx.tenantId,
      billingAccountId: ctx.billingAccountId,
      observedAt: ctx.observedAt,
      coverage: ctx.coverage,
      payments: ctx.payments.map((p) => withEvidenceId(p, g.evidence)),
      mappings: ctx.mappings.map((m) => withEvidenceId(m, g.evidence)),
      migrations: ctx.migrations.map((m) => withEvidenceId(m, g.evidence)),
      entitlements: ctx.entitlements.map((e) => withEvidenceId(e, g.evidence)),
      grants: ctx.grants.map((gr) => withEvidenceId(gr, g.evidence)),
      runs: ctx.runs.map((r) => withEvidenceId(r, g.evidence)),
    };
  }
  return out;
}

/**
 * Bounded payload for the checker: actual gathered records with evidenceIds.
 * Does not inject a verdict or preferred hypothesis. No raw SourceRefs.
 */
export function checkerFactsPayload(g: GatheredFacts, opts: { tenantId: string; billingAccountId: string; observedAt: string }): object {
  return {
    notice:
      "UNTRUSTED tool facts gathered in this run. Cite evidenceId values only (e1, e2, …). Assess competing hypotheses yourself. Do not assume a preferred cause.",
    scope: {
      tenantId: opts.tenantId,
      billingAccountId: opts.billingAccountId,
      observedAt: opts.observedAt,
    },
    coverage: g.coverage,
    payments: g.payments.map((p) => withEvidenceId(p, g.evidence)),
    mappings: g.mappings.map((m) => withEvidenceId(m, g.evidence)),
    migrations: g.migrations.map((m) => withEvidenceId(m, g.evidence)),
    entitlements: g.entitlements.map((e) => withEvidenceId(e, g.evidence)),
    grants: g.grants.map((gr) => withEvidenceId(gr, g.evidence)),
    runs: g.runs.map((r) => withEvidenceId(r, g.evidence)),
    evidenceCatalog: g.evidence.catalog(),
    lastCheck: g.lastCheck ? rewriteCheckForModel(g.lastCheck, g.evidence) : null,
  };
}

export interface SourceBackedCheck {
  paymentLineId: string;
  feature: string | null;
  conditionId: string;
  passed: boolean;
  detail: string;
  refs: SourceRef[];
}

/** Passed (and failed) gate conditions as source-backed checks — separate from model causal prose. */
export function extractSourceBackedChecks(check: CheckResult | undefined): SourceBackedCheck[] {
  if (!check) return [];
  const out: SourceBackedCheck[] = [];
  for (const line of check.lines) {
    for (const c of line.conditions) {
      out.push({
        paymentLineId: line.paymentLineId,
        feature: line.feature,
        conditionId: c.id,
        passed: c.passed,
        detail: c.detail,
        refs: c.refs,
      });
    }
  }
  return out;
}

export function passedSourceBackedChecks(check: CheckResult | undefined): SourceBackedCheck[] {
  return extractSourceBackedChecks(check).filter((c) => c.passed);
}

/**
 * Model-authored causal links are never promoted to supported facts.
 * Keep every model link as inference (`supported: false`); render gate conditions separately.
 */
export function independentCausalSupport(_link: CausalLink, _check: CheckResult | undefined): boolean {
  return false;
}

/** After IDs resolve to SourceRefs, keep causal links as inference only. */
export function materializeFinding(
  finding: FindingProposal,
  observedRefs: SourceRef[],
  _check: CheckResult | undefined,
): FindingProposal {
  assertRefsObserved(finding.evidenceRefs, observedRefs, "finding.evidenceRefs");
  for (const link of finding.causalLinks) {
    assertRefsObserved(link.refs, observedRefs, "causalLink.refs");
  }
  for (const h of finding.hypotheses) {
    assertRefsObserved(h.refs, observedRefs, "hypothesis.refs");
  }

  const causalLinks: CausalLink[] = finding.causalLinks.map((link) => ({
    ...link,
    supported: false,
  }));

  const hypotheses: Hypothesis[] = finding.hypotheses.map((h) => ({ ...h }));

  return { ...finding, causalLinks, hypotheses };
}

export function factsComplete(coverage: ReadCoverage[]): boolean {
  if (coverage.length === 0) return false;
  return !coverage.some((c) => !c.complete);
}

export function contextMatchesScope(
  ctx: GatheredFacts["freshContext"],
  tenantId: string,
  billingAccountId: string,
): ctx is NonNullable<GatheredFacts["freshContext"]> {
  return !!ctx && ctx.tenantId === tenantId && ctx.billingAccountId === billingAccountId;
}

/** Re-export ConditionResult for callers that pair checks with findings. */
export type { ConditionResult };
