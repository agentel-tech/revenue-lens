// H-MEM adapter: persist supported run lessons locally with explicit
// source run + applicability. Recall influences suggested investigation
// priority only — never current eligibility or write permission.
//
// Tenant filter is mandatory before returning any memory content.
// Does not store credentials, tokens, or full customer payloads.
// Embedding: deterministic H-MEM reference — not NVIDIA hosted embedding.

import path from "node:path";
import { explanationIssues } from "../agents/consistency.ts";
import { fileURLToPath } from "node:url";
import { loadHMEM } from "../engine.ts";
import type { InvestigationRun } from "../agents/types.ts";
import { ALLOWED_TOOLS } from "../agents/types.ts";
import { extractSourceBackedChecks, factsComplete } from "../agents/evidence.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MEMORY_DIR = path.join(here, "..", "..", ".revenue-lens-memory");

/** Disclose embedding path honestly — reference H-MEM, not NVIDIA. */
export const MEMORY_EMBEDDING_DISCLOSURE =
  "deterministic H-MEM reference embedding (vendor/reference); not NVIDIA hosted embedding";

const ALLOWED_TOOL_SET = new Set<string>(ALLOWED_TOOLS);

export interface RunLesson {
  sourceRunId: string;
  tenantId: string;
  /** Applicability label from gate eligibility — not a seed kind. */
  applicability: string;
  /**
   * Concise evidence-derived diagnostic hint (passed condition IDs).
   * Marked as hint, not current fact — never free model conclusion prose.
   */
  hint: string;
  /** Passed source-backed condition IDs included in the hint. */
  conditionIds: string[];
  suggestedPriority: string[];
  at: string;
}

export interface MemoryHit {
  id: string;
  content: string;
  relevance: number;
  sourceRunId?: string;
  tenantId?: string;
}

export interface MemoryAdapter {
  source: string;
  embeddingDisclosure: string;
  persistDir: string;
  rememberLesson(lesson: RunLesson): Promise<{ id: string }>;
  /**
   * Recall priority hints for one tenant only.
   * `tenantId` is required — cross-tenant content is never returned.
   * Suggested tools are allowlist-only.
   */
  recallPriority(
    query: string,
    opts: { tenantId: string; limit?: number },
  ): Promise<{ suggestedPriority: string[]; memories: MemoryHit[] }>;
}

