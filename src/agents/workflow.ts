// Bounded investigator → checker workflow.
// Plain chat + validated JSON decisions. Injectable model and tool runner.
// Repair plans require fresh scoped context + gate; causal support is never model-only.

import { randomBytes } from "node:crypto";
import { explanationIssues } from "./consistency.ts";
import type { CaseStatus, CheckResult, RepairPlan } from "../contracts.ts";
import { makeRetargetPlan } from "../repair/plan.ts";
import { parseCheckerDecision, parseInvestigatorDecision } from "./decisions.ts";
import {
  checkerFactsPayload,
  contextMatchesScope,
  emptyGathered,
  factsComplete,
  ingestToolFact,
  materializeFinding,
  toModelFacingFact,
} from "./evidence.ts";
import { createLockedToolRunner } from "./locked-tools.ts";
import {
  checkerSystemPrompt,
  checkerUserPrompt,
  investigatorAfterChecker,
  investigatorAfterTool,
  investigatorSystemPrompt,
  investigatorUserKickoff,
  schemaCorrectionMessage,
} from "./prompts.ts";
import { assertSafeFinishReason, createDefaultModelCaller } from "./provider.ts";
import type {
  ChatTurn,
  FindingProposal,
  InvestigationRequest,
  InvestigationRun,
  InvestigationStopReason,
  ModelCaller,
  ModelMeta,
  ModelResponse,
  ToolRunner,
  ToolTraceEntry,
} from "./types.ts";
import { PROPOSED_ROLES } from "./types.ts";

const MAX_INVESTIGATOR = 8;
const MAX_CHECKER = 4;
/** One schema-correction retry per role per investigation (counts against the call budget). */
const MAX_SCHEMA_CORRECTIONS = 1;

function evidenceCatalogForCorrection(gathered: { evidence: { catalog: () => unknown[] } }): string {
  const catalog = gathered.evidence.catalog();
  return JSON.stringify(catalog.length ? catalog : [], null, 2);
}

function findingForModelView(
  finding: FindingProposal,
  registry: { idFor: (r: import("../contracts.ts").SourceRef) => string | undefined },
): object {
  const ids = (refs: import("../contracts.ts").SourceRef[]) =>
    refs.map((r) => {
      const id = registry.idFor(r);
      if (!id) throw new Error("finding ref missing evidence id");
      return id;
    });
  const sug = finding.repairSuggestion;
  const repairSuggestion =
    sug?.paymentEvidenceId && sug?.entitlementEvidenceId && sug?.currentMappingEvidenceId
      ? {
          paymentEvidenceId: sug.paymentEvidenceId,
          entitlementEvidenceId: sug.entitlementEvidenceId,
          currentMappingEvidenceId: sug.currentMappingEvidenceId,
        }
      : undefined;
  return {
    conclusion: finding.conclusion,
    statusClaim: finding.statusClaim,
    missingEvidence: finding.missingEvidence,
    evidenceIds: ids(finding.evidenceRefs),
    causalLinks: finding.causalLinks.map((l) => ({
      cause: l.cause,
      effect: l.effect,
      supported: l.modelClaimedSupported,
      evidenceIds: ids(l.refs),
    })),
    hypotheses: finding.hypotheses.map((h) => ({
      id: h.id,
      claim: h.claim,
      status: h.status,
      exclusionReason: h.exclusionReason,
      conditionId: h.conditionId,
      conditionExpectedPassed: h.conditionExpectedPassed,
      paymentLineId: h.paymentLineId,
      evidenceIds: ids(h.refs),
    })),
    ...(repairSuggestion ? { repairSuggestion } : {}),
  };
}

function applyModelMeta(run: InvestigationRun, modelRes: ModelResponse): void {
  run.model = {
    model: modelRes.model,
    provider: modelRes.provider,
    baseUrl: modelRes.baseUrl,
    available: true,
  };
}

