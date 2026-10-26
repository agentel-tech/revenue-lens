// Strict JSON decision parsing for investigator and checker turns.
// Runtime finding schema uses evidenceIds (e1, e2, …). Legacy SourceRef parse
// is retained for unit tests only — not used by the workflow path.
// Never treat a model-supplied responseId as provider metadata.

import {
  ALLOWED_TOOLS,
  type AllowedToolName,
  type CheckerDecision,
  type FindingProposal,
  type InvestigatorDecision,
  type ModelRepairSelection,
} from "./types.ts";
import type { CaseStatus, SourceRef } from "../contracts.ts";
import type { EvidenceRegistry } from "./evidence-registry.ts";
import { isEvidenceIdShape } from "./evidence-registry.ts";
import { resolveRepairSuggestion } from "./evidence.ts";

const CASE_STATUSES: CaseStatus[] = [
  "consistent",
  "processing",
  "repair_candidate",
  "needs_verification",
  "not_entitled",
];

function hypothesisScope(h: Record<string, unknown>): {conditionId?: string; paymentLineId?: string; conditionExpectedPassed?: boolean} {
  if (h.conditionId == null) return h.paymentLineId == null ? {} : {paymentLineId: asString(h.paymentLineId, "hypothesis.paymentLineId")};
  return {conditionId: asString(h.conditionId, "hypothesis.conditionId"), paymentLineId: asString(h.paymentLineId, "hypothesis.paymentLineId"), conditionExpectedPassed: h.conditionExpectedPassed === undefined ? true : asBoolean(h.conditionExpectedPassed, "hypothesis.conditionExpectedPassed")};
}

const HYPOTHESIS_STATUSES = ["active", "supported", "excluded"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`missing string ${field}`);
  return v.trim();
}

/** Strict boolean: only JSON true/false. String "false" / 0 / 1 are rejected. */
export function asBoolean(v: unknown, field: string): boolean {
  if (v === true) return true;
  if (v === false) return false;
  throw new Error(`invalid boolean ${field}: expected true|false, got ${JSON.stringify(v)}`);
}

/** Positive safe integer (1..Number.MAX_SAFE_INTEGER). Rejects floats, strings, 0, negatives. */
export function asPositiveSafeInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) {
    throw new Error(`invalid positive safe integer ${field}: ${JSON.stringify(v)}`);
  }
  return v;
}

/** Non-negative safe integer for optional SourceRef.version (versions may be 0 in some schemas; we allow >= 0). */
export function asNonNegativeSafeInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new Error(`invalid non-negative safe integer ${field}: ${JSON.stringify(v)}`);
  }
  return v;
}

/** Legacy SourceRef parser (tests / offline). Runtime model path must not emit these. */
export function parseSourceRef(v: unknown): SourceRef {
  if (!isObject(v)) throw new Error("source ref must be object");
  const source = asString(v.source, "ref.source");
  if (source !== "billing" && source !== "workspace_map" && source !== "entitlements") {
    throw new Error(`invalid source enum ${source}`);
  }
  const table = asString(v.table, "ref.table");
  if (!isObject(v.key)) throw new Error("ref.key must be object");
  const key: Record<string, string> = {};
  for (const [k, val] of Object.entries(v.key)) {
    if (typeof val !== "string" || !val.trim()) throw new Error(`ref.key.${k} must be non-empty string`);
    key[k] = val;
  }
  if (Object.keys(key).length === 0) throw new Error("ref.key must be non-empty");
  const via = v.via;
  if (via !== "direct" && via !== "zetaris") throw new Error(`invalid via enum ${JSON.stringify(via)}`);
  const out: SourceRef = { source, table, key, via };
  if (v.version !== undefined) {
    out.version = asNonNegativeSafeInt(v.version, "ref.version");
  }
  return out;
}

