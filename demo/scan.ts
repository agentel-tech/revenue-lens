// Bounded read-only tenant scan. Classifies current payment lines via
// check_conditions only — never writes, never builds repair plans.
// Caps work by DISTINCT payment_line_id (not accounts, not per-feature rows).
// Scope: permitted synthetic cast accounts for the tenant — not production discovery.

import type {
  CaseStatus,
  CheckResult,
  InvestigationContext,
  LineCheck,
  PaymentLine,
  ReadCoverage,
  SourceRef,
} from "../src/contracts.ts";
import type { CastMemberPrivate } from "./cast.ts";

export const SCAN_MAX_PAYMENT_LINES = 50;
export const SCAN_CONCURRENCY = 2;
/**
 * Overall wall-clock budget for a single scan request (ms).
 * Live Zetaris check_conditions is ~10s/account at concurrency 2; 45s only covered ~8/31.
 * Still hard-bounded with max 50 distinct payment lines and concurrency ≤ 2.
 */
export const SCAN_TIMEOUT_MS = 180_000;

export type ScanLineStatus = CaseStatus | "unknown";

export interface ScanRow {
  tenantId: string;
  billingAccountId: string;
  name: string;
  paymentLineId: string;
  feature: string | null;
  status: ScanLineStatus;
  reason: string;
  /** Record identifiers from check refs / context (not seed kind/role). */
  recordIds: string[];
  complete: boolean;
}

export interface ScanResult {
  tenantId: string;
  observedAt: string;
  /**
   * Inventory scope: only permitted synthetic cast accounts for this tenant were
   * considered — not a claim to discover all production customers.
   */
  scopeNote: string;
  partial: boolean;
  partialReasons: string[];
  /** Distinct permitted synthetic billing accounts with at least one retained row. */
  distinctCustomers: number;
  /** Distinct payment lines with explicit paid+in-force evidence (conditions or payment facts). */
  distinctPaidInForceLines: number;
  /** Distinct retained payment_line_id count. */
  scannedLines: number;
  candidateLines: number;
  unknownLines: number;
  maxPaymentLines: number;
  concurrency: number;
  /** Actual wall-clock budget applied for this scan (ms). */
  timeoutMs: number;
  rows: ScanRow[];
  /** Never true — scan never proposes writes. */
  repairsProposed: false;
}

export type ScanCheckRunner = (
  tenantId: string,
  billingAccountId: string,
  observedAt: Date,
) => Promise<{
  check: CheckResult;
  context?: InvestigationContext;
  coverage?: ReadCoverage[];
}>;

export const SCAN_SCOPE_NOTE =
  "Scanned permitted synthetic cast accounts for this tenant — not a discovery of all production customers.";

function clampInt(n: number | undefined, lo: number, hi: number, fallback: number): number {
  const v = n === undefined || !Number.isFinite(n) ? fallback : Math.floor(n);
  return Math.min(hi, Math.max(lo, v));
}

function refIds(refs: SourceRef[]): string[] {
  const out: string[] = [];
  for (const r of refs) {
    for (const [k, v] of Object.entries(r.key)) {
      if (/(_id|Id)$/.test(k) || k === "payment_line_id" || k === "entitlement_id" || k === "mapping_id") {
        out.push(`${k}=${v}`);
      }
    }
  }
  return [...new Set(out)];
}

function coverageComplete(coverage: ReadCoverage[] | undefined, context?: InvestigationContext): boolean {
  const cov = coverage ?? context?.coverage ?? [];
  if (!cov.length) return false;
  return cov.every((c) => c.complete);
}

function paymentFactInForce(pay: PaymentLine, observedAt: Date): boolean {
  if (pay.status !== "paid") return false;
  const start = Date.parse(pay.periodStart);
  const end = Date.parse(pay.periodEnd);
  const at = observedAt.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= at && at <= end;
}

/**
 * Paid/in-force only from explicit evidence:
 * - payment.paid AND payment.period_active both present and passed, or
 * - actual PaymentLine fact: status paid and period covers observedAt.
 * No non-not_entitled fallback. Read-error placeholders never qualify.
 */
export function isPaidInForceLine(
  line: LineCheck,
  observedAt: Date,
  context?: InvestigationContext,
): boolean {
  const paid = line.conditions.find((c) => c.id === "payment.paid");
  const period = line.conditions.find((c) => c.id === "payment.period_active");
  if (paid && period && paid.passed && period.passed) return true;
  const fact = context?.payments?.find((p) => p.paymentLineId === line.paymentLineId);
  if (fact && paymentFactInForce(fact, observedAt)) return true;
  return false;
}

function lineReason(line: LineCheck): string {
  if (line.missing.length) return line.missing.join("; ");
  const failed = line.conditions.filter((c) => !c.passed);
  if (failed.length) return failed.map((c) => `${c.id}: ${c.detail}`).join("; ");
  const passed = line.conditions.filter((c) => c.passed);
  return passed.length ? passed[passed.length - 1].detail : `status ${line.status}`;
}

