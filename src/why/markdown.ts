import type { Hypothesis } from "../agents/types.ts";
import type { WhyCard } from "./card.ts";
import { escapeMd } from "./escape.ts";

function hypothesisText(h: Hypothesis): string {
  const raw = `Model wording (inference): ${escapeMd(h.claim)}`;
  if (!h.conditionId) return raw;
  return `Condition proposition: ${escapeMd(h.conditionId)} expected ${h.conditionExpectedPassed === false ? "false" : "true"} for ${escapeMd(h.paymentLineId ?? "unknown")}. ${raw}`;
}

function refLine(r: { source: string; table: string; key: Record<string, string>; version?: number; via: string }): string {
  const keys = Object.entries(r.key)
    .map(([k, v]) => `${escapeMd(k)}=${escapeMd(v)}`)
    .join(", ");
  const ver = r.version === undefined ? "" : ` v${r.version}`;
  return `${escapeMd(r.source)}.${escapeMd(r.table)} (${keys})${ver} via ${escapeMd(r.via)}`;
}

export function whyCardToMarkdown(card: WhyCard): string {
  const lines: string[] = [];
  lines.push(`# Why card — run \`${escapeMd(card.runId)}\``);
  lines.push("");
  lines.push(`- Tenant: \`${escapeMd(card.tenantId)}\``);
  lines.push(`- Billing account: \`${escapeMd(card.billingAccountId)}\``);
  lines.push(`- Observed at: \`${escapeMd(card.observedAt)}\``);
  lines.push(`- Run status: \`${escapeMd(card.runStatus)}\``);
  lines.push(`- Model statusClaim: \`${escapeMd(card.modelStatusClaim ?? "n/a")}\``);
  if (card.eligibility) lines.push(`- Deterministic gate eligibility: \`${escapeMd(card.eligibility)}\``);
  lines.push(`- Assessments disagree: **${card.assessmentsDisagree ? "yes" : "no"}**`);
  lines.push(`- Further investigation required: **${card.furtherInvestigationRequired ? "yes" : "no"}**`);
  lines.push(
    `- Ready for review: **${card.writeAuthorized ? "yes" : "no"}** (human confirm still required to write)`,
  );
  lines.push(`- Model: \`${escapeMd(card.model.model)}\` (${escapeMd(card.model.provider)}) available=${card.model.available}`);
  lines.push(
    `- Proposed roles (unbound): investigator=${escapeMd(card.proposedRoles.investigator)}, checker=${escapeMd(card.proposedRoles.checker)}`,
  );
  lines.push(`- Identity bound: \`false\``);
  lines.push("");
  lines.push("## Conclusion");
  lines.push(escapeMd(card.conclusion));
  lines.push("");
  lines.push("## Source-backed checks (deterministic gate)");
  if (!card.sourceBackedChecks.length) lines.push("_No check_conditions result on this run._");
  for (const c of card.sourceBackedChecks) {
    lines.push(
      `- [${c.passed ? "pass" : "fail"}] \`${escapeMd(c.conditionId)}\` on ${escapeMd(c.paymentLineId)}/${escapeMd(c.feature ?? "null")}: ${escapeMd(c.detail)}`,
    );
    for (const r of c.refs) lines.push(`  - ${refLine(r)}`);
  }
  lines.push("");
  lines.push("## Model causal links (inference only)");
  if (!card.inferenceCausalLinks.length) lines.push("_None proposed._");
  for (const l of card.inferenceCausalLinks) {
    lines.push(
      `- ${escapeMd(l.cause)} → ${escapeMd(l.effect)} (inference; modelClaimedSupported=${l.modelClaimedSupported}; not fact)`,
    );
    for (const r of l.refs) lines.push(`  - ${refLine(r)}`);
  }
  lines.push("");
  lines.push("## Hypotheses");
  for (const h of card.hypotheses) {
    lines.push(`- [${escapeMd(h.status)}] ${escapeMd(h.id)}: ${hypothesisText(h)}`);
  }
  lines.push("");
  lines.push("## Excluded alternatives");
  if (!card.excludedHypotheses.length) lines.push("_None recorded._");
  for (const h of card.excludedHypotheses) {
    lines.push(`- ${escapeMd(h.id)}: ${hypothesisText(h)} — ${escapeMd(h.exclusionReason ?? "")}`);
  }
  lines.push("");
  lines.push("## Missing evidence");
  if (!card.missingEvidence.length) lines.push("_None listed._");
  for (const m of card.missingEvidence) lines.push(`- ${escapeMd(m)}`);
  lines.push("");
  lines.push("## Evidence refs");
  for (const r of card.evidenceRefs) lines.push(`- ${refLine(r)}`);
  lines.push("");
  lines.push("## Coverage");
  for (const c of card.coverage) {
    lines.push(
      `- ${escapeMd(c.tool)} via ${escapeMd(c.via)}: rows=${c.rows} complete=${c.complete}${c.note ? ` (${escapeMd(c.note)})` : ""}`,
    );
  }
  lines.push("");
  lines.push("## Repair");
  switch (card.repair.state) {
    case "none":
      lines.push("No repair plan.");
      break;
    case "planned_not_executed":
      lines.push(
        `Plan **not yet executed**: \`${escapeMd(card.repair.plan.intentKey)}\` (${escapeMd(card.repair.plan.fromWorkspace)} → ${escapeMd(card.repair.plan.toWorkspace)}).`,
      );
      break;
    case "executed":
      lines.push(
        `Executed: outcome=\`${escapeMd(card.repair.receipt.outcome)}\` detail=${escapeMd(card.repair.receipt.detail)}` +
          (card.repair.probe ? `; access probe HTTP ${card.repair.probe.status}` : "; no access probe yet"),
      );
      break;
    case "recovered":
      lines.push(
        `Customer access recovered after receipt \`${escapeMd(card.repair.receipt.receiptId ?? "")}\` and probe HTTP 200 on workspace \`${escapeMd(card.repair.probe.workspace)}\`.`,
      );
      break;
  }
  lines.push("");
  lines.push(`## Customer recovered: **${card.customerRecovered ? "yes" : "no"}**`);
  if (!card.customerRecovered) {
    lines.push("_Recovery is only reported after an execution receipt and a successful sandbox access probe (HTTP 200)._");
  }
  lines.push("");
  lines.push("## Checker feedback");
  for (const f of card.checkerFeedback) lines.push(`- ${escapeMd(f)}`);
  lines.push("");
  lines.push("## Follow-up actions");
  for (const a of card.followUpActions) lines.push(`- ${escapeMd(a)}`);
  lines.push("");
  return lines.join("\n");
}
