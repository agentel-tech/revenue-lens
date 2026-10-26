// Revenue Lens operator demo — 127.0.0.1:8791
//   node --import tsx demo/server.ts
//
// Tokens never leave the server. Repair executes only after explicit confirmation
// of the exact persisted plan (run id + intentKey). No automatic / batch repair.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { attachRepairOutcome, runAllowsConfirmRepair, runInvestigation } from "../src/agents/workflow.ts";
import { createLockedToolRunner } from "../src/agents/locked-tools.ts";
import type { InvestigationRun, ModelCaller, ToolRunner } from "../src/agents/types.ts";
import { callTool } from "../src/data/tools.ts";
import { lessonFromRun, openMemory } from "../src/memory/store.ts";
import { executeRetarget } from "../src/repair/executor.ts";
import { buildWhyCard } from "../src/why/card.ts";
import { whyCardToHtml } from "../src/why/html.ts";
import { whyCardToMarkdown } from "../src/why/markdown.ts";
import type { CheckResult, InvestigationContext } from "../src/contracts.ts";
import {
  distinctTenants,
  featuredMembers,
  findMember,
  loadCast,
  membersForTenant,
  publicAccounts,
  type CastMemberPrivate,
} from "./cast.ts";
import { probeCustomerAccess } from "./probe.ts";
import { RunStore } from "./run-store.ts";
import {
  SCAN_CONCURRENCY,
  SCAN_MAX_PAYMENT_LINES,
  SCAN_TIMEOUT_MS,
  scanTenant,
  type ScanCheckRunner,
} from "./scan.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const PUBLIC = path.join(here, "public");
const PORT = Number(process.env.DEMO_PORT) || 8791;
const HOST = "127.0.0.1";
const SANDBOX_URL = process.env.SANDBOX_URL ?? "http://127.0.0.1:8790";
const ORIGIN = `http://${HOST}:${PORT}`;
/** Bounded request body size for demo mutations (bytes). */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024;

if (fs.existsSync(path.join(root, ".env"))) {
  process.loadEnvFile(path.join(root, ".env"));
}

/** Explicit static allowlist only — no private file routes or directory browsing. */
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "application/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/brand/logo.png": { file: "brand/logo.png", type: "image/png" },
  "/brand/Jersey20-Regular.woff2": { file: "brand/Jersey20-Regular.woff2", type: "font/woff2" },
};

export interface DemoDeps {
  cast: CastMemberPrivate[];
  observedAt: string;
  store: RunStore;
  model?: ModelCaller | null;
  tools?: ToolRunner;
  execute?: typeof executeRetarget;
  probe?: typeof probeCustomerAccess;
  sandboxUrl?: string;
  /** Default memory toggle when the client omits memoryEnabled (tests often false). */
  memoryEnabled?: boolean;
  /** Isolated H-MEM persist directory (paired tests; does not erase default memory). */
  memoryDir?: string;
  /** Injected check_conditions runner for scan unit tests. */
  scanRunner?: ScanCheckRunner;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds 32KB limit");
    this.name = "BodyTooLargeError";
  }
}

export function readBody(req: http.IncomingMessage, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      req.removeAllListeners("data");
      // Keep the socket alive so the handler can still write 413; drain remaining bytes.
      req.on("data", () => undefined);
      req.on("end", () => undefined);
      reject(err);
    };
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        fail(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/** Reject cross-origin mutation requests. Same-origin browser Origin must match. */
export function rejectCrossOriginMutation(req: http.IncomingMessage, res: http.ServerResponse, origin = ORIGIN): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
  const o = req.headers.origin;
  if (o && o !== origin) {
    json(res, 403, { error: "cross-origin mutation rejected" });
    return true;
  }
  return false;
}

