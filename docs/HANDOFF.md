# Handoff: data layer and repair executor → agents, Why card, UI

Ownership while this split holds:

| Owner | Paths |
|---|---|
| Claude | `infra/`, `seed/`, `services/sandbox/`, `src/data/`, `src/repair/`, `src/contracts.ts`, `src/sources.ts`, `src/zetaris.ts`, `package.json`, lockfile, SQL |
| Codex (in Cursor) | `src/agents/`, `src/why/`, `src/memory/`, demo UI directory |

Changes to `src/contracts.ts`, dependencies or SQL go through Claude so both sides build against one version.

## What agents can call

`src/data/tools.ts` exports `investigationTools`, `toolSpecs()` (OpenAI function format, ready for `src/llm-client.ts`) and `callTool(name, args, observedAt)`.

| Tool | Reads | Returns |
|---|---|---|
| `get_payments` | billing, via Zetaris | `PaymentLine[]` with features from `product_features` |
| `get_workspace_mappings` | workspace_map, via Zetaris | every `WorkspaceMapping` row (overlaps kept) and `MigrationEvent[]` |
| `get_entitlement_trail` | billing ⟕ entitlements, one Zetaris cross-source query | `Entitlement[]`, `GrantEvent[]` (with `mappingVersionUsed`), `ProvisioningRun[]`; paid lines without an entitlement are kept |
| `check_conditions` | all of the above | `CheckResult`: per condition pass/fail + refs + `missing`, and the full `InvestigationContext` |

Every fact carries a `SourceRef` (source, table, key, version, via). Every read reports `ReadCoverage`; `complete: false` means nothing may be concluded as absent.

Tools take only `tenant_id` and `billing_account_id` (validated). There is no free-SQL tool and agents must not import `src/zetaris.ts` directly: that client runs DDL.

The checks are gates, not the investigation. They do not pick hypotheses or decide what to read next; the agents do. `check_conditions` is there for the checker role and for the executor's own re-check.

## Statuses

| Status | Meaning | Executor |
|---|---|---|
| `consistent` | entitlement is on the currently mapped workspace | refuses |
| `processing` | paid within `PROVISIONING_WINDOW_MINUTES` (30, `src/rules.ts`), no entitlement yet | refuses |
| `repair_candidate` | entitlement on a workspace the account held under an earlier mapping; exactly one current mapping | may apply |
| `needs_verification` | missing, incomplete or conflicting evidence | refuses |
| `not_entitled` | payment failed/refunded or period over | refuses |

## Repair

```ts
import { makeRetargetPlan } from "./src/repair/plan.ts";
import { executeRetarget } from "./src/repair/executor.ts";
const plan = makeRetargetPlan({ tenantId, billingAccountId, paymentLineId, entitlementId, feature,
  fromWorkspace, toWorkspace, expectedVersion, mappingVersion, evidenceRefs, proposedBy: "investigator" });
const receipt = await executeRetarget(plan); // ExecutionReceipt
```

The executor re-reads all three sources directly (not via Zetaris), re-runs the checks, and requires the plan to match those facts. One transaction: lock, re-verify, receipt, retarget + version bump, append grant event. Outcomes: `applied`, `replayed` (same intent and payload, original receipt), `rejected` with `payload_conflict | version_changed | not_repair_candidate | plan_mismatch | invalid_plan`. The DB role can update only `target_workspace_id`, `version`, `updated_at`.

To verify the outcome for the customer, call the sandbox service (`GET /w/:workspace/features/reports` with the cast token from `seed/out/<seed>.json`). It reads the entitlements source directly.

## Commands

```bash
npm run infra:up && npm run seed && npm run sandbox
npm test                    # 12 unit tests, no DB
npm run check:access        # real 200/403 per cast member
npm run check:facts         # Zetaris vs direct facts agree; statuses as expected
npm run verify:recovery     # 403 -> repair -> 200, idempotency, refusals (reseeds as "recovery")
npm run seed                # back to the demo dataset afterwards
```

`processing` is time-relative: reseed shortly before a demo or recording.