const STATUS_RANK: Record<ScanLineStatus, number> = {
  repair_candidate: 5,
  needs_verification: 4,
  processing: 3,
  consistent: 2,
  not_entitled: 1,
  unknown: 0,
};

function preferLine(a: LineCheck, b: LineCheck): LineCheck {
  const ra = STATUS_RANK[a.status] ?? 0;
  const rb = STATUS_RANK[b.status] ?? 0;
  if (rb > ra) return b;
  if (ra > rb) return a;
  return b.conditions.length > a.conditions.length ? b : a;
}

/** Collapse multi-feature rows to DISTINCT payment_line_id. */
function distinctLinesByPaymentId(lines: LineCheck[]): LineCheck[] {
  const byId = new Map<string, LineCheck>();
  for (const line of lines) {
    const id = line.paymentLineId;
    if (!id) continue;
    const prev = byId.get(id);
    byId.set(id, prev ? preferLine(prev, line) : line);
  }
  return [...byId.values()];
}

function dedupeAccounts(members: CastMemberPrivate[]): CastMemberPrivate[] {
  const seen = new Set<string>();
  const out: CastMemberPrivate[] = [];
  for (const m of members) {
    const key = `${m.tenantId}\0${m.billingAccountId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

type RaceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "error"; error: Error };

/** Race a single account read against remaining overall deadline. */
async function raceRemaining<T>(promise: Promise<T>, remainingMs: number): Promise<RaceResult<T>> {
  if (remainingMs <= 0) return { ok: false, reason: "timeout" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value): RaceResult<T> => ({ ok: true, value }),
        (err): RaceResult<T> => ({
          ok: false,
          reason: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        }),
      ),
      new Promise<RaceResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Scan one tenant’s permitted cast accounts with check_conditions.
 * Stops after SCAN_MAX_PAYMENT_LINES distinct payment lines (or overall timeout).
 * Each account read is raced against the remaining overall deadline; after timeout
 * no further accounts are scheduled (at most `concurrency` ≤ 2 may still be in
 * flight — their late results are ignored). Inject `runner` in tests.
 */
export async function scanTenant(opts: {
  tenantId: string;
  members: CastMemberPrivate[];
  observedAt: string | Date;
  runner: ScanCheckRunner;
  maxPaymentLines?: number;
  concurrency?: number;
  timeoutMs?: number;
  now?: () => number;
}): Promise<ScanResult> {
  const maxLines = clampInt(opts.maxPaymentLines, 1, SCAN_MAX_PAYMENT_LINES, SCAN_MAX_PAYMENT_LINES);
  const concurrency = clampInt(opts.concurrency, 1, SCAN_CONCURRENCY, SCAN_CONCURRENCY);
  const timeoutMs = clampInt(opts.timeoutMs, 1, Number.MAX_SAFE_INTEGER, SCAN_TIMEOUT_MS);
  const now = opts.now ?? Date.now;
  const started = now();
  const deadline = started + timeoutMs;
  const observedAt =
    opts.observedAt instanceof Date ? opts.observedAt : new Date(opts.observedAt);
  const observedAtIso = observedAt.toISOString();

  const empty = (reasons: string[]): ScanResult => ({
    tenantId: opts.tenantId,
    observedAt: observedAtIso,
    scopeNote: SCAN_SCOPE_NOTE,
    partial: true,
    partialReasons: reasons,
    distinctCustomers: 0,
    distinctPaidInForceLines: 0,
    scannedLines: 0,
    candidateLines: 0,
    unknownLines: 0,
    maxPaymentLines: maxLines,
    concurrency,
    timeoutMs,
    rows: [],
    repairsProposed: false,
  });

  const scoped = dedupeAccounts(opts.members.filter((m) => m.tenantId === opts.tenantId));
  if (!scoped.length) return empty(["no permitted cast members for tenant"]);

  const retained: ScanRow[] = [];
  const retainedPaymentIds = new Set<string>();
  const paidInForce = new Set<string>();
  const partialReasons: string[] = [];
  let hitCap = false;
  let timedOut = false;
  let stopScheduling = false;

  const tryRetain = (row: ScanRow, countAsPaid: boolean): boolean => {
    if (retainedPaymentIds.has(row.paymentLineId)) return false;
    if (retainedPaymentIds.size >= maxLines) {
      hitCap = true;
      stopScheduling = true;
      return false;
    }
    retainedPaymentIds.add(row.paymentLineId);
    retained.push(row);
    if (countAsPaid) paidInForce.add(row.paymentLineId);
    if (retainedPaymentIds.size >= maxLines) {
      hitCap = true;
      stopScheduling = true;
    }
    return true;
  };

  const retainReadError = (member: CastMemberPrivate, message: string) => {
    if (timedOut || hitCap) return;
    partialReasons.push(`read error for ${member.billingAccountId}: ${message}`);
    tryRetain(
      {
        tenantId: member.tenantId,
        billingAccountId: member.billingAccountId,
        name: member.name,
        paymentLineId: member.paymentLineId,
        feature: null,
        status: "unknown",
        reason: `read error: ${message}`,
        recordIds: [],
        complete: false,
      },
      false, // never count read-error placeholders as paid
    );
  };

  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      if (stopScheduling || timedOut || hitCap) return;
      if (now() >= deadline) {
        timedOut = true;
        stopScheduling = true;
        return;
      }
      if (retainedPaymentIds.size >= maxLines) {
        hitCap = true;
        stopScheduling = true;
        return;
      }

      const i = next++;
      if (i >= scoped.length) return;
      const member = scoped[i];

      const remaining = deadline - now();
      if (remaining <= 0) {
        timedOut = true;
        stopScheduling = true;
        return;
      }

      // Race this account read against remaining overall budget. Underlying
      // fixed read tools may still finish after we move on; at most `concurrency`
      // (≤2) stay in flight, and late results are ignored below.
      const raced = await raceRemaining(
        opts.runner(member.tenantId, member.billingAccountId, observedAt),
        remaining,
      );

      if (!raced.ok && raced.reason === "timeout") {
        timedOut = true;
        stopScheduling = true;
        // No placeholder — never-resolved reads are not observed inventory.
        return;
      }

      // Late in-flight: another worker already stopped the scan — ignore.
      if (timedOut || hitCap) return;

      if (!raced.ok && raced.reason === "error") {
        retainReadError(member, raced.error.message);
        continue;
      }

      if (!raced.ok) return;

      const result = raced.value;
      if (result.check.tenantId !== member.tenantId || result.check.billingAccountId !== member.billingAccountId) {
        partialReasons.push(`scope mismatch for ${member.billingAccountId}`);
        tryRetain(
          {
            tenantId: member.tenantId,
            billingAccountId: member.billingAccountId,
            name: member.name,
            paymentLineId: member.paymentLineId,
            feature: null,
            status: "unknown",
            reason: "check result tenant/account scope mismatch",
            recordIds: [],
            complete: false,
          },
          false,
        );
        continue;
      }

      const complete = coverageComplete(result.coverage, result.context);
      if (!complete) partialReasons.push(`incomplete coverage for ${member.billingAccountId}`);

      const rawLines = result.check.lines.length
        ? result.check.lines
        : [
            {
              paymentLineId: member.paymentLineId,
              feature: null as string | null,
              status: "needs_verification" as CaseStatus,
              conditions: [],
              missing: ["no payment lines returned by check_conditions"],
            },
          ];

      for (const line of distinctLinesByPaymentId(rawLines)) {
        if (timedOut || hitCap) break;
        if (retainedPaymentIds.has(line.paymentLineId)) continue;

        const ids = refIds(line.conditions.flatMap((c) => c.refs));
        if (line.paymentLineId) ids.unshift(`payment_line_id=${line.paymentLineId}`);
        const status: ScanLineStatus = complete ? line.status : "unknown";
        const paid = complete && isPaidInForceLine(line, observedAt, result.context);
        tryRetain(
          {
            tenantId: member.tenantId,
            billingAccountId: member.billingAccountId,
            name: member.name,
            paymentLineId: line.paymentLineId,
            feature: line.feature,
            status,
            reason: complete ? lineReason(line) : `incomplete coverage; ${lineReason(line)}`,
            recordIds: [...new Set(ids)],
            complete,
          },
          paid,
        );
      }
    }
  });

  await Promise.all(workers);

  if (hitCap) partialReasons.push(`payment-line cap ${maxLines} reached`);
  if (timedOut) {
    partialReasons.push(
      `scan time budget ${timeoutMs}ms exceeded; stopped scheduling (at most ${concurrency} in-flight reads may still finish and are ignored)`,
    );
  }

  // Summary strictly from retained processed rows.
  const uniqueReasons = [...new Set(partialReasons)];
  const customers = new Set(retained.map((r) => r.billingAccountId));
  const candidateLines = retained.filter((r) => r.status === "repair_candidate").length;
  const unknownLines = retained.filter((r) => r.status === "unknown" || !r.complete).length;
  const partial = uniqueReasons.length > 0 || unknownLines > 0 || hitCap || timedOut;

  return {
    tenantId: opts.tenantId,
    observedAt: observedAtIso,
    scopeNote: SCAN_SCOPE_NOTE,
    partial,
    partialReasons: uniqueReasons,
    distinctCustomers: customers.size,
    distinctPaidInForceLines: paidInForce.size,
    scannedLines: retained.length,
    candidateLines,
    unknownLines,
    maxPaymentLines: maxLines,
    concurrency,
    timeoutMs,
    rows: retained,
    repairsProposed: false,
  };
}
