// Shared contracts between the data layer (src/data), the repair executor
// (src/repair) and the agents / Why card / UI (src/agents, src/why, ...).
// Change this file only by agreement: both sides build against it.

export type SourceName = "billing" | "workspace_map" | "entitlements";

// Where a fact came from. Every fact the agents see carries one, so a Why card
// can cite record, version and read path.
export interface SourceRef {
  source: SourceName;
  table: string;
  key: Record<string, string>;
  version?: number;
  via: "zetaris" | "direct";
}

// ---- facts --------------------------------------------------------------------

export interface PaymentLine {
  tenantId: string;
  paymentLineId: string;
  billingAccountId: string;
  productId: string;
  features: string[]; // from billing.product_features, never guessed
  periodStart: string; // ISO timestamps throughout
  periodEnd: string;
  amountCents: number;
  currency: string;
  status: "paid" | "failed" | "refunded";
  paidAt: string | null;
  recordVersion: number;
  ref: SourceRef;
}

export interface WorkspaceMapping {
  tenantId: string;
  mappingId: string;
  billingAccountId: string;
  workspaceId: string;
  validFrom: string;
  validTo: string | null;
  mappingVersion: number;
  sourceRef: string;
  ref: SourceRef;
}

export interface MigrationEvent {
  tenantId: string;
  migrationId: string;
  billingAccountId: string;
  fromWorkspace: string;
  toWorkspace: string;
  effectiveAt: string;
  sourceRef: string;
  ref: SourceRef;
}

export interface Entitlement {
  tenantId: string;
  entitlementId: string;
  paymentLineId: string;
  feature: string;
  periodStart: string;
  periodEnd: string;
  targetWorkspaceId: string;
  status: "active" | "revoked";
  version: number;
  updatedAt: string;
  ref: SourceRef;
}

export interface GrantEvent {
  tenantId: string;
  eventId: string;
  entitlementId: string;
  eventType: "grant" | "retarget" | "revoke";
  targetWorkspaceId: string;
  mappingVersionUsed: number | null;
  actor: string;
  at: string;
  receiptId: string | null;
  ref: SourceRef;
}

export interface ProvisioningRun {
  tenantId: string;
  runId: string;
  paymentLineId: string;
  status: "pending" | "success" | "failed";
  targetUsed: string | null;
  mappingVersionUsed: number | null;
  startedAt: string;
  finishedAt: string | null;
  ref: SourceRef;
}

// What a read covered. complete=false means rows may be missing (limit hit,
// read error), and nothing may be concluded as "absent" from that read.
export interface ReadCoverage {
  tool: string;
  via: "zetaris" | "direct";
  rows: number;
  complete: boolean;
  note?: string;
}

// Everything known about one customer (billing account) at observedAt.
export interface InvestigationContext {
  tenantId: string;
  billingAccountId: string;
  observedAt: string;
  payments: PaymentLine[];
  mappings: WorkspaceMapping[];
  migrations: MigrationEvent[];
  entitlements: Entitlement[];
  grants: GrantEvent[];
  runs: ProvisioningRun[];
  coverage: ReadCoverage[];
}

// ---- checks ---------------------------------------------------------------------

// consistent         entitlement sits on the currently mapped workspace
// processing         paid recently, still inside the provisioning window
// repair_candidate   entitlement sits on a workspace the account left; one
//                    current mapping exists; a retarget is admissible
// needs_verification evidence missing, incomplete or conflicting: never repair
// not_entitled       payment not in force (failed, refunded, period over)
export type CaseStatus = "consistent" | "processing" | "repair_candidate" | "needs_verification" | "not_entitled";

export interface ConditionResult {
  id: string; // stable, e.g. "payment.paid", "mapping.unique_current"
  passed: boolean;
  detail: string;
  refs: SourceRef[];
}

export interface LineCheck {
  paymentLineId: string;
  feature: string | null;
  status: CaseStatus;
  conditions: ConditionResult[];
  missing: string[]; // what evidence would be needed to decide
}

export interface CheckResult {
  tenantId: string;
  billingAccountId: string;
  observedAt: string;
  lines: LineCheck[];
}

// ---- repair ---------------------------------------------------------------------

// The one admissible action: point an existing entitlement at the workspace
// the authoritative mapping says is current. Never creates an entitlement and
// never edits the mapping.
export interface RepairPlan {
  action: "retarget_entitlement";
  tenantId: string;
  billingAccountId: string;
  paymentLineId: string;
  entitlementId: string;
  feature: string;
  fromWorkspace: string;
  toWorkspace: string;
  expectedVersion: number; // entitlement version the plan was made against
  mappingVersion: number; // current mapping version that justifies toWorkspace
  intentKey: string; // stable per intended change; retries reuse it
  payloadFingerprint: string; // sha256 of the canonical payload
  evidenceRefs: SourceRef[];
  proposedBy: string; // agent or person
}

export type RejectReason =
  | "payload_conflict" // same intentKey, different payload
  | "version_changed" // entitlement moved since the plan was made
  | "not_repair_candidate" // fresh re-check says this is not a retarget case
  | "plan_mismatch" // plan disagrees with freshly read facts
  | "invalid_plan";

export interface ExecutionReceipt {
  outcome: "applied" | "replayed" | "rejected";
  reason?: RejectReason;
  detail: string;
  receiptId?: string;
  entitlementId?: string;
  fromWorkspace?: string;
  toWorkspace?: string;
  previousVersion?: number;
  newVersion?: number;
  recheck?: CheckResult; // the fresh pre-execution check
  at: string;
}

export interface AccessProbe {
  workspace: string;
  feature: string;
  status: number; // real HTTP status from the sandbox service
  body: unknown;
  at: string;
}
