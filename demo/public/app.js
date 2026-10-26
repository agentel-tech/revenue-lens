/* Revenue Lens operator UI — tokens never handled in the browser. */

const $ = (id) => document.getElementById(id);

/** Monotonic request id — ignore stale async responses. */
let reqSeq = 0;
let busy = false;
let accountsData = null;
/** @type {{ run: object, why?: object, whyHtml?: string, whyMarkdown?: string } | null} */
let current = null;
/** Standalone probe result (cleared on account change). */
let accessProbe = null;
/** In-page confirm dialog state — never window.confirm (blocks CDP recording). */
let pendingRepair = null;
let repairSubmitting = false;
let repairFocusReturn = null;
/** Session run ids for compare (newest first). */
let sessionRuns = [];
/** Last scan payload (for open-investigation). */
let lastScan = null;
/** Lab scan budget from /api/accounts (cap + concurrency + timeout). */
let scanBudget = null;
/** Interval id while a scan is in flight. */
let scanProgressTimer = null;

function formatScanBudget(b) {
  if (!b) return "";
  const sec = Math.round((b.timeoutMs ?? 0) / 1000);
  return `Budget: cap ${b.maxPaymentLines} distinct payment lines · concurrency ${b.concurrency} · wall clock ${sec}s (hard stop)`;
}

function stopScanProgress() {
  if (scanProgressTimer) {
    clearInterval(scanProgressTimer);
    scanProgressTimer = null;
  }
  const el = $("scanProgress");
  if (el) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("is-scanning");
  }
}

function startScanProgress() {
  stopScanProgress();
  const el = $("scanProgress");
  if (!el) return;
  const b = scanBudget;
  const started = Date.now();
  el.hidden = false;
  el.classList.add("is-scanning");
  const tick = () => {
    const elapsed = Math.floor((Date.now() - started) / 1000);
    if (b) {
      const budgetSec = Math.round(b.timeoutMs / 1000);
      el.textContent = `Scanning permitted synthetic cast… ${elapsed}s elapsed / ${budgetSec}s budget · cap ${b.maxPaymentLines} payment lines · concurrency ${b.concurrency}. Waiting on live reads — counts come from the response, not guesses.`;
    } else {
      el.textContent = `Scanning permitted synthetic cast… ${elapsed}s elapsed. Waiting on live reads — counts come from the response, not guesses.`;
    }
  };
  tick();
  scanProgressTimer = setInterval(tick, 1000);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function selectedAccount() {
  const [tenantId, billingAccountId] = ($("account").value || "").split("::");
  if (!tenantId || !billingAccountId) return null;
  const a = accountsData?.accounts?.find(
    (x) => x.tenantId === tenantId && x.billingAccountId === billingAccountId,
  );
  return a ? { ...a, tenantId, billingAccountId } : { tenantId, billingAccountId };
}

function setBusy(on) {
  busy = on;
  $("panel-customer")?.classList.toggle("controls-locked", on);
  $("investigate").disabled = on;
  $("testAccess").disabled = on;
  if ($("runScan")) $("runScan").disabled = on;
  if ($("recallMemory")) $("recallMemory").disabled = on;
  if ($("compareRuns")) $("compareRuns").disabled = on;
  if (on) {
    $("confirmRepair").disabled = true;
    $("retryRepair").disabled = true;
  } else {
    syncRepairButtons();
  }
}

function firstToolName(run) {
  const step = (run?.trace || []).find((t) => t.action === "tool" && t.tool);
  return step?.tool ?? null;
}

function rememberSessionRun(run) {
  if (!run?.runId) return;
  sessionRuns = [run.runId, ...sessionRuns.filter((id) => id !== run.runId)].slice(0, 12);
  fillCompareSelects();
}

/** Safe run-id syntax for path segment use — alphanumeric start, then [A-Za-z0-9._-], no slashes. */
function isSafeRunId(id) {
  const s = String(id ?? "").trim();
  if (!s || s.length > 128) return false;
  if (s.includes("..") || s.includes("/") || s.includes("\\")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s);
}

function fillCompareSelects() {
  for (const id of ["compareRunA", "compareRunB"]) {
    const sel = $(id);
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— session run —";
    sel.appendChild(blank);
    for (const runId of sessionRuns) {
      const opt = document.createElement("option");
      opt.value = runId;
      opt.textContent = runId;
      sel.appendChild(opt);
    }
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  const list = $("compareRunList");
  if (list) {
    list.innerHTML = "";
    for (const runId of sessionRuns) {
      const opt = document.createElement("option");
      opt.value = runId;
      list.appendChild(opt);
    }
  }
}

/** Prefer pasted ID; fall back to session select. Returns trimmed id or null if empty; throws on unsafe syntax. */
function resolveCompareRunId(inputId, selectId) {
  const typed = String($(inputId)?.value ?? "").trim();
  const picked = String($(selectId)?.value ?? "").trim();
  const id = typed || picked;
  if (!id) return null;
  if (!isSafeRunId(id)) {
    throw new Error("invalid run id syntax (use letters, digits, . _ - only)");
  }
  return id;
}

function parseLessonFields(summary) {
  const raw = String(summary ?? "");
  const fields = {};
  for (const part of raw.split("|")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) fields[k] = v;
  }
  return fields;
}

function chipHtml(label, kind) {
  return `<span class="mem-chip mem-chip-${kind}">${esc(label)}</span>`;
}

/** Ensure account exists in the selector (cohort may arrive only from scan). Never exposes role/token. */
function ensureAccountOption(acct) {
  const sel = $("account");
  const key = `${acct.tenantId}::${acct.billingAccountId}`;
  if (![...sel.options].some((o) => o.value === key)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = `${acct.name || acct.billingAccountId} — ${acct.billingAccountId}`;
    sel.appendChild(opt);
    if (!accountsData) accountsData = { accounts: [] };
    if (!accountsData.accounts.some((a) => a.tenantId === acct.tenantId && a.billingAccountId === acct.billingAccountId)) {
      accountsData.accounts.push({
        tenantId: acct.tenantId,
        billingAccountId: acct.billingAccountId,
        name: acct.name || acct.billingAccountId,
        currentWorkspace: acct.currentWorkspace || "—",
        paymentLineId: acct.paymentLineId || "",
      });
    }
  }
  sel.value = key;
  clearRunState();
  const a = selectedAccount();
  $("accountMeta").innerHTML = a
    ? `<span class="acct-name">${esc(a.name)}</span> · workspace <code>${esc(a.currentWorkspace ?? "—")}</code>`
    : "";
}

function fillTenantSelects(tenants) {
  for (const id of ["scanTenant", "memoryTenant"]) {
    const sel = $(id);
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = "";
    for (const t of tenants) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    }
    if (prev && tenants.includes(prev)) sel.value = prev;
  }
}

