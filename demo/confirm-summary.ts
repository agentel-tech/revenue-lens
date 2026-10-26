/**
 * DOM-free repair confirmation view-model.
 * Used by unit tests; the operator UI fills the same fields into an in-page <dialog>
 * (never window.confirm — native dialogs freeze embedded CDP recording).
 */

export interface RepairPlanFields {
  intentKey: string;
  entitlementId: string;
  expectedVersion: number;
  fromWorkspace: string;
  toWorkspace: string;
  feature: string;
  paymentLineId: string;
}

export interface RepairConfirmView {
  runId: string;
  intentKey: string;
  tenantId: string;
  billingAccountId: string;
  accountName: string;
  accountLabel: string;
  entitlementId: string;
  expectedVersion: number;
  entitlementLabel: string;
  fromWorkspace: string;
  toWorkspace: string;
  workspaceLabel: string;
  feature: string;
  paymentLineId: string;
  isRetry: boolean;
  title: string;
}

/** True only when every field needed for an inspectable confirm step is present. */
export function repairConfirmViewIsComplete(v: Partial<RepairConfirmView> | null | undefined): v is RepairConfirmView {
  if (!v) return false;
  return (
    typeof v.runId === "string" &&
    v.runId.length > 0 &&
    typeof v.intentKey === "string" &&
    v.intentKey.length > 0 &&
    typeof v.tenantId === "string" &&
    v.tenantId.length > 0 &&
    typeof v.billingAccountId === "string" &&
    v.billingAccountId.length > 0 &&
    typeof v.entitlementId === "string" &&
    v.entitlementId.length > 0 &&
    typeof v.expectedVersion === "number" &&
    Number.isSafeInteger(v.expectedVersion) &&
    v.expectedVersion >= 1 &&
    typeof v.fromWorkspace === "string" &&
    v.fromWorkspace.length > 0 &&
    typeof v.toWorkspace === "string" &&
    v.toWorkspace.length > 0 &&
    typeof v.feature === "string" &&
    v.feature.length > 0
  );
}

export function buildRepairConfirmView(opts: {
  runId: string;
  tenantId: string;
  billingAccountId: string;
  accountName?: string;
  plan: RepairPlanFields;
  isRetry?: boolean;
}): RepairConfirmView {
  const name = (opts.accountName ?? "").trim() || opts.billingAccountId;
  const plan = opts.plan;
  const isRetry = !!opts.isRetry;
  return {
    runId: opts.runId,
    intentKey: plan.intentKey,
    tenantId: opts.tenantId,
    billingAccountId: opts.billingAccountId,
    accountName: name,
    accountLabel: `${name} · ${opts.tenantId} / ${opts.billingAccountId}`,
    entitlementId: plan.entitlementId,
    expectedVersion: plan.expectedVersion,
    entitlementLabel: `${plan.entitlementId} · v${plan.expectedVersion}`,
    fromWorkspace: plan.fromWorkspace,
    toWorkspace: plan.toWorkspace,
    workspaceLabel: `${plan.fromWorkspace} → ${plan.toWorkspace}`,
    feature: plan.feature,
    paymentLineId: plan.paymentLineId,
    isRetry,
    title: isRetry ? "Retry same repair" : "Confirm repair",
  };
}

/** Payload the browser may send after the second explicit click — never auto-accept. */
export function repairConfirmRequestBody(view: RepairConfirmView): { confirm: true; intentKey: string } {
  if (!repairConfirmViewIsComplete(view)) {
    throw new Error("incomplete repair confirmation view");
  }
  return { confirm: true, intentKey: view.intentKey };
}