function allowlistedPriority(steps: string[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    const t = step.trim();
    if (!t || !ALLOWED_TOOL_SET.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function clampPositiveLimit(limit: number | undefined, fallback = 5, max = 50): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(max, Math.floor(limit));
}

function lessonContent(l: RunLesson): string {
  return [
    "kind=hint_not_current_fact",
    "audit=source_condition_v1",
    `applicability=${l.applicability}`,
    `sourceRun=${l.sourceRunId}`,
    `tenant=${l.tenantId}`,
    `conditions=${l.conditionIds.join(",")}`,
    `priority=${l.suggestedPriority.join(">")}`,
    `hint=${l.hint}`,
  ].join(" | ");
}

function parseTenantFromContent(content: string): string | undefined {
  const m = /(?:^|\|\s*)tenant=([^|]+)/.exec(content);
  return m ? m[1].trim() : undefined;
}

function parseSourceRunFromContent(content: string): string | undefined {
  const m = /(?:^|\|\s*)sourceRun=([^|]+)/.exec(content);
  return m ? m[1].trim() : undefined;
}

function checkerAccepted(run: InvestigationRun): boolean {
  return run.trace.some(
    (t) =>
      t.role === "checker" &&
      t.decision &&
      typeof t.decision === "object" &&
      "kind" in t.decision &&
      (t.decision as { kind: string }).kind === "accept",
  );
}

function lastCheckScoped(run: InvestigationRun): boolean {
  const check = run.lastCheck;
  if (!check) return false;
  return check.tenantId === run.tenantId && check.billingAccountId === run.billingAccountId;
}

/** Any unresolved line.missing blocks learning (source evidence incomplete). */
function hasUnresolvedLineMissing(run: InvestigationRun): boolean {
  return !!run.lastCheck?.lines.some((l) => l.missing.length > 0);
}

/**
 * Derive a storeable lesson only from completed runs with an accepted finding,
 * nonempty complete coverage, scoped lastCheck, no unresolved missing items,
 * and finding.statusClaim aligned with actual eligibility.
 * Never from seed labels. Never learn a confident repair lesson from
 * uncertainty / gate disagreement. Hint text is evidence-derived, not model prose.
 * If grant.used_stale_mapping passed with refs, suggest get_workspace_mappings earlier.
 */
export function lessonFromRun(run: InvestigationRun): RunLesson | null {
  if (run.status !== "completed" || !run.finding) return null;
  if (!checkerAccepted(run)) return null;
  if (explanationIssues(run.finding, run.lastCheck, run.gathered?.freshContext).length) return null;
  if (run.finding.missingEvidence.length > 0) return null;

  // NONEMPTY complete coverage required (empty ⇒ reject).
  if (!run.coverage.length || !factsComplete(run.coverage)) return null;

  if (!run.lastCheck || !lastCheckScoped(run)) return null;
  if (hasUnresolvedLineMissing(run)) return null;

  // statusClaim must match actual eligibility — no learning from disagreement
  // (e.g. model claimed repair_candidate while gate said needs_verification).
  if (!run.eligibility || run.finding.statusClaim !== run.eligibility) return null;

  const checks = extractSourceBackedChecks(run.lastCheck);
  // Source-backed: passed with nonempty refs only.
  const passed = checks.filter((c) => c.passed && c.refs.length > 0);
  if (!passed.length) return null;

  const stale = passed.find((c) => c.conditionId === "grant.used_stale_mapping");
  const rawPriority: string[] = stale
    ? ["get_workspace_mappings", "get_entitlement_trail", "check_conditions"]
    : ["get_payments", "get_workspace_mappings", "get_entitlement_trail", "check_conditions"];
  const suggestedPriority = allowlistedPriority(rawPriority);
  if (!suggestedPriority.length) return null;

  const conditionIds = [...new Set(passed.map((c) => c.conditionId))];
  const hint = `prior run observed passed conditions [${conditionIds.join(", ")}] (hint, not current fact)`;

  return {
    sourceRunId: run.runId,
    tenantId: run.tenantId,
    applicability: `eligibility:${run.eligibility}`,
    hint,
    conditionIds,
    suggestedPriority,
    at: run.updatedAt,
  };
}

export async function openMemory(persistDir = DEFAULT_MEMORY_DIR): Promise<MemoryAdapter> {
  const { HMEM, source } = await loadHMEM();
  const hmem = new HMEM({ persistDir, actor: "revenue-lens-memory" });

  return {
    source,
    embeddingDisclosure: MEMORY_EMBEDDING_DISCLOSURE,
    persistDir,
    async rememberLesson(lesson) {
      const sanitized: RunLesson = {
        ...lesson,
        suggestedPriority: allowlistedPriority(lesson.suggestedPriority),
      };
      const record = hmem.add({
        content: lessonContent(sanitized),
        type: "general",
        source: `revenue-lens:run:${sanitized.sourceRunId}`,
      });
      return { id: record.id };
    },
    async recallPriority(query, opts) {
      const tenantId = opts.tenantId?.trim();
      if (!tenantId) {
        throw new Error("tenantId is required for memory recall (no cross-tenant leakage)");
      }
      const limit = clampPositiveLimit(opts.limit);
      const result = hmem.query(query, { threshold: 0.05, topN: Math.max(limit * 4, 8) });
      const memories: MemoryHit[] = [];
      for (const r of result.memories as Array<{ relevance: number; memory: { id: string; content: string } }>) {
        // Preserve historical records on disk, but do not reuse unaudited legacy lessons.
        if (!r.memory.content.includes(" | audit=source_condition_v1 | ")) continue;
        const t = parseTenantFromContent(r.memory.content);
        // Exact tenant match only — drop anything else before it leaves the adapter.
        if (t !== tenantId) continue;
        memories.push({
          id: r.memory.id,
          content: r.memory.content,
          relevance: r.relevance,
          sourceRunId: parseSourceRunFromContent(r.memory.content),
          tenantId: t,
        });
        if (memories.length >= limit) break;
      }
      const suggestedPriority: string[] = [];
      for (const m of memories) {
        const match = /priority=([^|]+)/.exec(m.content);
        if (!match) continue;
        for (const step of allowlistedPriority(match[1].split(">"))) {
          if (!suggestedPriority.includes(step)) suggestedPriority.push(step);
        }
      }
      // Priority hints only — never eligibility / write permission fields.
      return { suggestedPriority, memories };
    },
  };
}