function renderRunMemoryMeta(run) {
  const el = $("runMemoryMeta");
  if (!el) return;
  if (!run) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  const on = run.memoryEnabled === true;
  const ids = Array.isArray(run.recalledLessonIds) ? run.recalledLessonIds : [];
  const pri = Array.isArray(run.suggestedPriority) ? run.suggestedPriority : [];
  const first = firstToolName(run);
  el.hidden = false;
  el.innerHTML = on
    ? `Memory <strong>on</strong> · recalled ${ids.length ? ids.map((id) => `<code>${esc(id)}</code>`).join(" ") : "(none)"} · priority ${
        pri.length ? pri.map((p) => `<code>${esc(p)}</code>`).join(" → ") : "(none)"
      } · first tool ${first ? `<code>${esc(first)}</code>` : "(none)"}`
    : `Memory <strong>off</strong> · no recall · first tool ${first ? `<code>${esc(first)}</code>` : "(none)"}`;
}

function renderScan(result) {
  lastScan = result;
  stopScanProgress();
  const sum = $("scanSummary");
  const host = $("scanRows");
  if (!result) {
    sum.textContent = "";
    host.innerHTML = "";
    return;
  }
  const partial = result.partial ? "Partial scan" : "Scan complete";
  const budgetSec = result.timeoutMs != null ? Math.round(result.timeoutMs / 1000) : null;
  sum.innerHTML = `${esc(partial)} · scanned <strong>${esc(result.scannedLines)}</strong> / cap ${esc(
    result.maxPaymentLines,
  )} payment lines · candidates <strong>${esc(result.candidateLines)}</strong> · unknown <strong>${esc(
    result.unknownLines,
  )}</strong> · paid/in-force <strong>${esc(result.distinctPaidInForceLines)}</strong> · accounts <strong>${esc(
    result.distinctCustomers,
  )}</strong>${
    budgetSec != null
      ? ` · time budget <strong>${esc(budgetSec)}s</strong> · concurrency <strong>${esc(result.concurrency)}</strong>`
      : ""
  }
    <br /><span class="scan-scope">${esc(result.scopeNote || "")}</span>
    ${
      result.partialReasons?.length
        ? `<br /><span class="scan-reasons">${result.partialReasons.map((r) => esc(r)).join(" · ")}</span>`
        : ""
    }
    <br /><span class="muted">${esc(result.note || "No repairs proposed.")}</span>`;

  host.innerHTML = "";
  if (!result.rows?.length) {
    host.innerHTML = '<p class="muted">No retained rows.</p>';
    return;
  }
  const table = document.createElement("table");
  table.className = "scan-table";
  table.innerHTML =
    "<thead><tr><th>Account</th><th>Line</th><th>Status</th><th>Reason</th><th></th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const row of result.rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><strong>${esc(row.name)}</strong><br /><code>${esc(row.billingAccountId)}</code></td>
      <td><code>${esc(row.paymentLineId)}</code>${row.feature ? `<br /><span class="muted">${esc(row.feature)}</span>` : ""}</td>
      <td><code>${esc(row.status)}</code></td>
      <td class="scan-reason">${esc(row.reason)}${
        row.recordIds?.length ? `<br /><span class="muted">${row.recordIds.map((id) => esc(id)).join(", ")}</span>` : ""
      }</td>
      <td></td>`;
    const td = tr.lastElementChild;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-secondary btn-compact";
    btn.textContent = "Open";
    btn.addEventListener("click", () => {
      ensureAccountOption({
        tenantId: row.tenantId,
        billingAccountId: row.billingAccountId,
        name: row.name,
        paymentLineId: row.paymentLineId,
      });
      $("account").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    td.appendChild(btn);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

function renderMemory(data) {
  const disc = $("memoryDisclosure");
  const sum = $("memorySummary");
  const host = $("memoryLessons");
  if (!data) {
    disc.textContent = "";
    sum.textContent = "";
    host.innerHTML = "";
    return;
  }
  disc.textContent = data.embeddingDisclosure || data.memorySource || "";
  const pri = data.suggestedPriority || [];
  sum.innerHTML = `Source <code>${esc(data.memorySource)}</code> · suggested priority ${
    pri.length ? pri.map((p) => chipHtml(p, "tool")).join(" ") : "(none)"
  } · priority hints only (not facts)`;
  host.innerHTML = "";
  if (!data.lessons?.length) {
    host.innerHTML = '<p class="muted">No tenant-scoped lessons recalled.</p>';
    return;
  }
  for (const lesson of data.lessons) {
    const fields = parseLessonFields(lesson.summary);
    const sourceRun = lesson.sourceRunId || fields.sourceRun || "";
    const conditions = (fields.conditions || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const tools = (fields.priority || "")
      .split(">")
      .map((s) => s.trim())
      .filter(Boolean);
    const hint = fields.hint || "";
    const div = document.createElement("div");
    div.className = "memory-card";
    div.innerHTML = `<div class="memory-card-head">
        <span class="memory-id"><code>${esc(lesson.id)}</code></span>
        ${sourceRun ? `<span class="memory-source-run">sourceRun <code>${esc(sourceRun)}</code></span>` : ""}
      </div>
      ${hint ? `<p class="memory-hint">${esc(hint)}</p>` : ""}
      <div class="mem-chip-row">
        ${conditions.map((c) => chipHtml(c, "cond")).join("")}
        ${tools.map((t) => chipHtml(t, "tool")).join("")}
      </div>
      <details class="memory-raw">
        <summary>Raw lesson summary</summary>
        <pre class="memory-raw-pre">${esc(lesson.summary)}</pre>
      </details>`;
    host.appendChild(div);
  }
}

function writeAuthorizedFromPayload(payload) {
  if (payload?.why && typeof payload.why.writeAuthorized === "boolean") return payload.why.writeAuthorized;
  const run = payload?.run;
  if (!run || run.status !== "completed" || !run.repairPlan) return false;
  const claim = run.finding?.statusClaim;
  if (claim !== "repair_candidate") return false;
  if ((run.finding?.missingEvidence?.length ?? 0) > 0) return false;
  if (run.eligibility && claim !== run.eligibility) return false;
  return true;
}

/** Stages driven only by real probe / run / plan / receipt+probe200 — never fake Restore. */
function updateStages() {
  const run = current?.run;
  const hasProbe = !!accessProbe;
  const hasRun = !!(run && run.status && run.status !== "unavailable");
  const hasFinding = !!(run?.finding || (run?.trace || []).some((t) => t.decision?.kind === "propose_finding"));
  const canReview = writeAuthorizedFromPayload(current);
  const recovered =
    !!run?.receipt &&
    (run.receipt.outcome === "applied" || run.receipt.outcome === "replayed") &&
    run.accessProbe?.status === 200;

  const done = {
    observe: hasProbe || hasRun,
    explain: hasFinding || (hasRun && run.status === "completed"),
    review: canReview || recovered,
    // Restore completes only after receipt + probe 200 — never earlier.
    restore: recovered,
  };

  let currentStage = "observe";
  if (recovered) currentStage = "restore";
  else if (canReview) currentStage = "review";
  else if (done.explain) currentStage = "review";
  else if (done.observe) currentStage = "explain";

  for (const li of document.querySelectorAll("#stages .stage")) {
    const key = li.getAttribute("data-stage");
    li.classList.toggle("is-done", !!done[key]);
    // Restore is never current before receipt+probe200; Review holds until then.
    li.classList.toggle("is-current", !recovered && key === currentStage);
  }
}

function closeRepairDialog({ restoreFocus } = { restoreFocus: true }) {
  const dlg = $("repairConfirmDialog");
  pendingRepair = null;
  repairSubmitting = false;
  if (dlg?.open) dlg.close();
  const submit = $("repairConfirmSubmit");
  if (submit) {
    submit.disabled = false;
    submit.textContent = "Confirm this repair";
  }
  if (restoreFocus && repairFocusReturn && typeof repairFocusReturn.focus === "function") {
    try {
      repairFocusReturn.focus();
    } catch {
      /* ignore */
    }
  }
  repairFocusReturn = null;
}

function clearRunState() {
  closeRepairDialog({ restoreFocus: false });
  current = null;
  accessProbe = null;
  $("why").innerHTML =
    '<p class="muted">Run an investigation to explain what the evidence shows for this customer.</p>';
  $("whyMd").textContent = "";
  $("trace").textContent = "No run yet.";
  $("timeline").innerHTML = "";
  $("runMeta").textContent = "No run loaded.";
  renderRunMemoryMeta(null);
  $("planBox").innerHTML = '<p class="muted">No repair candidate on this run yet.</p>';
  $("repairOut").hidden = true;
  $("repairOut").textContent = "";
  $("retryRepair").hidden = true;
  syncRepairButtons();
  renderAccess();
  updateStages();
}

function renderAccess() {
  const badge = $("accessBadge");
  const detail = $("accessResult");
  const block = $("accessBlock");
  if (!accessProbe) {
    badge.className = "access-badge is-unknown";
    badge.textContent = "Unknown";
    detail.textContent = "Not probed yet.";
    block?.classList.remove("has-status");
    updateStages();
    return;
  }
  const status = accessProbe.status;
  const ok = status === 200;
  badge.className = `access-badge ${ok ? "is-200" : "is-denied"}`;
  badge.textContent = String(status);
  block?.classList.add("has-status");
  detail.innerHTML = `<code>${esc(accessProbe.workspace)}</code> · <code>${esc(accessProbe.feature)}</code> · ${esc(accessProbe.at)}`;
  updateStages();
}

function evidenceCount(run) {
  const fromFinding = run.finding?.evidenceRefs?.length ?? 0;
  const fromGathered = run.gathered?.evidence?.size;
  if (typeof fromGathered === "number") return fromGathered;
  return fromFinding;
}

function timelineTitle(t) {
  if (t.action === "tool" && t.tool) return t.tool;
  if (t.action === "gate") return "check_conditions";
  if (t.action === "plan") return t.decision?.kind === "repair_plan" ? "Repair plan ready" : "No repair plan";
  if (t.action === "feedback") return t.decision?.kind === "accept" ? "Checker accepted" : "Checker feedback";
  const kind = t.decision?.kind;
  if (kind === "call_tool") return "Chose next read";
  if (kind === "propose_finding") return "Proposed finding";
  if (kind === "stop") return "Stopped";
  if (kind === "accept") return "Checker accepted";
  if (kind === "need_evidence") return "Need evidence";
  if (kind === "reject") return "Checker rejected";
  if (kind === "invalid") return "Invalid response";
  return kind || t.action;
}

function renderTimeline(run) {
  const ol = $("timeline");
  ol.innerHTML = "";
  // Display-only: collapse checker feedback that duplicates the prior checker model decision.
  // Raw trace JSON below stays complete.
  const steps = [];
  for (const t of run.trace || []) {
    if (
      t.action !== "model" &&
      t.action !== "tool" &&
      t.action !== "feedback" &&
      t.action !== "gate" &&
      t.action !== "plan"
    ) {
      continue;
    }
    if (t.role === "checker" && t.action === "feedback" && steps.length) {
      const prev = steps[steps.length - 1];
      if (
        prev.role === "checker" &&
        prev.action === "model" &&
        JSON.stringify(prev.decision ?? null) === JSON.stringify(t.decision ?? null)
      ) {
        continue;
      }
    }
    steps.push(t);
  }
  if (!steps.length) {
    ol.innerHTML = '<li class="tl-empty muted">No steps yet.</li>';
    return;
  }
  for (const t of steps) {
    const li = document.createElement("li");
    li.className = "tl-card";
    const title = timelineTitle(t);
    const role = t.role === "system" ? "" : `<span class="tl-role">${esc(t.role)}</span>`;
    const seek = t.seeking ? `<p class="tl-seek">${esc(t.seeking)}</p>` : "";
    const fb =
      t.action === "feedback" && t.decision?.feedback
        ? `<p class="tl-seek">${esc(t.decision.feedback)}</p>`
        : t.decision?.note
          ? `<p class="tl-seek">${esc(t.decision.note)}</p>`
          : t.decision?.detail && t.action === "plan"
            ? `<p class="tl-seek">${esc(t.decision.detail)}</p>`
            : "";
    li.innerHTML = `<div class="tl-head">${role}<strong class="tl-title">${esc(title)}</strong></div>${seek}${fb}`;
    ol.appendChild(li);
  }
}

function syncRepairButtons() {
  const plan = current?.run?.repairPlan;
  const btn = $("confirmRepair");
  const retry = $("retryRepair");
  const authorized = writeAuthorizedFromPayload(current);
  if (!plan || busy || !authorized) {
    btn.disabled = true;
    btn.textContent = "Confirm repair";
    retry.disabled = true;
    retry.hidden = true;
    return;
  }
  if (current.run.receipt) {
    btn.disabled = true;
    btn.textContent = "Confirm repair";
    retry.hidden = false;
    retry.disabled = false;
  } else {
    btn.disabled = false;
    btn.textContent = "Confirm repair";
    retry.hidden = true;
    retry.disabled = true;
  }
}

function renderPlan(run) {
  const plan = run.repairPlan;
  const box = $("planBox");
  if (!plan) {
    box.innerHTML = '<p class="muted">No repair candidate on this run.</p>';
    $("repairOut").hidden = true;
    syncRepairButtons();
    updateStages();
    return;
  }
  const authorized = writeAuthorizedFromPayload(current);
  const receipt = run.receipt;
  const probe = run.accessProbe;
  let receiptBlock = "";
  if (receipt) {
    receiptBlock = `<dt>Receipt</dt><dd><code>${esc(receipt.outcome)}</code>${
      receipt.receiptId ? ` · <code>${esc(receipt.receiptId)}</code>` : ""
    }${receipt.detail ? ` — ${esc(receipt.detail)}` : ""}</dd>`;
    if (probe) {
      receiptBlock += `<dt>After repair</dt><dd>HTTP ${esc(probe.status)} on <code>${esc(probe.workspace)}</code></dd>`;
    }
  }
  const disagreeNote = !authorized
    ? `<p class="why-disagree" role="status">Model claim <code>${esc(run.finding?.statusClaim ?? "n/a")}</code> vs gate <code>${esc(run.eligibility ?? "n/a")}</code> — further investigation required. Confirm repair disabled.</p>`
    : "";
  box.innerHTML = `
    <p class="plan-kicker">${authorized ? "Review &amp; repair" : "Repair blocked"}</p>
    ${disagreeNote}
    <dl>
      <dt>Entitlement</dt><dd><code>${esc(plan.entitlementId)}</code> · v${esc(plan.expectedVersion)}</dd>
      <dt>Workspace</dt><dd><code>${esc(plan.fromWorkspace)}</code> <span class="plan-arrow">→</span> <code>${esc(plan.toWorkspace)}</code></dd>
      <dt>Feature</dt><dd><code>${esc(plan.feature)}</code></dd>
      ${receiptBlock}
    </dl>`;
  if (receipt || probe) {
    $("repairOut").hidden = false;
    $("repairOut").textContent = JSON.stringify({ receipt, accessProbe: probe }, null, 2);
  } else {
    $("repairOut").hidden = true;
  }
  syncRepairButtons();
  updateStages();
}

function render(payload) {
  current = payload;
  const run = payload.run;
  $("runMeta").textContent = `${run.status} · ${evidenceCount(run)} citations · ${run.observedAt}`;
  renderRunMemoryMeta(run);
  rememberSessionRun(run);
  renderTimeline(run);
  $("trace").textContent = JSON.stringify(run.trace ?? [], null, 2);
  $("why").innerHTML = payload.whyHtml || "";
  $("whyMd").textContent = payload.whyMarkdown || "";
  renderPlan(run);
  if (run.accessProbe && run.receipt) {
    accessProbe = run.accessProbe;
    renderAccess();
  } else {
    updateStages();
  }
}

async function loadAccounts() {
  const res = await fetch("/api/accounts");
  const data = await res.json();
  accountsData = data;
  const sel = $("account");
  sel.innerHTML = "";
  for (const a of data.accounts) {
    const opt = document.createElement("option");
    opt.value = `${a.tenantId}::${a.billingAccountId}`;
    opt.textContent = `${a.name} — ${a.billingAccountId}`;
    sel.appendChild(opt);
  }
  fillTenantSelects(data.tenants || [...new Set(data.accounts.map((a) => a.tenantId))]);
  if (data.scanBudget) {
    scanBudget = data.scanBudget;
    const budgetEl = $("scanBudget");
    if (budgetEl) budgetEl.textContent = formatScanBudget(scanBudget);
  }
  sel.addEventListener("change", () => {
    clearRunState();
    updateMeta();
    const a = selectedAccount();
    if (a && $("scanTenant")) $("scanTenant").value = a.tenantId;
    if (a && $("memoryTenant")) $("memoryTenant").value = a.tenantId;
  });
  updateMeta();
  function updateMeta() {
    const a = selectedAccount();
    $("accountMeta").innerHTML = a
      ? `<span class="acct-name">${esc(a.name)}</span> · workspace <code>${esc(a.currentWorkspace ?? "—")}</code>`
      : "";
  }
}

async function loadRunById(runId) {
  const my = ++reqSeq;
  setBusy(true);
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    const data = await res.json();
    if (my !== reqSeq) return;
    if (!res.ok) {
      $("runMeta").textContent = data.error || `Failed to load run ${runId}`;
      return;
    }
    // Saved cohort investigations must select their actual account, not the default customer.
    if (data.account) ensureAccountOption(data.account);
    const key = `${data.run.tenantId}::${data.run.billingAccountId}`;
    if ([...$("account").options].some((o) => o.value === key)) {
      $("account").value = key;
    }
    render(data);
  } catch (e) {
    if (my !== reqSeq) return;
    $("runMeta").textContent = String(e);
  } finally {
    if (my === reqSeq) setBusy(false);
  }
}

$("investigate").addEventListener("click", async () => {
  const a = selectedAccount();
  if (!a) return;
  const my = ++reqSeq;
  const keepProbe = accessProbe;
  const memoryEnabled = !!$("memoryEnabled")?.checked;
  clearRunState();
  accessProbe = keepProbe;
  renderAccess();
  setBusy(true);
  $("runMeta").textContent = "Investigating…";
  $("trace").textContent = "Investigating…";
  try {
    const res = await fetch("/api/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: a.tenantId,
        billingAccountId: a.billingAccountId,
        memoryEnabled,
      }),
    });
    const data = await res.json();
    if (my !== reqSeq) return;
    if (!res.ok) {
      $("trace").textContent = JSON.stringify(data, null, 2);
      $("runMeta").textContent = data.error || "Investigate failed";
      updateStages();
      return;
    }
    render(data);
    history.replaceState(null, "", `?run=${encodeURIComponent(data.run.runId)}`);
  } catch (e) {
    if (my !== reqSeq) return;
    $("trace").textContent = String(e);
  } finally {
    if (my === reqSeq) setBusy(false);
  }
});

$("runScan")?.addEventListener("click", async () => {
  const tenantId = $("scanTenant")?.value;
  if (!tenantId) return;
  const my = ++reqSeq;
  setBusy(true);
  $("scanSummary").textContent = "";
  $("scanRows").innerHTML = "";
  startScanProgress();
  try {
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId }),
    });
    const data = await res.json();
    if (my !== reqSeq) return;
    stopScanProgress();
    if (!res.ok) {
      $("scanSummary").textContent = data.error || "Scan failed";
      return;
    }
    renderScan(data);
  } catch (e) {
    if (my !== reqSeq) return;
    stopScanProgress();
    $("scanSummary").textContent = String(e);
  } finally {
    if (my === reqSeq) {
      stopScanProgress();
      setBusy(false);
    }
  }
});

$("recallMemory")?.addEventListener("click", async () => {
  const tenantId = $("memoryTenant")?.value;
  if (!tenantId) return;
  const my = ++reqSeq;
  setBusy(true);
  $("memorySummary").textContent = "Recalling…";
  $("memoryLessons").innerHTML = "";
  try {
    const res = await fetch(`/api/memory?tenantId=${encodeURIComponent(tenantId)}`);
    const data = await res.json();
    if (my !== reqSeq) return;
    if (!res.ok) {
      $("memoryDisclosure").textContent = "";
      $("memorySummary").textContent = data.error || "Memory unavailable";
      return;
    }
    renderMemory(data);
  } catch (e) {
    if (my !== reqSeq) return;
    $("memorySummary").textContent = String(e);
  } finally {
    if (my === reqSeq) setBusy(false);
  }
});

function syncCompareSelectToInput(selectId, inputId) {
  const sel = $(selectId);
  const input = $(inputId);
  if (!sel || !input) return;
  sel.addEventListener("change", () => {
    if (sel.value) input.value = sel.value;
  });
}
syncCompareSelectToInput("compareRunA", "compareRunAId");
syncCompareSelectToInput("compareRunB", "compareRunBId");

$("compareRuns")?.addEventListener("click", async () => {
  const out = $("compareOut");
  let aId;
  let bId;
  try {
    aId = resolveCompareRunId("compareRunAId", "compareRunA");
    bId = resolveCompareRunId("compareRunBId", "compareRunB");
  } catch (e) {
    out.textContent = String(e.message || e);
    return;
  }
  if (!aId || !bId) {
    out.textContent = "Enter or select two run ids.";
    return;
  }
  if (aId === bId) {
    out.textContent = "Pick two different runs.";
    return;
  }
  const my = ++reqSeq;
  setBusy(true);
  out.textContent = "Loading…";
  try {
    const [ra, rb] = await Promise.all([
      fetch(`/api/runs/${encodeURIComponent(aId)}`).then(async (r) => ({ ok: r.ok, data: await r.json() })),
      fetch(`/api/runs/${encodeURIComponent(bId)}`).then(async (r) => ({ ok: r.ok, data: await r.json() })),
    ]);
    if (my !== reqSeq) return;
    if (!ra.ok || !rb.ok) {
      out.textContent = (!ra.ok ? ra.data.error : rb.data.error) || "Failed to load runs";
      return;
    }
    const A = ra.data.run;
    const B = rb.data.run;
    out.innerHTML = `<div class="compare-table-wrap"><table class="compare-table">
      <thead><tr><th></th><th>Run A</th><th>Run B</th></tr></thead>
      <tbody>
        <tr><th>Run</th><td><code>${esc(A.runId)}</code></td><td><code>${esc(B.runId)}</code></td></tr>
        <tr><th>Memory</th><td>${A.memoryEnabled ? "on" : "off"}</td><td>${B.memoryEnabled ? "on" : "off"}</td></tr>
        <tr><th>Recalled IDs</th><td>${(A.recalledLessonIds || []).map((id) => `<code>${esc(id)}</code>`).join(" ") || "—"}</td>
          <td>${(B.recalledLessonIds || []).map((id) => `<code>${esc(id)}</code>`).join(" ") || "—"}</td></tr>
        <tr><th>Suggested priority</th><td>${(A.suggestedPriority || []).map((p) => chipHtml(p, "tool")).join(" ") || "—"}</td>
          <td>${(B.suggestedPriority || []).map((p) => chipHtml(p, "tool")).join(" ") || "—"}</td></tr>
        <tr><th>First tool</th><td>${firstToolName(A) ? chipHtml(firstToolName(A), "tool") : "—"}</td>
          <td>${firstToolName(B) ? chipHtml(firstToolName(B), "tool") : "—"}</td></tr>
      </tbody>
    </table></div>
    <p class="muted">Comparison is observational — model still chooses tools freely.</p>`;
  } catch (e) {
    if (my !== reqSeq) return;
    out.textContent = String(e);
  } finally {
    if (my === reqSeq) setBusy(false);
  }
});

$("testAccess").addEventListener("click", async () => {
  const a = selectedAccount();
  if (!a) return;
  const my = ++reqSeq;
  setBusy(true);
  $("accessBadge").className = "access-badge is-unknown";
  $("accessBadge").textContent = "…";
  $("accessResult").textContent = "Probing…";
  try {
    const res = await fetch("/api/probe-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: a.tenantId,
        billingAccountId: a.billingAccountId,
        workspace: a.currentWorkspace,
        feature: "reports",
      }),
    });
    const data = await res.json();
    if (my !== reqSeq) return;
    if (!res.ok) {
      accessProbe = null;
      renderAccess();
      $("accessResult").textContent = data.error || "Probe failed";
      return;
    }
    accessProbe = {
      workspace: data.workspace,
      feature: data.feature,
      status: data.status,
      body: data.body,
      at: data.at,
    };
    renderAccess();
  } catch (e) {
    if (my !== reqSeq) return;
    accessProbe = null;
    renderAccess();
    $("accessResult").textContent = String(e);
  } finally {
    if (my === reqSeq) setBusy(false);
  }
});

function openRepairConfirmDialog({ retry }) {
  if (!current?.run?.repairPlan || !writeAuthorizedFromPayload(current)) return;
  if (repairSubmitting) return;
  const run = current.run;
  const plan = run.repairPlan;
  const acct = selectedAccount();
  // Scope: dialog only for the account currently selected and matching the run.
  if (!acct || acct.tenantId !== run.tenantId || acct.billingAccountId !== run.billingAccountId) {
    $("repairOut").hidden = false;
    $("repairOut").textContent = JSON.stringify({
      error: "selected account does not match this run; change cancelled",
    });
    return;
  }

  pendingRepair = {
    runId: run.runId,
    intentKey: plan.intentKey,
    tenantId: run.tenantId,
    billingAccountId: run.billingAccountId,
    isRetry: !!retry,
  };
  repairFocusReturn = document.activeElement;

  $("repairConfirmTitle").textContent = retry ? "Retry same repair" : "Confirm repair";
  $("repairConfirmLead").textContent = retry
    ? "This will send the same server-held intent again. Review every field, then confirm."
    : "Review the exact change. No write runs until you click Confirm this repair.";
  $("rcAccount").textContent = `${acct.name || acct.billingAccountId} · ${run.tenantId} / ${run.billingAccountId}`;
  $("rcEntitlement").textContent = `${plan.entitlementId} · v${plan.expectedVersion}`;
  $("rcWorkspace").innerHTML = `<code>${esc(plan.fromWorkspace)}</code> → <code>${esc(plan.toWorkspace)}</code>`;
  $("rcFeature").textContent = `${plan.feature} · payment ${plan.paymentLineId}`;
  $("rcIntent").innerHTML = `<code>${esc(plan.intentKey)}</code>`;
  $("rcRun").innerHTML = `<code>${esc(run.runId)}</code>`;

  const submit = $("repairConfirmSubmit");
  submit.disabled = false;
  submit.textContent = "Confirm this repair";

  const dlg = $("repairConfirmDialog");
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
  $("repairConfirmCancel").focus();
}

async function executePendingRepair() {
  if (!pendingRepair || repairSubmitting) return;
  const snapshot = { ...pendingRepair };
  // Re-check identity + authorization immediately before write.
  if (!current?.run?.repairPlan) {
    closeRepairDialog({ restoreFocus: true });
    return;
  }
  if (current.run.runId !== snapshot.runId || current.run.repairPlan.intentKey !== snapshot.intentKey) {
    closeRepairDialog({ restoreFocus: true });
    return;
  }
  if (!writeAuthorizedFromPayload(current)) {
    closeRepairDialog({ restoreFocus: true });
    return;
  }
  const acct = selectedAccount();
  if (
    !acct ||
    acct.tenantId !== snapshot.tenantId ||
    acct.billingAccountId !== snapshot.billingAccountId ||
    current.run.tenantId !== snapshot.tenantId ||
    current.run.billingAccountId !== snapshot.billingAccountId
  ) {
    closeRepairDialog({ restoreFocus: true });
    return;
  }

  repairSubmitting = true;
  $("repairConfirmSubmit").disabled = true;
  $("repairConfirmSubmit").textContent = "Confirming…";
  $("repairConfirmCancel").disabled = true;

  const my = ++reqSeq;
  setBusy(true);
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(snapshot.runId)}/confirm-repair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, intentKey: snapshot.intentKey }),
    });
    const data = await res.json();
    if (my !== reqSeq) return;
    closeRepairDialog({ restoreFocus: false });
    if (!res.ok) {
      $("repairOut").hidden = false;
      $("repairOut").textContent = JSON.stringify(data, null, 2);
      return;
    }
    render(data);
  } catch (e) {
    if (my !== reqSeq) return;
    closeRepairDialog({ restoreFocus: true });
    $("repairOut").hidden = false;
    $("repairOut").textContent = String(e);
  } finally {
    repairSubmitting = false;
    const cancel = $("repairConfirmCancel");
    if (cancel) cancel.disabled = false;
    if (my === reqSeq) setBusy(false);
  }
}

$("confirmRepair").addEventListener("click", () => openRepairConfirmDialog({ retry: false }));
$("retryRepair").addEventListener("click", () => openRepairConfirmDialog({ retry: true }));
$("repairConfirmCancel").addEventListener("click", () => closeRepairDialog({ restoreFocus: true }));
$("repairConfirmSubmit").addEventListener("click", () => executePendingRepair());
$("repairConfirmDialog").addEventListener("cancel", (e) => {
  // Escape — treat as Cancel, never submit.
  e.preventDefault();
  if (!repairSubmitting) closeRepairDialog({ restoreFocus: true });
});

(async function boot() {
  try {
    await loadAccounts();
  } catch (e) {
    $("accountMeta").textContent = String(e);
  }
  updateStages();
  const params = new URLSearchParams(location.search);
  const runId = params.get("run");
  if (runId) {
    await loadRunById(runId);
  }
})();