function rid(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function extractCheck(fact: unknown): CheckResult | undefined {
  if (!fact || typeof fact !== "object") return undefined;
  const check = (fact as { check?: CheckResult }).check;
  return check && Array.isArray(check.lines) ? check : undefined;
}

/**
 * Model assessment must explicitly claim repair_candidate with no missing evidence.
 * Never auto-upgrade needs_verification / unknown / etc. into write permission
 * just because the deterministic gate alone says repair_candidate.
 */
export function findingAllowsRepairPlan(finding: FindingProposal | undefined): { ok: true } | { ok: false; reason: string } {
  if (!finding) return { ok: false, reason: "finding missing; cannot authorize repair" };
  if (finding.statusClaim !== "repair_candidate") {
    return {
      ok: false,
      reason: `finding.statusClaim is ${finding.statusClaim}, not repair_candidate (model uncertainty is not write permission)`,
    };
  }
  if (finding.missingEvidence.length > 0) {
    return {
      ok: false,
      reason: `finding.missingEvidence is non-empty (${finding.missingEvidence.length}); further investigation required`,
    };
  }
  return { ok: true };
}

/**
 * Independent confirm-time gate for a stored run (even if a stale plan exists).
 * Does not execute — callers refuse before touching the executor.
 */
export function runAllowsConfirmRepair(run: InvestigationRun): { ok: true } | { ok: false; reason: string } {
  if (run.status !== "completed") {
    return { ok: false, reason: `run.status is ${run.status}, not completed` };
  }
  if (run.lastCheck && (run.lastCheck.tenantId !== run.tenantId || run.lastCheck.billingAccountId !== run.billingAccountId)) return {ok:false,reason:"check scope mismatch"};
  const issues = explanationIssues(run.finding, run.lastCheck, run.gathered?.freshContext);
  if (issues.length) return {ok:false,reason:issues.join("; ")};
  return findingAllowsRepairPlan(run.finding);
}

/**
 * Build a repair plan only when:
 * - finding.statusClaim is explicitly repair_candidate and missingEvidence is empty
 * - full fresh context is present and scoped to the request tenant/account
 * - gate says repair_candidate for the suggested line/feature
 * - coverage is complete
 * - finding evidence refs were already validated against observed facts
 * - suggestion fields match context facts exactly
 *
 * Context is required for authorization — never optional.
 * Deterministic gate alone never upgrades model uncertainty into a plan.
 */
export function tryBuildRepairPlan(opts: {
  tenantId: string;
  billingAccountId: string;
  finding: FindingProposal;
  check: CheckResult;
  coverage: import("../contracts.ts").ReadCoverage[];
  context: NonNullable<import("./types.ts").GatheredFacts["freshContext"]>;
}): { plan?: RepairPlan; reason?: string } {
  const { finding, check, coverage, tenantId, billingAccountId, context } = opts;

  const modelOk = findingAllowsRepairPlan(finding);
  if (!modelOk.ok) return { reason: modelOk.reason };
  const issues = explanationIssues(finding, check, context);
  if (issues.length) return {reason: issues.join("; ")};

  if (!contextMatchesScope(context, tenantId, billingAccountId)) {
    return { reason: "fresh context missing or tenant/account scope mismatch" };
  }
  if (check.tenantId !== tenantId || check.billingAccountId !== billingAccountId) {
    return { reason: "check result tenant/account scope mismatch" };
  }
  if (!finding.repairSuggestion) return { reason: "no repair suggestion in finding" };
  if (!factsComplete(coverage)) return { reason: "incomplete or missing coverage; cannot plan repair" };
  if (!finding.evidenceRefs.length) return { reason: "finding lacks evidenceRefs" };

  const sug = finding.repairSuggestion;
  const line = check.lines.find((l) => l.paymentLineId === sug.paymentLineId && l.feature === sug.feature);
  if (!line) return { reason: "suggested payment/feature not present in check result" };
  if (line.status !== "repair_candidate") {
    return { reason: `gate status is ${line.status}, not repair_candidate` };
  }
  if (line.missing.length) return { reason: `gate still missing: ${line.missing.join("; ")}` };

  const ent = context.entitlements.find((e) => e.entitlementId === sug.entitlementId);
  if (!ent) return { reason: "entitlement id not in fresh context" };
  if (ent.tenantId !== tenantId) return { reason: "entitlement tenant mismatch" };
  if (ent.paymentLineId !== sug.paymentLineId) return { reason: "entitlement/payment mismatch" };
  if (ent.feature !== sug.feature) return { reason: "feature mismatch" };
  if (ent.targetWorkspaceId !== sug.fromWorkspace) return { reason: "fromWorkspace does not match entitlement target" };
  if (ent.version !== sug.expectedVersion) return { reason: "expectedVersion does not match entitlement" };

  const at = new Date(context.observedAt).getTime();
  const current = context.mappings.filter((m) => {
    if (m.tenantId !== tenantId || m.billingAccountId !== billingAccountId) return false;
    const from = new Date(m.validFrom).getTime();
    const to = m.validTo == null ? Infinity : new Date(m.validTo).getTime();
    return from <= at && at < to;
  });
  if (current.length !== 1) return { reason: "current mapping not uniquely established in fresh context" };
  if (current[0].workspaceId !== sug.toWorkspace || current[0].mappingVersion !== sug.mappingVersion) {
    return { reason: "toWorkspace/mappingVersion do not match current mapping" };
  }

  // Note: repair_candidate does not assert a proven stale-mapping cause.
  // Plan construction is eligibility + identity match only.
  const plan = makeRetargetPlan({
    tenantId,
    billingAccountId,
    paymentLineId: sug.paymentLineId,
    entitlementId: sug.entitlementId,
    feature: sug.feature,
    fromWorkspace: sug.fromWorkspace,
    toWorkspace: sug.toWorkspace,
    expectedVersion: sug.expectedVersion,
    mappingVersion: sug.mappingVersion,
    evidenceRefs: finding.evidenceRefs,
    proposedBy: "investigator",
  });
  return { plan };
}

export interface RunInvestigationOptions {
  model?: ModelCaller | null;
  tools?: ToolRunner;
}

export async function runInvestigation(
  request: InvestigationRequest,
  opts: RunInvestigationOptions = {},
): Promise<InvestigationRun> {
  const observedAtDate = request.observedAt
    ? request.observedAt instanceof Date
      ? request.observedAt
      : new Date(request.observedAt)
    : new Date();
  const observedAt = observedAtDate.toISOString();
  const createdAt = nowIso();
  const runId = rid("run");

  const modelFn = opts.model === undefined ? createDefaultModelCaller() : opts.model;
  const tools = opts.tools ?? createLockedToolRunner(request.tenantId, request.billingAccountId);

  const modelMeta: ModelMeta = modelFn
    ? { model: "pending", provider: "openai-compatible", available: true }
    : { model: "none", provider: "openai-compatible", available: false };

  const gathered = emptyGathered();

  const run: InvestigationRun = {
    runId,
    tenantId: request.tenantId,
    billingAccountId: request.billingAccountId,
    observedAt,
    status: "unavailable",
    model: modelMeta,
    proposedRoles: PROPOSED_ROLES,
    identityBound: false,
    trace: [],
    coverage: gathered.coverage,
    gathered,
    checkerFeedback: [],
    followUpActions: [],
    repairConfirmed: false,
    memoryEnabled: request.memoryEnabled === true,
    recalledLessonIds: request.recalledLessonIds ?? [],
    suggestedPriority: request.suggestedPriority,
    createdAt,
    updatedAt: createdAt,
  };

  if (!modelFn) {
    run.status = "unavailable";
    run.trace.push({
      step: 0,
      role: "system",
      action: "model",
      callId: rid("call"),
      providerResponseId: null,
      decision: { kind: "unavailable", detail: "LLM_API_KEY not configured; investigation not run" },
      at: nowIso(),
    });
    run.updatedAt = nowIso();
    return run;
  }

  const push = (entry: Omit<ToolTraceEntry, "step" | "at"> & { at?: string }) => {
    run.trace.push({ ...entry, step: run.trace.length + 1, at: entry.at ?? nowIso() });
  };

  const invMessages: ChatTurn[] = [
    {
      role: "system",
      content: investigatorSystemPrompt({
        tenantId: request.tenantId,
        billingAccountId: request.billingAccountId,
        observedAt,
        suggestedPriority: request.suggestedPriority,
      }),
    },
    { role: "user", content: investigatorUserKickoff() },
  ];

  let investigatorCalls = 0;
  let checkerCalls = 0;
  let investigatorSchemaCorrections = 0;
  let checkerSchemaCorrections = 0;
  let pendingCheckerFeedback: string | undefined;
  let stop: InvestigationStopReason = "investigator_budget";

  try {
    while (investigatorCalls < MAX_INVESTIGATOR) {
      investigatorCalls++;
      const callId = rid("call");
      const modelRes = await modelFn(invMessages, { role: "investigator", callIndex: investigatorCalls });
      const providerResponseId = modelRes.providerResponseId ?? null;
      applyModelMeta(run, modelRes);
      invMessages.push({ role: "assistant", content: modelRes.text });

      try {
        assertSafeFinishReason(modelRes.finishReason);
      } catch (e) {
        push({
          role: "investigator",
          action: "model",
          callId,
          providerResponseId,
          decision: { kind: "invalid", detail: (e as Error).message },
        });
        stop = "invalid_model_response";
        break;
      }

      let decision;
      try {
        decision = parseInvestigatorDecision(modelRes.text, gathered.evidence, {
          tenantId: request.tenantId,
          billingAccountId: request.billingAccountId,
        });
      } catch (e) {
        const detail = (e as Error).message;
        push({
          role: "investigator",
          action: "model",
          callId,
          providerResponseId,
          decision: { kind: "invalid", detail },
        });
        // One schema-correction retry for the whole run; no tools / no side effects on this attempt.
        if (
          investigatorSchemaCorrections < MAX_SCHEMA_CORRECTIONS &&
          investigatorCalls < MAX_INVESTIGATOR
        ) {
          investigatorSchemaCorrections++;
          invMessages.push({
            role: "user",
            content: schemaCorrectionMessage({
              role: "investigator",
              error: detail,
              observedRefsJson: evidenceCatalogForCorrection(gathered),
            }),
          });
          run.followUpActions.push(`schema_correction:investigator:${detail.slice(0, 160)}`);
          continue;
        }
        stop = "invalid_model_response";
        break;
      }

      push({
        role: "investigator",
        action: "model",
        callId,
        providerResponseId,
        decision,
        seeking: decision.kind === "call_tool" ? decision.seeking : undefined,
      });

      if (decision.kind === "stop") {
        stop = "insufficient_evidence";
        break;
      }

      if (decision.kind === "call_tool") {
        const fact = await tools(
          decision.tool,
          { tenant_id: request.tenantId, billing_account_id: request.billingAccountId },
          observedAtDate,
        );
        ingestToolFact(gathered, fact, request.tenantId, request.billingAccountId);
        run.coverage = gathered.coverage;
        if (gathered.lastCheck) {
          run.lastCheck = gathered.lastCheck;
          if (gathered.lastCheck.lines[0]) run.eligibility = gathered.lastCheck.lines[0].status as CaseStatus;
        }

        push({
          role: "investigator",
          action: "tool",
          tool: decision.tool,
          seeking: decision.seeking,
          callId,
          providerResponseId: null,
          fact,
        });

        if (pendingCheckerFeedback) {
          run.followUpActions.push(`tool:${decision.tool} after checker: ${pendingCheckerFeedback.slice(0, 120)}`);
          pendingCheckerFeedback = undefined;
        }

        invMessages.push({
          role: "user",
          content: investigatorAfterTool(decision.tool, decision.seeking, toModelFacingFact(fact, gathered)),
        });
        continue;
      }

      // propose_finding — IDs already resolved; materialize keeps inference labels / observed checks.
      let finding: FindingProposal;
      try {
        finding = materializeFinding(decision.finding, gathered.observedRefs, gathered.lastCheck);
      } catch (e) {
        push({
          role: "investigator",
          action: "model",
          callId,
          providerResponseId,
          decision: { kind: "unsupported_refs", detail: (e as Error).message },
        });
        stop = "unsupported_decision";
        break;
      }
      run.finding = finding;
      // Catch contradictions against already-read checks before spending a checker turn.
      const earlyIssues = explanationIssues(finding, gathered.lastCheck, gathered.freshContext);
      if (earlyIssues.length) {
        const feedback = `Source-condition inconsistency: ${earlyIssues.join("; ")}. Add the exact conditionId/paymentLineId fields to the relevant hypothesis, reconcile status and cite its source evidence. If unresolved report needs_verification.`;
        run.checkerFeedback = [...(run.checkerFeedback ?? []), feedback];
        run.followUpActions.push("explanation_consistency_correction");
        push({role:"system",action:"feedback",decision:{kind:"explanation_inconsistent",detail:feedback}});
        invMessages.push({role:"user",content:investigatorAfterChecker(feedback)});
        stop = "unsupported_decision";
        continue;
      }

      if (checkerCalls >= MAX_CHECKER) {
        stop = "checker_budget";
        break;
      }

      const factsForChecker = checkerFactsPayload(gathered, {
        tenantId: request.tenantId,
        billingAccountId: request.billingAccountId,
        observedAt,
      });
      const checkerMessages: ChatTurn[] = [
        { role: "system", content: checkerSystemPrompt() },
        { role: "user", content: checkerUserPrompt(findingForModelView(finding, gathered.evidence), factsForChecker) },
      ];

      let checkerDec;
      let checkerCallId = "";
      let checkerProviderId: string | null = null;
      let checkerAccepted = false;

      while (checkerCalls < MAX_CHECKER) {
        checkerCalls++;
        checkerCallId = rid("call");
        const checkerRes = await modelFn(checkerMessages, { role: "checker", callIndex: checkerCalls });
        checkerProviderId = checkerRes.providerResponseId ?? null;
        applyModelMeta(run, checkerRes);
        checkerMessages.push({ role: "assistant", content: checkerRes.text });

        try {
          assertSafeFinishReason(checkerRes.finishReason);
        } catch (e) {
          push({
            role: "checker",
            action: "model",
            callId: checkerCallId,
            providerResponseId: checkerProviderId,
            decision: { kind: "invalid", detail: (e as Error).message },
          });
          stop = "invalid_model_response";
          checkerDec = undefined;
          break;
        }

        try {
          checkerDec = parseCheckerDecision(checkerRes.text);
        } catch (e) {
          const detail = (e as Error).message;
          push({
            role: "checker",
            action: "model",
            callId: checkerCallId,
            providerResponseId: checkerProviderId,
            decision: { kind: "invalid", detail },
          });
          if (checkerSchemaCorrections < MAX_SCHEMA_CORRECTIONS && checkerCalls < MAX_CHECKER) {
            checkerSchemaCorrections++;
            checkerMessages.push({
              role: "user",
              content: schemaCorrectionMessage({
                role: "checker",
                error: detail,
                observedRefsJson: evidenceCatalogForCorrection(gathered),
              }),
            });
            run.followUpActions.push(`schema_correction:checker:${detail.slice(0, 160)}`);
            continue;
          }
          stop = "invalid_model_response";
          checkerDec = undefined;
          break;
        }

        push({
          role: "checker",
          action: "model",
          callId: checkerCallId,
          providerResponseId: checkerProviderId,
          decision: checkerDec,
        });
        checkerAccepted = true;
        break;
      }

      if (!checkerAccepted || !checkerDec) {
        if (stop === "investigator_budget") stop = "invalid_model_response";
        break;
      }

      if (checkerDec.kind === "need_evidence" || checkerDec.kind === "reject") {
        const feedback = checkerDec.feedback;
        run.checkerFeedback = [...(run.checkerFeedback ?? []), feedback];
        pendingCheckerFeedback = feedback;
        push({
          role: "checker",
          action: "feedback",
          callId: checkerCallId,
          providerResponseId: checkerProviderId,
          decision: checkerDec,
        });
        invMessages.push({
          role: "user",
          content: investigatorAfterChecker(
            feedback,
            checkerDec.kind === "need_evidence" ? checkerDec.suggestedTool : undefined,
          ),
        });
        continue;
      }

      push({
        role: "checker",
        action: "feedback",
        callId: checkerCallId,
        providerResponseId: checkerProviderId,
        decision: checkerDec,
      });

      // Authorization: always obtain a full fresh context via check_conditions
      // before constructing any repair plan. Context is required, not optional.
      const gateFact = await tools(
        "check_conditions",
        { tenant_id: request.tenantId, billing_account_id: request.billingAccountId },
        observedAtDate,
      );
      ingestToolFact(gathered, gateFact, request.tenantId, request.billingAccountId);
      run.coverage = gathered.coverage;
      run.lastCheck = gathered.lastCheck ?? extractCheck(gateFact);
      if (run.lastCheck?.lines[0]) run.eligibility = run.lastCheck.lines[0].status;
      push({ role: "system", action: "gate", tool: "check_conditions", callId: rid("call"), providerResponseId: null, fact: gateFact });

      // Re-materialize causal support against the fresh check (still never model-only).
      try {
        run.finding = materializeFinding(finding, gathered.observedRefs, run.lastCheck);
      } catch (e) {
        push({
          role: "system",
          action: "plan",
          decision: { kind: "unsupported_refs", detail: (e as Error).message },
        });
        stop = "unsupported_decision";
        break;
      }

      if (!run.lastCheck || !contextMatchesScope(gathered.freshContext, request.tenantId, request.billingAccountId)) {
        push({
          role: "system",
          action: "plan",
          decision: {
            kind: "no_repair_plan",
            detail: "full fresh scoped context required before any repair plan",
          },
        });
        stop = "completed";
        break;
      }

      const issues = explanationIssues(run.finding, run.lastCheck, gathered.freshContext);
      if (issues.length) {
        const feedback = `Source-condition inconsistency: ${issues.join("; ")}. Read exact dates/records; correct the typed proposition or report needs_verification. Do not silently relabel unsupported prose.`;
        run.checkerFeedback = [...(run.checkerFeedback ?? []), feedback];
        run.followUpActions.push("explanation_consistency_correction");
        push({role:"system",action:"feedback",decision:{kind:"explanation_inconsistent",detail:feedback}});
        invMessages.push({role:"user",content:investigatorAfterChecker(feedback)});
        stop = "unsupported_decision";
        continue; // existing investigator/checker budgets bound correction
      }

      const built = tryBuildRepairPlan({
        tenantId: request.tenantId,
        billingAccountId: request.billingAccountId,
        finding: run.finding,
        check: run.lastCheck,
        coverage: gathered.coverage,
        context: gathered.freshContext,
      });

      if (built.plan) {
        run.repairPlan = built.plan;
        push({
          role: "system",
          action: "plan",
          decision: { kind: "repair_plan", detail: built.plan.intentKey },
        });
      } else {
        push({
          role: "system",
          action: "plan",
          decision: { kind: "no_repair_plan", detail: built.reason ?? "not eligible" },
        });
      }

      stop = "completed";
      break;
    }
  } catch (e) {
    push({
      role: "system",
      action: "model",
      callId: rid("call"),
      providerResponseId: null,
      decision: { kind: "error", detail: (e as Error).message },
    });
    stop = "invalid_model_response";
  }

  if (investigatorCalls >= MAX_INVESTIGATOR && stop === "investigator_budget") {
    stop = "investigator_budget";
  }

  run.status = stop;
  run.gathered = gathered;
  run.coverage = gathered.coverage;
  run.updatedAt = nowIso();
  return run;
}

/** Attach execution receipt and optional access probe to a run (demo / confirm path). */
export function attachRepairOutcome(
  run: InvestigationRun,
  receipt: InvestigationRun["receipt"],
  probe?: InvestigationRun["accessProbe"],
): InvestigationRun {
  return {
    ...run,
    repairConfirmed: true,
    receipt,
    accessProbe: probe,
    updatedAt: nowIso(),
    followUpActions: [
      ...run.followUpActions,
      receipt ? `executeRetarget:${receipt.outcome}` : "executeRetarget:none",
      probe ? `accessProbe:${probe.status}` : "accessProbe:none",
    ],
  };
}
