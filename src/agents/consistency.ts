// Typed condition/proposition audit. Does NOT validate arbitrary natural-language prose.
import type { CheckResult, SourceRef, InvestigationContext } from "../contracts.ts";
import type { FindingProposal } from "./types.ts";
function key(r: SourceRef): string {
  return JSON.stringify([r.source,r.table,Object.entries(r.key).sort(([a],[b])=>a.localeCompare(b)),r.version??null,r.via]);
}
export function explanationIssues(finding: FindingProposal | undefined, check: CheckResult | undefined, context?: InvestigationContext): string[] {
  if (!finding || !check) return [];
  const issues: string[]=[];
  const unresolved = finding.statusClaim === "needs_verification" || finding.statusClaim === "unknown";
  const gaps = check.lines.flatMap(l => l.missing);
  if (unresolved && gaps.length && !finding.missingEvidence.length) {
    issues.push(`list the unresolved evidence in missingEvidence: ${JSON.stringify(gaps)}`);
  }
  const completeMappingAbsence = !!context && context.tenantId === check.tenantId &&
    context.billingAccountId === check.billingAccountId && context.observedAt === check.observedAt && context.mappings.length === 0 &&
    context.coverage.length > 0 && context.coverage.every(c => c.complete) &&
    context.coverage.some(c => c.tool === "get_workspace_mappings" && c.complete && c.rows === 0);

  for (const h of finding.hypotheses) {
    if (!h.conditionId) continue; // historical prose stays inference, never retroactively verified
    const line=check.lines.find(l=>l.paymentLineId===h.paymentLineId);
    const c=line?.conditions.find(c=>c.id===h.conditionId);
    // Evidence for absence is the scoped complete read, not an invented row citation.
    // Only the negative unique-mapping proposition can be supported by this proof.
    if (c && !c.passed && !c.refs.length && c.id === "mapping.unique_current" &&
        completeMappingAbsence && unresolved && finding.missingEvidence.length > 0 &&
        ((h.conditionExpectedPassed === false && h.status === "supported") || h.status === "active")) continue;
    // A missing row has no row citation. It may remain an OPEN hypothesis in an
    // explicitly unresolved finding, never a supported/excluded claim or repair.
    if (h.status === "active" && unresolved && finding.missingEvidence.length > 0 && (!c || (!c.passed && !c.refs.length))) continue;
    if (!c || !c.refs.length || c.refs.some(r=>r.key.tenant_id!==check.tenantId)) {
      issues.push(`${h.id}: missing scoped source condition ${h.conditionId}. If this condition was not returned, omit it or leave it active. With a complete scoped empty mapping read, ONLY mapping.unique_current expected=false may be supported; all downstream conditions remain unevaluated. Report needs_verification, list missingEvidence and omit repairSuggestion`); continue;
    }
    const cited=new Set(h.refs.map(key));
    if (!c.refs.every(r=>cited.has(key(r)))) {issues.push(`${h.id}: condition evidence not fully cited`);continue;}
    const matches = c.passed === (h.conditionExpectedPassed ?? true);
    if (matches && h.status==='excluded') issues.push(`${h.id}: excludes passed proposition for source condition ${c.id} for ${line!.paymentLineId}: ${c.detail}`);
    if (!matches && h.status==='supported') issues.push(`${h.id}: supports failed proposition for source condition ${c.id} for ${line!.paymentLineId}: ${c.detail}`);
  }
  // A live repair finding must explicitly reconcile this source-backed cause signal.
  // No forced diagnosis for normal / uncertain cases; no inference from an unrelated line.
  if (finding.statusClaim==='repair_candidate') {
    for (const l of check.lines.filter(l=>!finding.repairSuggestion || l.paymentLineId===finding.repairSuggestion.paymentLineId)) {
      const c=l.conditions.find(c=>c.id==='grant.used_stale_mapping' && c.passed && c.refs.some(r=>r.source==='entitlements' && r.table==='grant_events') && c.refs.some(r=>r.source==='workspace_map' && r.table==='workspace_mappings'));
      if (!c) continue;
      const h=finding.hypotheses.find(h=>h.conditionId===c.id && h.paymentLineId===l.paymentLineId);
      if (!h || h.status!=='supported' || h.conditionExpectedPassed === false) issues.push(`explicit supported assessment required for ${c.id} on ${l.paymentLineId}; cite its exact records or revise finding to needs_verification`);
    }
  }
  return issues;
}
