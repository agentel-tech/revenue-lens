// Business rules that decide classifications. Fixed numbers, written down, so
// "still processing" is never a model's judgement call.

// A paid line with no entitlement yet counts as normal processing for this
// long after paid_at. After it, a missing or misdirected grant is a finding.
export const PROVISIONING_WINDOW_MINUTES = 30;

export function withinProvisioningWindow(paidAt: Date, observedAt: Date): boolean {
  return observedAt.getTime() - paidAt.getTime() < PROVISIONING_WINDOW_MINUTES * 60_000;
}
