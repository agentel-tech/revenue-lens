// Typed Why card derived from an InvestigationRun. Never claims customer
// recovery without a real sandbox access probe returning 200 after a receipt.
// Model causal links stay labeled inference; passed gate conditions render separately.
// Model assessment and deterministic eligibility are shown separately — disagreement
// never silently upgrades into write permission.

import type { AccessProbe, CaseStatus, ExecutionReceipt, RepairPlan, SourceRef } from "../contracts.ts";
import type { CausalLink, Hypothesis, InvestigationRun, ModelMeta } from "../agents/types.ts";
import { extractSourceBackedChecks, type SourceBackedCheck } from "../agents/evidence.ts";
import { findingAllowsRepairPlan } from "../agents/workflow.ts";

export type RepairLifecycle =
  | { state: "none" }
  | { state: "planned_not_executed"; plan: RepairPlan }
  | { state: "executed"; plan: RepairPlan; receipt: ExecutionReceipt; probe?: AccessProbe }
  | { state: "recovered"; plan: RepairPlan; receipt: ExecutionReceipt; probe: AccessProbe };

export interface WhyCard {
  runId: string;
  tenantId: string;
  billingAccountId: string;
  observedAt: string;
  conclusion: string;
  runStatus: InvestigationRun["status"];
  /** Investigator statusClaim — model assessment, not the gate. */
  modelStatusClaim?: CaseStatus | "unknown";
  /** Deterministic gate eligibility from check_conditions (when present). */
  eligibility?: InvestigationRun["eligibility"];
  /** True when both sides are present and disagree. */
  assessmentsDisagree: boolean;
  /** True when model uncertainty / missing evidence / disagreement blocks write. */
  furtherInvestigationRequired: boolean;
  /** True only when model + run status authorize acting on a plan. */
  writeAuthorized: boolean;
  /** Model-authored links always remain inference in this slice. */
  inferenceCausalLinks: CausalLink[];
  /** Deterministic gate conditions with their own source refs (not inherited by prose links). */
  sourceBackedChecks: SourceBackedCheck[];
  passedSourceBackedChecks: SourceBackedCheck[];
  hypotheses: Hypothesis[];
  excludedHypotheses: Hypothesis[];
  missingEvidence: string[];
  evidenceRefs: SourceRef[];
  coverage: InvestigationRun["coverage"];
  model: ModelMeta;
  proposedRoles: InvestigationRun["proposedRoles"];
  identityBound: false;
  repair: RepairLifecycle;
  /** True only with receipt outcome applied|replayed AND probe status 200. */
  customerRecovered: boolean;
  checkerFeedback: string[];
  followUpActions: string[];
}

function repairLifecycle(run: InvestigationRun): RepairLifecycle {
  if (!run.repairPlan) return { state: "none" };
  if (!run.receipt) return { state: "planned_not_executed", plan: run.repairPlan };
  const applied = run.receipt.outcome === "applied" || run.receipt.outcome === "replayed";
  if (applied && run.accessProbe && run.accessProbe.status === 200) {
    return { state: "recovered", plan: run.repairPlan, receipt: run.receipt, probe: run.accessProbe };
  }
  return { state: "executed", plan: run.repairPlan, receipt: run.receipt, probe: run.accessProbe };
}

export function buildWhyCard(run: InvestigationRun): WhyCard {
  const links = run.finding?.causalLinks ?? [];
  const hyps = run.finding?.hypotheses ?? [];
  const repair = repairLifecycle(run);
  const customerRecovered = repair.state === "recovered";
  const sourceBackedChecks = extractSourceBackedChecks(run.lastCheck);
  const modelStatusClaim = run.finding?.statusClaim;
  const eligibility = run.eligibility;
  const modelOk = findingAllowsRepairPlan(run.finding);
  const assessmentsDisagree =
    modelStatusClaim !== undefined &&
    eligibility !== undefined &&
    modelStatusClaim !== eligibility;
  const furtherInvestigationRequired =
    !modelOk.ok || assessmentsDisagree || (run.finding?.missingEvidence.length ?? 0) > 0;
  const writeAuthorized = modelOk.ok && run.status === "completed" && !!run.repairPlan && !assessmentsDisagree;

  return {
    runId: run.runId,
    tenantId: run.tenantId,
    billingAccountId: run.billingAccountId,
    observedAt: run.observedAt,
    conclusion:
      run.finding?.conclusion ??
      (run.status === "unavailable" ? "Investigation unavailable (no LLM key)." : "No finding proposed."),
    runStatus: run.status,
    modelStatusClaim,
    eligibility,
    assessmentsDisagree,
    furtherInvestigationRequired,
    writeAuthorized,
    inferenceCausalLinks: links.map((l) => ({ ...l, supported: false })),
    sourceBackedChecks,
    passedSourceBackedChecks: sourceBackedChecks.filter((c) => c.passed),
    hypotheses: hyps.filter((h) => h.status !== "excluded"),
    excludedHypotheses: hyps.filter((h) => h.status === "excluded"),
    missingEvidence: run.finding?.missingEvidence ?? [],
    evidenceRefs: run.finding?.evidenceRefs ?? [],
    coverage: run.coverage,
    model: run.model,
    proposedRoles: run.proposedRoles,
    identityBound: false,
    repair,
    customerRecovered,
    checkerFeedback: run.checkerFeedback ?? [],
    followUpActions: run.followUpActions,
  };
}
