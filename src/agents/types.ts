// Run record and decision shapes for the investigator / checker workflow.
// Shared contracts stay in src/contracts.ts; this file is owned by agents/.

import type {
  AccessProbe,
  CaseStatus,
  CheckResult,
  Entitlement,
  ExecutionReceipt,
  GrantEvent,
  MigrationEvent,
  PaymentLine,
  ProvisioningRun,
  ReadCoverage,
  RepairPlan,
  SourceRef,
  WorkspaceMapping,
} from "../contracts.ts";
import type { EvidenceRegistry } from "./evidence-registry.ts";

export const ALLOWED_TOOLS = [
  "get_payments",
  "get_workspace_mappings",
  "get_entitlement_trail",
  "check_conditions",
] as const;

export type AllowedToolName = (typeof ALLOWED_TOOLS)[number];

export type InvestigationStopReason =
  | "completed"
  | "unavailable"
  | "invalid_model_response"
  | "unsupported_decision"
  | "insufficient_evidence"
  | "investigator_budget"
  | "checker_budget";

/** Proposed Agentel role names; unbound until real authentication. */
export const PROPOSED_ROLES = {
  investigator: "Workflow Atlas",
  checker: "LoopSmith",
} as const;

export interface CausalLink {
  cause: string;
  effect: string;
  refs: SourceRef[];
  /**
   * True only when independently supported by observed facts in this run
   * (never by a model-only flag). repair_candidate alone is not causal proof.
   */
  supported: boolean;
  /** What the model claimed; stored for audit, never upgrades `supported`. */
  modelClaimedSupported: boolean;
}

export interface Hypothesis {
  /** Optional on historical artifacts; identifies a source-condition proposition, not arbitrary prose. */
  conditionId?: string;
  /** Proposition polarity: true means condition holds; false means condition does not hold. Legacy default true. */
  conditionExpectedPassed?: boolean;
  paymentLineId?: string;
  id: string;
  claim: string;
  status: "active" | "supported" | "excluded";
  exclusionReason?: string;
  refs: SourceRef[];
}

export interface FindingProposal {
  conclusion: string;
  statusClaim: CaseStatus | "unknown";
  causalLinks: CausalLink[];
  hypotheses: Hypothesis[];
  missingEvidence: string[];
  evidenceRefs: SourceRef[];
  /**
   * Retarget suggestion. Runtime path: model selects evidence IDs only; fields
   * below are derived from trusted observed records (never model-authored versions).
   * Legacy parser tests may omit evidence IDs and supply derived fields directly.
   */
  repairSuggestion?: {
    paymentEvidenceId?: string;
    entitlementEvidenceId?: string;
    currentMappingEvidenceId?: string;
    paymentLineId: string;
    entitlementId: string;
    feature: string;
    fromWorkspace: string;
    toWorkspace: string;
    expectedVersion: number;
    mappingVersion: number;
  };
}

/** Model-facing repair selection — records only; versions/workspaces derived at resolve. */
export interface ModelRepairSelection {
  paymentEvidenceId: string;
  entitlementEvidenceId: string;
  currentMappingEvidenceId: string;
}

/** Parsed decision body — no provider/call ids (those live on the trace). */
export type InvestigatorDecision =
  | {
      kind: "call_tool";
      tool: AllowedToolName;
      /** What discriminating evidence this call seeks (not hidden CoT). */
      seeking: string;
    }
  | {
      kind: "propose_finding";
      finding: FindingProposal;
    }
  | {
      kind: "stop";
      reason: string;
    };

export type CheckerDecision =
  | {
      kind: "accept";
      note: string;
    }
  | {
      kind: "need_evidence";
      feedback: string;
      suggestedTool?: AllowedToolName;
    }
  | {
      kind: "reject";
      feedback: string;
    };

export interface ToolTraceEntry {
  step: number;
  role: "investigator" | "checker" | "system";
  action: "model" | "tool" | "gate" | "plan" | "feedback";
  /** Locally generated id for this workflow model/tool step. */
  callId?: string;
  /**
   * Provider response id when the chat client exposes one.
   * chat() currently does not — record null, never synthesize.
   */
  providerResponseId?: string | null;
  tool?: string;
  seeking?: string;
  /** Tool results are facts; model text is hypothesis. */
  fact?: unknown;
  decision?: InvestigatorDecision | CheckerDecision | { kind: string; detail: string };
  at: string;
}

export interface ModelMeta {
  model: string;
  provider: string;
  baseUrl?: string;
  available: boolean;
}

export interface InvestigationRequest {
  tenantId: string;
  billingAccountId: string;
  /** Frozen for the whole investigation. */
  observedAt?: Date | string;
  /** Optional priority hint from memory recall; never affects eligibility. */
  suggestedPriority?: string[];
  /** Operator memory toggle for this run (priority only). */
  memoryEnabled?: boolean;
  /** Lesson ids actually recalled for this run (audit). */
  recalledLessonIds?: string[];
}

/** Bounded fact bundle gathered during the run (untrusted until scoped). */
export interface GatheredFacts {
  payments: PaymentLine[];
  mappings: WorkspaceMapping[];
  migrations: MigrationEvent[];
  entitlements: Entitlement[];
  grants: GrantEvent[];
  runs: ProvisioningRun[];
  coverage: ReadCoverage[];
  /** All SourceRefs seen on records in this run (tenant-scoped). */
  observedRefs: SourceRef[];
  /** Run-local opaque evidence IDs issued only from scoped tool facts. */
  evidence: EvidenceRegistry;
  lastCheck?: CheckResult;
  /** Full InvestigationContext from check_conditions, when obtained. */
  freshContext?: {
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
  };
}

export interface InvestigationRun {
  runId: string;
  tenantId: string;
  billingAccountId: string;
  observedAt: string;
  status: InvestigationStopReason;
  model: ModelMeta;
  proposedRoles: typeof PROPOSED_ROLES;
  identityBound: false;
  trace: ToolTraceEntry[];
  coverage: ReadCoverage[];
  gathered: GatheredFacts;
  lastCheck?: CheckResult;
  finding?: FindingProposal;
  checkerFeedback?: string[];
  followUpActions: string[];
  /** Deterministic gate status for the primary line, if known. */
  eligibility?: CaseStatus;
  repairPlan?: RepairPlan;
  repairConfirmed: boolean;
  receipt?: ExecutionReceipt;
  accessProbe?: AccessProbe;
  /** Whether H-MEM was enabled for this run (priority only; never eligibility). */
  memoryEnabled?: boolean;
  /** Lesson ids recalled when memory was enabled. */
  recalledLessonIds?: string[];
  /** Suggested tool priority from memory (informational). */
  suggestedPriority?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelResponse {
  text: string;
  /**
   * Provider-issued response id when available.
   * chat() does not expose one today — callers must pass null, never invent.
   */
  providerResponseId: string | null;
  /**
   * Provider finish_reason when exposed (e.g. stop|length|content_filter).
   * length / content_filter are rejected before decision parsing.
   */
  finishReason?: string | null;
  model: string;
  provider: string;
  baseUrl?: string;
}

export type ModelCaller = (
  messages: ChatTurn[],
  opts: { role: "investigator" | "checker"; callIndex: number },
) => Promise<ModelResponse>;

export type ToolRunner = (
  name: AllowedToolName,
  args: { tenant_id: string; billing_account_id: string },
  observedAt: Date,
) => Promise<unknown>;