function parseEvidenceIdList(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array of evidence ids`);
  return raw.map((id, i) => {
    if (isObject(id)) {
      throw new Error(`${label}[${i}]: raw SourceRef objects are rejected; use evidenceId strings (e1, e2, …)`);
    }
    if (!isEvidenceIdShape(id)) {
      throw new Error(`${label}[${i}]: invalid evidence id ${JSON.stringify(id)}`);
    }
    return id;
  });
}

function parseStatusClaim(statusRaw: unknown): FindingProposal["statusClaim"] {
  if (statusRaw === undefined || statusRaw === null) throw new Error("missing statusClaim");
  const statusClaimStr = asString(statusRaw, "finding.statusClaim");
  if (statusClaimStr === "unknown") return "unknown";
  if (CASE_STATUSES.includes(statusClaimStr as CaseStatus)) return statusClaimStr as CaseStatus;
  throw new Error(`invalid statusClaim enum ${statusClaimStr}`);
}

/** Legacy repair fields (unit tests / offline). Runtime model path must not emit these. */
function parseRepairSuggestionLegacy(v: Record<string, unknown>): FindingProposal["repairSuggestion"] {
  const rs = v.repairSuggestion ?? v.repair_suggestion;
  if (rs === undefined || rs === null) return undefined;
  if (!isObject(rs)) throw new Error("repairSuggestion must be object");
  return {
    paymentLineId: asString(rs.paymentLineId ?? rs.payment_line_id, "paymentLineId"),
    entitlementId: asString(rs.entitlementId ?? rs.entitlement_id, "entitlementId"),
    feature: asString(rs.feature, "feature"),
    fromWorkspace: asString(rs.fromWorkspace ?? rs.from_workspace, "fromWorkspace"),
    toWorkspace: asString(rs.toWorkspace ?? rs.to_workspace, "toWorkspace"),
    expectedVersion: asPositiveSafeInt(rs.expectedVersion ?? rs.expected_version, "expectedVersion"),
    mappingVersion: asPositiveSafeInt(rs.mappingVersion ?? rs.mapping_version, "mappingVersion"),
  };
}

const MODEL_REPAIR_ONLY_KEYS = new Set([
  "paymentEvidenceId",
  "payment_evidence_id",
  "entitlementEvidenceId",
  "entitlement_evidence_id",
  "currentMappingEvidenceId",
  "current_mapping_evidence_id",
]);

/** Model-facing selection: evidence IDs only. Versions/workspaces are derived from records. */
export function parseModelRepairSelection(rs: Record<string, unknown>): ModelRepairSelection {
  for (const key of Object.keys(rs)) {
    if (!MODEL_REPAIR_ONLY_KEYS.has(key)) {
      throw new Error(
        `repairSuggestion.${key} is not accepted; select only paymentEvidenceId, entitlementEvidenceId, currentMappingEvidenceId`,
      );
    }
  }
  const paymentEvidenceId = asString(rs.paymentEvidenceId ?? rs.payment_evidence_id, "paymentEvidenceId");
  const entitlementEvidenceId = asString(
    rs.entitlementEvidenceId ?? rs.entitlement_evidence_id,
    "entitlementEvidenceId",
  );
  const currentMappingEvidenceId = asString(
    rs.currentMappingEvidenceId ?? rs.current_mapping_evidence_id,
    "currentMappingEvidenceId",
  );
  if (!isEvidenceIdShape(paymentEvidenceId)) {
    throw new Error(`invalid paymentEvidenceId ${JSON.stringify(paymentEvidenceId)}`);
  }
  if (!isEvidenceIdShape(entitlementEvidenceId)) {
    throw new Error(`invalid entitlementEvidenceId ${JSON.stringify(entitlementEvidenceId)}`);
  }
  if (!isEvidenceIdShape(currentMappingEvidenceId)) {
    throw new Error(`invalid currentMappingEvidenceId ${JSON.stringify(currentMappingEvidenceId)}`);
  }
  return { paymentEvidenceId, entitlementEvidenceId, currentMappingEvidenceId };
}

function parseAndResolveRepairSuggestion(
  v: Record<string, unknown>,
  registry: EvidenceRegistry,
  scope: { tenantId: string; billingAccountId: string },
): FindingProposal["repairSuggestion"] {
  const rs = v.repairSuggestion ?? v.repair_suggestion;
  if (rs === undefined || rs === null) return undefined;
  if (!isObject(rs)) throw new Error("repairSuggestion must be object");
  const selection = parseModelRepairSelection(rs);
  return resolveRepairSuggestion(selection, registry, scope);
}

/** Legacy finding parser using embedded SourceRefs (unit tests only). */
export function parseFindingLegacy(v: unknown): FindingProposal {
  if (!isObject(v)) throw new Error("finding must be object");
  const conclusion = asString(v.conclusion, "finding.conclusion");
  const statusClaim = parseStatusClaim(v.statusClaim ?? v.status_claim);
  const evidenceRaw = v.evidenceRefs ?? v.evidence_refs;
  if (!Array.isArray(evidenceRaw)) throw new Error("evidenceRefs must be an array");
  const evidenceRefs = evidenceRaw.map(parseSourceRef);

  const causalRaw = v.causalLinks ?? v.causal_links;
  if (causalRaw !== undefined && !Array.isArray(causalRaw)) throw new Error("causalLinks must be an array");
  const causalLinks = (Array.isArray(causalRaw) ? causalRaw : []).map((c) => {
    if (!isObject(c)) throw new Error("causalLink must be object");
    const refsRaw = c.refs;
    if (!Array.isArray(refsRaw)) throw new Error("causalLink.refs must be an array");
    return {
      cause: asString(c.cause, "cause"),
      effect: asString(c.effect, "effect"),
      refs: refsRaw.map(parseSourceRef),
      modelClaimedSupported: asBoolean(c.supported, "causalLink.supported"),
      supported: false,
    };
  });

  const hypRaw = v.hypotheses;
  if (hypRaw !== undefined && !Array.isArray(hypRaw)) throw new Error("hypotheses must be an array");
  const hypotheses = (Array.isArray(hypRaw) ? hypRaw : []).map((h) => {
    if (!isObject(h)) throw new Error("hypothesis must be object");
    const status = asString(h.status, "hypothesis.status");
    if (!(HYPOTHESIS_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`invalid hypothesis.status enum ${status}`);
    }
    const refsRaw = h.refs;
    if (!Array.isArray(refsRaw)) throw new Error("hypothesis.refs must be an array");
    const exclusionReason =
      h.exclusionReason !== undefined
        ? asString(h.exclusionReason, "exclusionReason")
        : h.exclusion_reason !== undefined
          ? asString(h.exclusion_reason, "exclusion_reason")
          : undefined;
    if (status === "excluded" && !exclusionReason) {
      throw new Error("excluded hypothesis requires exclusionReason");
    }
    return {
      id: asString(h.id, "hypothesis.id"),
      claim: asString(h.claim, "hypothesis.claim"),
      ...hypothesisScope(h),
      status: status as (typeof HYPOTHESIS_STATUSES)[number],
      exclusionReason,
      refs: refsRaw.map(parseSourceRef),
    };
  });

  const missRaw = v.missingEvidence ?? v.missing_evidence;
  if (missRaw !== undefined && !Array.isArray(missRaw)) throw new Error("missingEvidence must be an array");
  const missingEvidence = (Array.isArray(missRaw) ? missRaw : []).map((x, i) => asString(x, `missingEvidence[${i}]`));

  return {
    conclusion,
    statusClaim,
    causalLinks,
    hypotheses,
    missingEvidence,
    evidenceRefs,
    repairSuggestion: parseRepairSuggestionLegacy(v),
  };
}

/**
 * Runtime finding: evidenceIds only. Resolves against the run registry to exact SourceRefs.
 * Rejects raw SourceRef objects / foreign IDs. Does not fabricate evidence.
 * repairSuggestion (when present) selects payment/entitlement/mapping evidence IDs only;
 * plan fields are derived from those trusted records.
 */
export function parseAndResolveFinding(
  v: unknown,
  registry: EvidenceRegistry,
  scope: { tenantId: string; billingAccountId: string },
): FindingProposal {
  if (!isObject(v)) throw new Error("finding must be object");
  if (v.evidenceRefs !== undefined || v.evidence_refs !== undefined) {
    throw new Error("evidenceRefs are not accepted; cite evidenceIds from this run");
  }
  const conclusion = asString(v.conclusion, "finding.conclusion");
  const statusClaim = parseStatusClaim(v.statusClaim ?? v.status_claim);

  const evidenceIds = parseEvidenceIdList(v.evidenceIds ?? v.evidence_ids, "evidenceIds");
  const evidenceRefs = registry.resolveAll(evidenceIds, "evidenceIds");

  const causalRaw = v.causalLinks ?? v.causal_links;
  if (causalRaw !== undefined && !Array.isArray(causalRaw)) throw new Error("causalLinks must be an array");
  const causalLinks = (Array.isArray(causalRaw) ? causalRaw : []).map((c, i) => {
    if (!isObject(c)) throw new Error("causalLink must be object");
    if (c.refs !== undefined) throw new Error(`causalLinks[${i}].refs rejected; use evidenceIds`);
    const ids = parseEvidenceIdList(c.evidenceIds ?? c.evidence_ids ?? [], `causalLinks[${i}].evidenceIds`);
    return {
      cause: asString(c.cause, "cause"),
      effect: asString(c.effect, "effect"),
      refs: registry.resolveAll(ids, `causalLinks[${i}].evidenceIds`),
      modelClaimedSupported: asBoolean(c.supported, "causalLink.supported"),
      supported: false,
    };
  });

  const hypRaw = v.hypotheses;
  if (hypRaw !== undefined && !Array.isArray(hypRaw)) throw new Error("hypotheses must be an array");
  const hypotheses = (Array.isArray(hypRaw) ? hypRaw : []).map((h, i) => {
    if (!isObject(h)) throw new Error("hypothesis must be object");
    if (h.refs !== undefined) throw new Error(`hypotheses[${i}].refs rejected; use evidenceIds`);
    const status = asString(h.status, "hypothesis.status");
    if (!(HYPOTHESIS_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`invalid hypothesis.status enum ${status}`);
    }
    const ids = parseEvidenceIdList(h.evidenceIds ?? h.evidence_ids ?? [], `hypotheses[${i}].evidenceIds`);
    const exclusionReason =
      h.exclusionReason !== undefined
        ? asString(h.exclusionReason, "exclusionReason")
        : h.exclusion_reason !== undefined
          ? asString(h.exclusion_reason, "exclusion_reason")
          : undefined;
    if (status === "excluded" && !exclusionReason) {
      throw new Error("excluded hypothesis requires exclusionReason");
    }
    return {
      id: asString(h.id, "hypothesis.id"),
      claim: asString(h.claim, "hypothesis.claim"),
      ...hypothesisScope(h),
      status: status as (typeof HYPOTHESIS_STATUSES)[number],
      exclusionReason,
      refs: registry.resolveAll(ids, `hypotheses[${i}].evidenceIds`),
    };
  });

  const missRaw = v.missingEvidence ?? v.missing_evidence;
  if (missRaw !== undefined && !Array.isArray(missRaw)) throw new Error("missingEvidence must be an array");
  const missingEvidence = (Array.isArray(missRaw) ? missRaw : []).map((x, i) => asString(x, `missingEvidence[${i}]`));

  return {
    conclusion,
    statusClaim,
    causalLinks,
    hypotheses,
    missingEvidence,
    evidenceRefs,
    repairSuggestion: parseAndResolveRepairSuggestion(v, registry, scope),
  };
}

/**
 * Strict JSON object parse. Entire reply (or a single full fence) must be one
 * JSON object. No first-brace / last-brace salvage of embedded JSON.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty model response");
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
    throw new Error("model response must be a single JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("model response is not valid JSON");
  }
  if (!isObject(parsed)) throw new Error("model JSON must be an object");
  return parsed;
}

/**
 * Parse investigator decision. Finding resolution requires the run evidence registry
 * and request tenant/account scope (for repair evidence validation).
 * Model-supplied responseId / callId fields are ignored.
 */
export function parseInvestigatorDecision(
  text: string,
  registry?: EvidenceRegistry,
  scope?: { tenantId: string; billingAccountId: string },
): InvestigatorDecision {
  const raw = extractJsonObject(text);
  if (!isObject(raw)) throw new Error("decision must be object");
  const kind = asString(raw.kind ?? raw.type, "kind");

  if (kind === "call_tool") {
    const tool = asString(raw.tool, "tool");
    if (!(ALLOWED_TOOLS as readonly string[]).includes(tool)) throw new Error(`tool not allowlisted: ${tool}`);
    const seeking = asString(raw.seeking, "seeking");
    return { kind: "call_tool", tool: tool as AllowedToolName, seeking };
  }
  if (kind === "propose_finding") {
    if (!registry) throw new Error("evidence registry required to resolve finding evidenceIds");
    if (!scope) throw new Error("tenant/account scope required to resolve finding");
    return { kind: "propose_finding", finding: parseAndResolveFinding(raw.finding, registry, scope) };
  }
  if (kind === "stop") {
    return { kind: "stop", reason: asString(raw.reason, "reason") };
  }
  throw new Error(`unsupported investigator kind ${kind}`);
}

export function parseCheckerDecision(text: string): CheckerDecision {
  const raw = extractJsonObject(text);
  if (!isObject(raw)) throw new Error("checker decision must be object");
  const kind = asString(raw.kind ?? raw.type, "kind");

  if (kind === "accept") {
    return { kind: "accept", note: asString(raw.note ?? raw.feedback, "note") };
  }
  if (kind === "need_evidence") {
    let suggestedTool: AllowedToolName | undefined;
    const st = raw.suggestedTool ?? raw.suggested_tool;
    if (st !== undefined && st !== null) {
      const tool = asString(st, "suggestedTool");
      if (!(ALLOWED_TOOLS as readonly string[]).includes(tool)) {
        throw new Error(`suggestedTool not allowlisted: ${tool}`);
      }
      suggestedTool = tool as AllowedToolName;
    }
    return {
      kind: "need_evidence",
      feedback: asString(raw.feedback ?? raw.note, "feedback"),
      suggestedTool,
    };
  }
  if (kind === "reject") {
    return { kind: "reject", feedback: asString(raw.feedback ?? raw.note, "feedback") };
  }
  throw new Error(`unsupported checker kind ${kind}`);
}
