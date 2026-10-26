import type { Hypothesis } from "../agents/types.ts";
import type { WhyCard } from "./card.ts";
import { escapeHtml } from "./escape.ts";

function hypothesisHtml(h: Hypothesis): string {
  const raw = `<span class="tag-inf">model wording (inference)</span> ${escapeHtml(h.claim)}`;
  if (!h.conditionId) return raw;
  return `<strong>Condition proposition:</strong> <code>${escapeHtml(h.conditionId)}</code> expected <code>${h.conditionExpectedPassed === false ? "false" : "true"}</code> for <code>${escapeHtml(h.paymentLineId ?? "unknown")}</code>. ${raw}`;
}

function refHtml(r: {
  source: string;
  table: string;
  key: Record<string, string>;
  version?: number;
  via: string;
}): string {
  const keys = Object.entries(r.key)
    .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`)
    .join(", ");
  const ver = r.version === undefined ? "" : ` · v${escapeHtml(r.version)}`;
  return `<code>${escapeHtml(r.source)}.${escapeHtml(r.table)}</code> (${keys})${ver} via ${escapeHtml(r.via)}`;
}

function li(items: string[]): string {
  return items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : `<p class="muted">None</p>`;
}

export function whyCardToHtml(card: WhyCard): string {
  const citations = card.evidenceRefs.length
    ? `<details class="why-citations"><summary>Source citations (${card.evidenceRefs.length})</summary>${li(
        card.evidenceRefs.map(refHtml),
      )}</details>`
    : `<p class="muted">No source citations on this finding.</p>`;

  const assessmentBlock = `<section class="why-assess ${card.assessmentsDisagree || card.furtherInvestigationRequired ? "is-disagree" : ""}">
    <h3>Assessment</h3>
    <dl>
      <dt>Model claim</dt><dd><code>${escapeHtml(card.modelStatusClaim ?? "n/a")}</code> <span class="tag-inf">investigator</span></dd>
      <dt>Gate eligibility</dt><dd><code>${escapeHtml(card.eligibility ?? "n/a")}</code> <span class="muted">deterministic check_conditions</span></dd>
      <dt>Ready for review</dt><dd><strong>${card.writeAuthorized ? "yes" : "no"}</strong> <span class="muted">(gate + model aligned; human confirm still required to write)</span></dd>
    </dl>
    ${
      card.assessmentsDisagree
        ? `<p class="why-disagree" role="status"><strong>Disagreement:</strong> model assessment (<code>${escapeHtml(String(card.modelStatusClaim))}</code>) does not match gate eligibility (<code>${escapeHtml(String(card.eligibility))}</code>). Further investigation required — model uncertainty is not write permission.</p>`
        : ""
    }
    ${
      !card.assessmentsDisagree && card.furtherInvestigationRequired
        ? `<p class="why-disagree" role="status"><strong>Further investigation required</strong> before any repair (missing evidence or model claim is not <code>repair_candidate</code>).</p>`
        : ""
    }
  </section>`;

  const repairBlock = (() => {
    switch (card.repair.state) {
      case "none":
        return `<section class="why-after"><h3>After repair</h3><p class="muted">No repair plan on this run.</p></section>`;
      case "planned_not_executed":
        if (!card.writeAuthorized) {
          return `<section class="why-after is-blocked"><h3>After repair</h3>
            <p class="why-disagree" role="status">A stored plan is <strong>not actionable</strong> while model assessment and gate disagree or evidence is incomplete. Do not confirm repair — investigate further.</p>
            <p class="muted">Stale intent <code>${escapeHtml(card.repair.plan.intentKey)}</code> is held only for audit; Confirm repair is refused.</p>
          </section>`;
        }
        return `<section class="why-after"><h3>After repair</h3>
          <p>Plan ready, <strong>not executed</strong>.</p>
          <dl class="why-plan">
            <dt>Intent</dt><dd><code>${escapeHtml(card.repair.plan.intentKey)}</code></dd>
            <dt>Entitlement</dt><dd><code>${escapeHtml(card.repair.plan.entitlementId)}</code> · expected v${escapeHtml(card.repair.plan.expectedVersion)}</dd>
            <dt>Retarget</dt><dd><code>${escapeHtml(card.repair.plan.fromWorkspace)}</code> → <code>${escapeHtml(card.repair.plan.toWorkspace)}</code> (mapping v${escapeHtml(card.repair.plan.mappingVersion)})</dd>
          </dl>
          <p class="muted">Customer recovered: <strong>no</strong> (requires receipt + probe HTTP 200).</p>
        </section>`;
      case "executed":
        return `<section class="why-after"><h3>After repair</h3>
          <p>Receipt outcome=<code>${escapeHtml(card.repair.receipt.outcome)}</code>${
            card.repair.receipt.receiptId ? ` · <code>${escapeHtml(card.repair.receipt.receiptId)}</code>` : ""
          }.</p>
          <p>${
            card.repair.probe
              ? `Access probe HTTP <strong>${escapeHtml(card.repair.probe.status)}</strong> on <code>${escapeHtml(card.repair.probe.workspace)}</code>.`
              : "No access probe recorded yet."
          }</p>
          <p>Customer recovered: <strong>no</strong> (needs receipt applied|replayed <em>and</em> probe 200).</p>
        </section>`;
      case "recovered":
        return `<section class="why-after"><h3>After repair</h3>
          <p>Receipt <code>${escapeHtml(card.repair.receipt.outcome)}</code>${
            card.repair.receipt.receiptId ? ` · <code>${escapeHtml(card.repair.receipt.receiptId)}</code>` : ""
          } and probe HTTP <strong>200</strong> on <code>${escapeHtml(card.repair.probe.workspace)}</code>.</p>
          <p>Customer recovered: <strong>yes</strong>.</p>
        </section>`;
    }
  })();

  return `<article class="why-card" data-run-id="${escapeHtml(card.runId)}">
  <header class="why-head">
    <p class="why-kicker">Why card</p>
    <p class="why-meta">Run <code>${escapeHtml(card.runId)}</code> · status ${escapeHtml(card.runStatus)}</p>
  </header>

  ${assessmentBlock}

  <section class="why-observed">
    <h3>Observation <span class="mono">observedAt ${escapeHtml(card.observedAt)}</span></h3>
    <dl>
      <dt>Tenant</dt><dd><code>${escapeHtml(card.tenantId)}</code></dd>
      <dt>Account</dt><dd><code>${escapeHtml(card.billingAccountId)}</code></dd>
      <dt>Model</dt><dd>${escapeHtml(card.model.model)} (${escapeHtml(card.model.provider)}) · available=${escapeHtml(String(card.model.available))}</dd>
      <dt>Roles</dt><dd>Proposed ${escapeHtml(card.proposedRoles.investigator)} / ${escapeHtml(card.proposedRoles.checker)} — <em>unbound</em>, not formally verified</dd>
    </dl>
    <h4>Conclusion</h4>
    <p class="why-conclusion">${escapeHtml(card.conclusion)}</p>
    <h4>Source-backed checks</h4>
    ${li(
      card.sourceBackedChecks.map(
        (c) =>
          `<span class="chk ${c.passed ? "pass" : "fail"}">${c.passed ? "pass" : "fail"}</span> <code>${escapeHtml(c.conditionId)}</code> · ${escapeHtml(c.paymentLineId)}: ${escapeHtml(c.detail)}`,
      ),
    )}
    <h4>Hypotheses <span class="tag-inf">inference</span></h4>
    ${li(
      card.hypotheses.map(
        (h) =>
          `[${escapeHtml(h.status)}] <code>${escapeHtml(h.id)}</code>: ${hypothesisHtml(h)} <span class="tag-inf">not proven fact</span>`,
      ),
    )}
    <h4>Excluded alternatives <span class="tag-inf">inference</span></h4>
    ${li(
      card.excludedHypotheses.map(
        (h) =>
          `<code>${escapeHtml(h.id)}</code>: ${hypothesisHtml(h)} — ${escapeHtml(h.exclusionReason ?? "")}`,
      ),
    )}
    <h4>Model causal links <span class="tag-inf">inference only</span></h4>
    ${li(
      card.inferenceCausalLinks.map(
        (l) =>
          `${escapeHtml(l.cause)} → ${escapeHtml(l.effect)} <span class="tag-inf">inference</span> (model claimed supported=${escapeHtml(String(l.modelClaimedSupported))})`,
      ),
    )}
    <h4>Missing evidence</h4>
    ${li(card.missingEvidence.map((m) => escapeHtml(m)))}
    ${citations}
    <h4>Coverage <span class="muted">(from this run’s tool facts only)</span></h4>
    ${li(
      card.coverage.map(
        (c) =>
          `<code>${escapeHtml(c.tool)}</code> · rows=${escapeHtml(String(c.rows))} · complete=${escapeHtml(String(c.complete))}`,
      ),
    )}
  </section>

  ${repairBlock}

  <p class="why-note">Recovery is reported only after an execution receipt (applied or replayed) and a sandbox access probe returning HTTP 200. Model hypotheses and causal prose are inference, not gate facts. Gate eligibility alone never authorizes repair when the model claim is uncertain.</p>
</article>`;
}