function sanitizeRun(run: InvestigationRun) {
  return {
    runId: run.runId,
    tenantId: run.tenantId,
    billingAccountId: run.billingAccountId,
    observedAt: run.observedAt,
    status: run.status,
    model: run.model,
    proposedRoles: run.proposedRoles,
    identityBound: run.identityBound,
    eligibility: run.eligibility,
    finding: run.finding,
    checkerFeedback: run.checkerFeedback,
    followUpActions: run.followUpActions,
    coverage: run.coverage,
    lastCheck: run.lastCheck,
    repairPlan: run.repairPlan,
    repairConfirmed: run.repairConfirmed,
    receipt: run.receipt,
    accessProbe: run.accessProbe,
    trace: run.trace,
    memoryEnabled: run.memoryEnabled === true,
    recalledLessonIds: run.recalledLessonIds ?? [],
    suggestedPriority: run.suggestedPriority,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function defaultScanRunner(): ScanCheckRunner {
  return async (tenantId, billingAccountId, observedAt) => {
    const fact = (await callTool(
      "check_conditions",
      { tenant_id: tenantId, billing_account_id: billingAccountId },
      observedAt,
    )) as { check: CheckResult; context: InvestigationContext };
    return { check: fact.check, context: fact.context, coverage: fact.context?.coverage };
  };
}

export function createDemoServer(deps: DemoDeps): http.Server {
  const sandboxUrl = deps.sandboxUrl ?? SANDBOX_URL;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", ORIGIN);

      if (rejectCrossOriginMutation(req, res)) return;

      const readJsonBody = async (): Promise<string> => {
        try {
          return await readBody(req);
        } catch (e) {
          if (e instanceof BodyTooLargeError) {
            json(res, 413, { error: e.message });
            throw e;
          }
          throw e;
        }
      };

      if (req.method === "GET" && STATIC[url.pathname]) {
        const s = STATIC[url.pathname];
        const file = path.join(PUBLIC, s.file);
        if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "Content-Type": s.type });
        res.end(fs.readFileSync(file));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/healthz") {
        return json(res, 200, { ok: true, origin: ORIGIN });
      }

      if (req.method === "GET" && url.pathname === "/api/accounts") {
        // Featured (non-cohort) for the default selector; cohort remains available to scan via full cast.
        const featured = featuredMembers(deps.cast);
        return json(res, 200, {
          observedAt: deps.observedAt,
          accounts: publicAccounts(featured),
          tenants: distinctTenants(deps.cast),
          environment: "Agentel Revenue Lab",
          note: "Synthetic lab cast. Tokens stay on the server. Seed roles are not exposed to the browser.",
          scanBudget: {
            maxPaymentLines: SCAN_MAX_PAYMENT_LINES,
            concurrency: SCAN_CONCURRENCY,
            timeoutMs: SCAN_TIMEOUT_MS,
          },
        });
      }

      if (req.method === "GET" && url.pathname === "/api/memory") {
        const tenantId = String(url.searchParams.get("tenantId") ?? "").trim();
        if (!tenantId) return json(res, 400, { error: "tenantId query required" });
        if (!deps.cast.some((m) => m.tenantId === tenantId)) {
          return json(res, 400, { error: "tenant not in permitted seeded cast" });
        }
        try {
          const mem = await openMemory(deps.memoryDir);
          const recalled = await mem.recallPriority(`investigate ${tenantId} entitlement workspace mapping`, {
            tenantId,
            limit: 8,
          });
          return json(res, 200, {
            tenantId,
            memorySource: mem.source,
            embeddingDisclosure: mem.embeddingDisclosure,
            suggestedPriority: recalled.suggestedPriority,
            lessons: recalled.memories.map((m) => ({
              id: m.id,
              sourceRunId: m.sourceRunId ?? null,
              tenantId: m.tenantId ?? tenantId,
              relevance: m.relevance,
              // Hint text already tenant-tagged; still never includes tokens or model prose as fact.
              summary: m.content.slice(0, 400),
            })),
          });
        } catch (e) {
          return json(res, 503, { error: `memory unavailable: ${(e as Error).message}` });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/scan") {
        let raw: string;
        try {
          raw = await readJsonBody();
        } catch (e) {
          if (e instanceof BodyTooLargeError) return;
          throw e;
        }
        let body: { tenantId?: string };
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          return json(res, 400, { error: "invalid JSON" });
        }
        const tenantId = String(body.tenantId ?? "").trim();
        if (!tenantId) return json(res, 400, { error: "tenantId required" });
        const scoped = membersForTenant(deps.cast, tenantId);
        if (!scoped.length) return json(res, 400, { error: "tenant not in permitted seeded cast" });

        const result = await scanTenant({
          tenantId,
          members: scoped,
          observedAt: deps.observedAt,
          runner: deps.scanRunner ?? defaultScanRunner(),
          maxPaymentLines: SCAN_MAX_PAYMENT_LINES,
        });
        return json(res, 200, {
          ...result,
          note: result.partial
            ? "Partial scan — see partialReasons, scanned/candidate/unknown counts. No repairs proposed."
            : "Scan complete. No repairs proposed; open one account to investigate.",
        });
      }

      /** Scoped read-only sandbox probe — status/body only; never returns cast tokens. */
      if (req.method === "POST" && url.pathname === "/api/probe-access") {
        let raw: string;
        try {
          raw = await readJsonBody();
        } catch (e) {
          if (e instanceof BodyTooLargeError) return;
          throw e;
        }
        let body: { tenantId?: string; billingAccountId?: string; workspace?: string; feature?: string };
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          return json(res, 400, { error: "invalid JSON" });
        }
        const tenantId = String(body.tenantId ?? "");
        const billingAccountId = String(body.billingAccountId ?? "");
        const member = findMember(deps.cast, tenantId, billingAccountId);
        if (!member) return json(res, 400, { error: "tenant/account not in permitted seeded cast" });

        const workspace = String(body.workspace ?? member.currentWorkspace).trim();
        const feature = String(body.feature ?? "reports").trim() || "reports";
        if (!workspace) return json(res, 400, { error: "workspace required" });
        // Scope: only the cast member's current workspace (no arbitrary workspace probing).
        if (workspace !== member.currentWorkspace) {
          return json(res, 400, { error: "workspace not in scope for this account" });
        }

        const probeFn = deps.probe ?? probeCustomerAccess;
        const accessProbe = await probeFn({
          baseUrl: sandboxUrl,
          workspace,
          feature,
          token: member.token,
        });
        return json(res, 200, {
          tenantId: member.tenantId,
          billingAccountId: member.billingAccountId,
          workspace: accessProbe.workspace,
          feature: accessProbe.feature,
          status: accessProbe.status,
          body: accessProbe.body,
          at: accessProbe.at,
        });
      }

      if (req.method === "POST" && url.pathname === "/api/investigate") {
        let raw: string;
        try {
          raw = await readJsonBody();
        } catch (e) {
          if (e instanceof BodyTooLargeError) return;
          throw e;
        }
        let body: { tenantId?: string; billingAccountId?: string; memoryEnabled?: unknown };
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          return json(res, 400, { error: "invalid JSON" });
        }
        const tenantId = String(body.tenantId ?? "");
        const billingAccountId = String(body.billingAccountId ?? "");
        const member = findMember(deps.cast, tenantId, billingAccountId);
        if (!member) return json(res, 400, { error: "tenant/account not in permitted seeded cast" });

        // Per-request toggle; when omitted, fall back to deps.memoryEnabled (default on in live demo).
        const memoryEnabled =
          body.memoryEnabled === undefined ? deps.memoryEnabled !== false : body.memoryEnabled === true;

        let suggestedPriority: string[] | undefined;
        let recalledLessonIds: string[] = [];
        if (memoryEnabled) {
          try {
            const mem = await openMemory(deps.memoryDir);
            const recalled = await mem.recallPriority(`investigate ${tenantId} entitlement workspace mapping`, {
              tenantId,
            });
            if (recalled.suggestedPriority.length) suggestedPriority = recalled.suggestedPriority;
            recalledLessonIds = recalled.memories.map((m) => m.id);
          } catch {
            /* H-MEM optional if vendor missing */
          }
        }

        const run = await runInvestigation(
          {
            tenantId: member.tenantId,
            billingAccountId: member.billingAccountId,
            observedAt: deps.observedAt,
            suggestedPriority,
            memoryEnabled,
            recalledLessonIds,
          },
          {
            model: deps.model,
            tools: deps.tools ?? createLockedToolRunner(member.tenantId, member.billingAccountId),
          },
        );
        deps.store.put(run);

        if (memoryEnabled) {
          try {
            const lesson = lessonFromRun(run);
            if (lesson) {
              const mem = await openMemory(deps.memoryDir);
              await mem.rememberLesson(lesson);
            }
          } catch {
            /* ignore */
          }
        }

        const why = buildWhyCard(run);
        return json(res, 200, {
          run: sanitizeRun(run),
          why,
          whyHtml: whyCardToHtml(why),
          whyMarkdown: whyCardToMarkdown(why),
        });
      }

      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && runMatch) {
        const run = deps.store.get(decodeURIComponent(runMatch[1]));
        if (!run) return json(res, 404, { error: "run not found" });
        const member = findMember(deps.cast, run.tenantId, run.billingAccountId);
        if (!member) return json(res, 404, { error: "run account not in permitted cast" });
        const why = buildWhyCard(run);
        return json(res, 200, {
          account: publicAccounts([member])[0],
          run: sanitizeRun(run),
          why,
          whyHtml: whyCardToHtml(why),
          whyMarkdown: whyCardToMarkdown(why),
        });
      }

      const confirmMatch = /^\/api\/runs\/([^/]+)\/confirm-repair$/.exec(url.pathname);
      if (req.method === "POST" && confirmMatch) {
        const runId = decodeURIComponent(confirmMatch[1]);
        const run = deps.store.get(runId);
        if (!run) return json(res, 404, { error: "run not found" });
        if (!run.repairPlan) return json(res, 400, { error: "run has no persisted repair plan" });

        let raw: string;
        try {
          raw = await readJsonBody();
        } catch (e) {
          if (e instanceof BodyTooLargeError) return;
          throw e;
        }
        let body: { confirm?: unknown; intentKey?: unknown; plan?: unknown };
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          return json(res, 400, { error: "invalid JSON" });
        }

        if (body.plan !== undefined) {
          return json(res, 400, { error: "client-supplied plan rejected; confirm the persisted plan by intentKey only" });
        }
        if (body.confirm !== true) {
          return json(res, 400, { error: "explicit confirm:true required" });
        }
        if (typeof body.intentKey !== "string" || body.intentKey !== run.repairPlan.intentKey) {
          return json(res, 400, { error: "intentKey must exactly match the persisted server-side plan" });
        }

        // Independent of any stale stored plan: model uncertainty is never write permission.
        const allowed = runAllowsConfirmRepair(run);
        if (!allowed.ok) {
          return json(res, 400, { error: allowed.reason });
        }

        const member = findMember(deps.cast, run.tenantId, run.billingAccountId);
        if (!member) return json(res, 400, { error: "cast member missing for run" });

        const execute = deps.execute ?? executeRetarget;
        const receipt = await execute(run.repairPlan);
        const probeFn = deps.probe ?? probeCustomerAccess;
        const accessProbe = await probeFn({
          baseUrl: sandboxUrl,
          workspace: run.repairPlan.toWorkspace,
          feature: run.repairPlan.feature,
          token: member.token,
        });
        const next = attachRepairOutcome(run, receipt, accessProbe);
        deps.store.update(runId, next);

        const why = buildWhyCard(next);
        return json(res, 200, {
          run: sanitizeRun(next),
          why,
          whyHtml: whyCardToHtml(why),
          whyMarkdown: whyCardToMarkdown(why),
        });
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      console.error(err);
      return json(res, 500, { error: "internal error" });
    }
  });
}

export function startDemoServer(deps?: Partial<DemoDeps>): http.Server {
  const castBundle = loadCast("demo");
  const server = createDemoServer({
    cast: castBundle.members,
    observedAt: castBundle.observedAt,
    store: new RunStore(),
    memoryEnabled: true,
    ...deps,
  });
  server.listen(PORT, HOST, () => {
    console.log(`Revenue Lens demo on http://${HOST}:${PORT}`);
    console.log(`Sandbox probe target: ${SANDBOX_URL}`);
    console.log("Tokens stay on the server. Confirm repair with run id + intentKey only.");
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  startDemoServer();
}
