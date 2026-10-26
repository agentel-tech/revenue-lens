import { test } from "node:test";
import assert from "node:assert/strict";
import type { SourceRef } from "../contracts.ts";
import { runInvestigation } from "./workflow.ts";
import type { ModelCaller, ToolRunner } from "./types.ts";
import { investigatorSystemPrompt, checkerSystemPrompt } from "./prompts.ts";

/**
 * Mocked scenario: grant.at is AFTER migration effective_at; entitlement on prior workspace;
 * unique current mapping at observedAt. Checker challenges eligibility → investigator
 * chooses check_conditions (genuine decision path), then proposes with gate-backed suggestion.
 * No forced rejection and no preplanned sequence beyond what this injected model chooses.
 */

const T = "2026-10-23T12:00:00.000Z";
const migrationAt = "2026-10-13T12:00:00.000Z";
const grantAt = "2026-10-14T12:00:00.000Z"; // AFTER migration

const payRef: SourceRef = {
  source: "billing",
  table: "payment_lines",
  key: { payment_line_id: "pl-1", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 1,
};
const mapOld: SourceRef = {
  source: "workspace_map",
  table: "workspace_mappings",
  key: { mapping_id: "m-old", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 1,
};
const mapNew: SourceRef = {
  source: "workspace_map",
  table: "workspace_mappings",
  key: { mapping_id: "m-new", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 2,
};
const entRef: SourceRef = {
  source: "entitlements",
  table: "entitlements",
  key: { entitlement_id: "ent-1", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 1,
};
const grantRef: SourceRef = {
  source: "entitlements",
  table: "grant_events",
  key: { event_id: "g1", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 1,
};
const migRef: SourceRef = {
  source: "workspace_map",
  table: "migration_events",
  key: { migration_id: "mig-1", tenant_id: "t-northwind" },
  via: "zetaris",
  version: 1,
};

function contextBundle() {
  return {
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    observedAt: T,
    payments: [
      {
        tenantId: "t-northwind",
        billingAccountId: "ba-1",
        paymentLineId: "pl-1",
        productId: "pro",
        features: ["reports"],
        periodStart: "2026-10-10T00:00:00.000Z",
        periodEnd: "2099-01-01T00:00:00.000Z",
        amountCents: 100,
        currency: "USD",
        status: "paid" as const,
        paidAt: "2026-10-10T00:00:00.000Z",
        recordVersion: 1,
        ref: payRef,
      },
    ],
    mappings: [
      {
        tenantId: "t-northwind",
        billingAccountId: "ba-1",
        mappingId: "m-old",
        workspaceId: "ws-old",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: migrationAt,
        mappingVersion: 1,
        sourceRef: "SIGNUP",
        ref: mapOld,
      },
      {
        tenantId: "t-northwind",
        billingAccountId: "ba-1",
        mappingId: "m-new",
        workspaceId: "ws-new",
        validFrom: migrationAt,
        validTo: null,
        mappingVersion: 2,
        sourceRef: "MIG-1",
        ref: mapNew,
      },
    ],
    migrations: [
      {
        tenantId: "t-northwind",
        billingAccountId: "ba-1",
        migrationId: "mig-1",
        fromWorkspace: "ws-old",
        toWorkspace: "ws-new",
        effectiveAt: migrationAt,
        sourceRef: "MIG-1",
        ref: migRef,
      },
    ],
    entitlements: [
      {
        tenantId: "t-northwind",
        entitlementId: "ent-1",
        paymentLineId: "pl-1",
        feature: "reports",
        periodStart: "2026-10-10T00:00:00.000Z",
        periodEnd: "2099-01-01T00:00:00.000Z",
        targetWorkspaceId: "ws-old",
        status: "active" as const,
        version: 1,
        updatedAt: grantAt,
        ref: entRef,
      },
    ],
    grants: [
      {
        tenantId: "t-northwind",
        eventId: "g1",
        entitlementId: "ent-1",
        eventType: "grant" as const,
        targetWorkspaceId: "ws-old",
        mappingVersionUsed: 1,
        actor: "provisioning",
        at: grantAt,
        receiptId: null,
        ref: grantRef,
      },
    ],
    runs: [],
    coverage: [
      { tool: "get_payments", via: "zetaris" as const, rows: 1, complete: true },
      { tool: "get_workspace_mappings", via: "zetaris" as const, rows: 2, complete: true },
      { tool: "get_entitlement_trail", via: "zetaris" as const, rows: 1, complete: true },
      { tool: "check_conditions", via: "zetaris" as const, rows: 1, complete: true },
    ],
  };
}

function repairCheck() {
  return {
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    observedAt: T,
    lines: [
      {
        paymentLineId: "pl-1",
        feature: "reports",
        status: "repair_candidate" as const,
        missing: [],
        conditions: [
          {
            id: "entitlement.on_current_workspace",
            passed: false,
            detail: "entitlement targets ws-old; mapping says ws-new",
            refs: [entRef, mapNew],
          },
          {
            id: "mapping.unique_current",
            passed: true,
            detail: "current workspace ws-new",
            refs: [mapNew],
          },
          {
            id: "grant.used_stale_mapping",
            passed: true,
            detail: `grant at ${grantAt} used v1, valid until ${migrationAt}`,
            refs: [grantRef, mapOld],
          },
        ],
      },
    ],
  };
}

test("prompts embed domain policy for both roles before workflow scenario", () => {
  assert.ok(investigatorSystemPrompt({ tenantId: "t", billingAccountId: "b", observedAt: T }).includes("GENERIC DOMAIN POLICY"));
  assert.ok(checkerSystemPrompt().includes("GENERIC DOMAIN POLICY"));
});

test("eligibility challenge leads investigator to check_conditions; grant-after-migration dates stay exact", async () => {
  const toolCalls: string[] = [];
  const tools: ToolRunner = async (name) => {
    toolCalls.push(name);
    const ctx = contextBundle();
    if (name === "get_payments") {
      return { payments: ctx.payments, coverage: [ctx.coverage[0]] };
    }
    if (name === "get_workspace_mappings") {
      return { mappings: ctx.mappings, migrations: ctx.migrations, coverage: [ctx.coverage[1]] };
    }
    if (name === "get_entitlement_trail") {
      return {
        entitlements: ctx.entitlements,
        grants: ctx.grants,
        runs: [],
        coverage: [ctx.coverage[2]],
      };
    }
    if (name === "check_conditions") {
      return { check: repairCheck(), context: ctx, coverage: ctx.coverage };
    }
    return { coverage: [{ tool: name, via: "zetaris", rows: 0, complete: true }] };
  };

  let inv = 0;
  let chk = 0;
  const seenInvSystem: string[] = [];
  const seenChkSystem: string[] = [];

  const model: ModelCaller = async (messages, opts) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    if (opts.role === "investigator") {
      seenInvSystem.push(system);
      inv++;
      if (inv === 1) {
        return {
          text: JSON.stringify({ kind: "call_tool", tool: "get_payments", seeking: "paid period" }),
          providerResponseId: null,
          model: "t",
          provider: "openai-compatible",
        };
      }
      if (inv === 2) {
        return {
          text: JSON.stringify({
            kind: "call_tool",
            tool: "get_workspace_mappings",
            seeking: "current vs prior mapping at observedAt",
          }),
          providerResponseId: null,
          model: "t",
          provider: "openai-compatible",
        };
      }
      if (inv === 3) {
        return {
          text: JSON.stringify({
            kind: "call_tool",
            tool: "get_entitlement_trail",
            seeking: "entitlement target and grant.at vs migration",
          }),
          providerResponseId: null,
          model: "t",
          provider: "openai-compatible",
        };
      }
      if (inv === 4) {
        // First finding: notes grant AFTER migration (exact timestamps), entitlement off current mapping
        return {
          text: JSON.stringify({
            kind: "propose_finding",
            finding: {
              conclusion: "entitlement on ws-old while unique current mapping is ws-new; grant.at is after migration",
              statusClaim: "repair_candidate",
              causalLinks: [
                {
                  cause: "entitlement target differs from unique current mapping at observedAt",
                  effect: "customer may lack feature on ws-new",
                  evidenceIds: ["e1", "e3", "e4"],
                  supported: false,
                },
              ],
              hypotheses: [
                {
                  id: "h-off-target",
                  claim: "entitlement should target current mapping under domain policy",
                  status: "active",
                  evidenceIds: ["e3", "e4"],
                },
              ],
              missingEvidence: ["deterministic gate confirmation"],
              evidenceIds: ["e1", "e3", "e4", "e5"],
            },
          }),
          providerResponseId: null,
          model: "t",
          provider: "openai-compatible",
        };
      }
      if (inv === 5) {
        // After checker asks for eligibility confirmation — choose check_conditions (not a replay of trail)
        return {
          text: JSON.stringify({
            kind: "call_tool",
            tool: "check_conditions",
            seeking: "resolve domain eligibility via deterministic gate and condition evidenceIds",
          }),
          providerResponseId: null,
          model: "t",
          provider: "openai-compatible",
        };
      }
      return {
        text: JSON.stringify({
          kind: "propose_finding",
          finding: {
            conclusion: "gate repair_candidate: retarget entitlement to current workspace",
            statusClaim: "repair_candidate",
            causalLinks: [
              {
                cause: "entitlement not on unique current mapping",
                effect: "retarget may be admissible",
                evidenceIds: ["e5", "e3"],
                supported: false,
              },
            ],
            hypotheses: [
              {
                id: "h-off-target",
                claim: "policy: entitlement should target current mapping",
                status: "supported",
                evidenceIds: ["e3", "e5"],
              },
              { id: "h-stale", claim: "grant used an expired mapping", conditionId: "grant.used_stale_mapping", paymentLineId: "pl-1", status: "supported", evidenceIds: ["e6", "e2"] },
              {
                id: "h-pre-mig-grant",
                claim: "grant occurred before migration",
                status: "excluded",
                exclusionReason: `grant.at ${grantAt} is after migration effective_at ${migrationAt}`,
                evidenceIds: ["e6", "e4"],
              },
            ],
            missingEvidence: [],
            evidenceIds: ["e1", "e3", "e4", "e5", "e6"],
            repairSuggestion: {
              paymentEvidenceId: "e1",
              entitlementEvidenceId: "e5",
              currentMappingEvidenceId: "e3",
            },
          },
        }),
        providerResponseId: null,
        model: "t",
        provider: "openai-compatible",
      };
    }

    seenChkSystem.push(system);
    chk++;
    if (chk === 1) {
      // Challenge eligibility under domain policy — suggest check_conditions, not impossible pre-migration snapshot
      return {
        text: JSON.stringify({
          kind: "need_evidence",
          feedback:
            "Confirm domain eligibility with check_conditions (unique current mapping and entitlement target). Do not invent a pre-migration grant snapshot; compare grant.at to migration effective_at from existing records.",
          suggestedTool: "check_conditions",
        }),
        providerResponseId: null,
        model: "t",
        provider: "openai-compatible",
      };
    }
    return {
      text: JSON.stringify({
        kind: "accept",
        note: "Gate and exact timestamps support off-current entitlement; causal cause remains inference",
      }),
      providerResponseId: null,
      model: "t",
      provider: "openai-compatible",
    };
  };

  const run = await runInvestigation(
    { tenantId: "t-northwind", billingAccountId: "ba-1", observedAt: T },
    { model, tools },
  );

  assert.ok(seenInvSystem[0]?.includes("GENERIC DOMAIN POLICY"));
  assert.ok(seenChkSystem[0]?.includes("GENERIC DOMAIN POLICY"));
  assert.equal(run.status, "completed");
  assert.ok(toolCalls.includes("check_conditions"));
  const trailIdx = toolCalls.indexOf("get_entitlement_trail");
  const checkIdx = toolCalls.indexOf("check_conditions");
  assert.ok(trailIdx >= 0 && checkIdx > trailIdx, "check_conditions follows eligibility challenge, not a preplanned-only path");
  assert.ok(run.followUpActions.some((a) => a.includes("check_conditions")));
  assert.ok(run.checkerFeedback?.some((f) => /check_conditions/i.test(f)));
  assert.ok(run.finding?.hypotheses.some((h) => h.status === "excluded" && h.exclusionReason?.includes(grantAt)));
  assert.ok(run.finding?.hypotheses.some((h) => h.exclusionReason?.includes(migrationAt)));
  assert.equal(run.finding?.causalLinks.every((l) => l.supported === false), true);
  assert.ok(run.repairPlan);
  assert.equal(run.repairPlan?.toWorkspace, "ws-new");
  // Must not loop the same trail tool after checker
  assert.equal(toolCalls.filter((t) => t === "get_entitlement_trail").length, 1);
});


// Regression: a checker accepting the proposed prose must not bypass exact condition consistency.
import { explanationIssues } from "./consistency.ts";
import { runAllowsConfirmRepair } from "./workflow.ts";
import { lessonFromRun } from "../memory/store.ts";
import type { FindingProposal } from "./types.ts";
function auditedFinding(status: "supported"|"excluded" = "supported"): FindingProposal {
  return {conclusion:"mapping diagnosis",statusClaim:"repair_candidate",causalLinks:[],missingEvidence:[],
    hypotheses:[{id:"cause",claim:"grant used expired mapping",conditionId:"grant.used_stale_mapping",paymentLineId:"pl-1",status,exclusionReason:status==='excluded'?"grant after mapping expired":undefined,refs:[grantRef,mapOld]}],
    evidenceRefs:[payRef,entRef,mapNew,grantRef,mapOld],repairSuggestion:{paymentLineId:"pl-1",entitlementId:"ent-1",feature:"reports",fromWorkspace:"ws-old",toWorkspace:"ws-new",expectedVersion:1,mappingVersion:2}};
}
test("exact stale-condition assessment rejects contrary dates, omission, wrong payment and incomplete refs",()=>{
  assert.deepEqual(explanationIssues(auditedFinding(),repairCheck()),[]);
  assert.match(explanationIssues(auditedFinding('excluded'),repairCheck()).join(),/excludes passed/);
  const f=auditedFinding(); f.hypotheses=[];
  assert.match(explanationIssues(f,repairCheck()).join(),/assessment required/);
  const wrong=auditedFinding();wrong.hypotheses[0].paymentLineId='pl-other';
  assert.ok(explanationIssues(wrong,repairCheck()).length);
  const missing=auditedFinding();missing.hypotheses[0].refs=[grantRef];
  assert.match(explanationIssues(missing,repairCheck()).join(),/not fully cited/);
  const noMapping=repairCheck();noMapping.lines[0].conditions[2].refs=[];
  assert.match(explanationIssues(auditedFinding(),noMapping).join(),/missing scoped/);
  const normal={...auditedFinding(),statusClaim:'consistent' as const,hypotheses:[],repairSuggestion:undefined};
  assert.deepEqual(explanationIssues(normal,repairCheck()),[]);
  const unknown={...normal,statusClaim:'needs_verification' as const};
  assert.deepEqual(explanationIssues(unknown,repairCheck()),[]);
  const foreign=repairCheck();foreign.lines[0].conditions[2].refs=[{...grantRef,key:{...grantRef.key,tenant_id:'other'}},mapOld];
  assert.match(explanationIssues(auditedFinding(),foreign).join(),/missing scoped/);
});
async function contradictionRun(correct:boolean,omit=false,refreshChanged=false){
  let inv=0, proposals=0;
  let reads=0;
  const tools:ToolRunner=async()=>{const ctx=contextBundle();const check=repairCheck();if(refreshChanged && ++reads===1)check.lines[0].conditions[2].passed=false;return {...ctx,check,context:ctx};};
  const model:ModelCaller=async(_messages,o)=>{
    let decision:unknown;
    if(o.role==='checker') decision={kind:'accept',note:'injected checker incorrectly trusts prose'};
    else if(++inv===1)decision={kind:'call_tool',tool:'check_conditions',seeking:'read all scoped facts and exact times'};
    else {proposals++;const supported=correct && proposals>1;
      decision={kind:'propose_finding',finding:{conclusion:'grant used expired mapping',statusClaim:'repair_candidate',causalLinks:[],
        hypotheses:omit?[]:[{id:'cause',claim:'grant used expired mapping',conditionId:'grant.used_stale_mapping',paymentLineId:'pl-1',status:supported?'supported':'excluded',exclusionReason:supported?undefined:'grant after mapping expiry',evidenceIds:['e6','e2']}],
        missingEvidence:[],evidenceIds:['e1','e2','e3','e5','e6'],repairSuggestion:{paymentEvidenceId:'e1',entitlementEvidenceId:'e5',currentMappingEvidenceId:'e3'}}};
    }
    return {text:JSON.stringify(decision),model:'injected',provider:'test',providerResponseId:null};
  };
  return runInvestigation({tenantId:'t-northwind',billingAccountId:'ba-1',observedAt:T},{model,tools});
}
test("contradiction remains bounded and cannot plan, confirm or learn",async()=>{
  const r=await contradictionRun(false);
  assert.notEqual(r.status,'completed');assert.equal(r.repairPlan,undefined);
  assert.equal(runAllowsConfirmRepair(r).ok,false);assert.equal(lessonFromRun(r),null);
  assert.ok(r.trace.some(t=>t.decision?.kind==='explanation_inconsistent'));
  assert.ok(r.trace.length<40);
});
test("omitting typed assessment cannot bypass correction",async()=>{
  const r=await contradictionRun(false,true);
  assert.notEqual(r.status,'completed');assert.equal(r.repairPlan,undefined);assert.equal(lessonFromRun(r),null);
});
test("real correction turn may reconcile condition; earlier contradictory trace remains",async()=>{
  const r=await contradictionRun(true);
  assert.equal(r.status,'completed');assert.ok(r.repairPlan);assert.equal(runAllowsConfirmRepair(r).ok,true);
  assert.ok(r.trace.some(t=>t.decision?.kind==='explanation_inconsistent'));
  assert.equal(r.finding!.hypotheses[0].status,'supported');
  assert.ok(lessonFromRun(r));
  const legacy={...r, finding:auditedFinding('excluded')};
  assert.equal(runAllowsConfirmRepair(legacy).ok,false);assert.equal(lessonFromRun(legacy),null);
});

test("fresh gate catches new contradiction even after checker accepted earlier observations",async()=>{
  const r=await contradictionRun(false,false,true);
  assert.ok(r.trace.some(t=>t.role==='checker' && t.decision?.kind==='accept'));
  assert.ok(r.trace.some(t=>t.role==='system' && t.decision?.kind==='explanation_inconsistent'));
  assert.equal(r.repairPlan,undefined);assert.equal(runAllowsConfirmRepair(r).ok,false);assert.equal(lessonFromRun(r),null);
});

test("negative proposition may be supported by a false condition; polarity never bypasses stale-cause assessment",()=>{
  const f=auditedFinding();const c=repairCheck();
  f.hypotheses.push({id:'off-target',claim:'entitlement is NOT on current workspace',conditionId:'entitlement.on_current_workspace',paymentLineId:'pl-1',conditionExpectedPassed:false,status:'supported',refs:[entRef,mapNew]});
  assert.deepEqual(explanationIssues(f,c),[]);
  f.hypotheses[1].conditionExpectedPassed=true;
  assert.match(explanationIssues(f,c).join(),/supports failed/);
  const inverted=auditedFinding();inverted.hypotheses[0].conditionExpectedPassed=false;
  assert.ok(explanationIssues(inverted,c).length);
});

import { parseFindingLegacy } from "./decisions.ts";
test("hypothesis polarity accepts only JSON boolean and survives historical parser",()=>{
  const f=auditedFinding();f.hypotheses[0].conditionExpectedPassed=false;
  assert.equal(parseFindingLegacy(f).hypotheses[0].conditionExpectedPassed,false);
  const bad=JSON.parse(JSON.stringify(f));bad.hypotheses[0].conditionExpectedPassed='false';
  assert.throws(()=>parseFindingLegacy(bad),/invalid boolean/);
});

test("nullable absent hypothesis annotation remains untyped and cannot bypass required assessment",()=>{
  const f=auditedFinding();const raw=JSON.parse(JSON.stringify(f));raw.hypotheses[0].conditionId=null;raw.hypotheses[0].paymentLineId=null;
  const parsed=parseFindingLegacy(raw);assert.equal(parsed.hypotheses[0].conditionId,undefined);
  assert.ok(explanationIssues(parsed,repairCheck()).some(s=>s.includes('assessment required')));
});

test("missing-row hypothesis can remain active only in unresolved findings, never authorize repair",()=>{
 const check=repairCheck();check.lines[0].status='needs_verification';check.lines[0].conditions[2].passed=false;check.lines[0].conditions[2].refs=[];
 const f=auditedFinding();f.statusClaim='needs_verification';f.missingEvidence=['authoritative mapping'];f.hypotheses[0].status='active';
 assert.deepEqual(explanationIssues(f,check),[]);
 f.hypotheses[0].status='supported';assert.ok(explanationIssues(f,check).length);
 f.hypotheses[0].status='active';f.statusClaim='repair_candidate';assert.ok(explanationIssues(f,check).length);
});

function missingMappingBundle() {
  const context=contextBundle(); context.mappings=[];context.migrations=[];
  context.coverage=context.coverage.map(c=>c.tool==='get_workspace_mappings'||c.tool==='get_migration_events'?{...c,rows:0}:c);
  const check=repairCheck();check.lines[0].status='needs_verification';check.lines[0].missing=['an authoritative workspace mapping for this account'];
  check.lines[0].conditions=[{id:'reads.complete',passed:true,detail:'all reads complete',refs:[]},{id:'mapping.unique_current',passed:false,detail:'no workspace mapping is valid now',refs:[]}];
  const finding=auditedFinding();finding.statusClaim='needs_verification';finding.missingEvidence=[...check.lines[0].missing];finding.repairSuggestion=undefined;
  finding.hypotheses=[{id:'missing',claim:'no authoritative current mapping in complete read',conditionId:'mapping.unique_current',paymentLineId:'pl-1',conditionExpectedPassed:false,status:'supported',refs:[]}];
  return {context,check,finding};
}
test('complete scoped zero-row read proves mapping absence only, never a repair target',()=>{
  const {context,check,finding}=missingMappingBundle();
  assert.deepEqual(explanationIssues(finding,check,context),[]);
  assert.ok(explanationIssues(finding,check).length,'without complete query evidence not proven');
  const incomplete={...context,coverage:context.coverage.map(c=>({...c,complete:false}))};
  assert.ok(explanationIssues(finding,check,incomplete).length);
  assert.ok(explanationIssues(finding,check,{...context,tenantId:'other'}).length);
  assert.ok(explanationIssues(finding,check,{...context,billingAccountId:'other'}).length);
  assert.ok(explanationIssues(finding,check,{...context,observedAt:'2000-01-01T00:00:00.000Z'}).length);
  assert.ok(explanationIssues(finding,check,{...context,mappings:contextBundle().mappings}).length);
  const downstream={...finding,hypotheses:[{...finding.hypotheses[0],conditionId:'entitlement.on_current_workspace'}]};
  assert.ok(explanationIssues(downstream,check,context).length,'unevaluated downstream condition cannot be asserted');
  assert.ok(explanationIssues({...finding,missingEvidence:[]},check,context).length);
  assert.ok(explanationIssues({...finding,statusClaim:'repair_candidate'},check,context).length);
});
test('missing mapping completes as evidenced needs_verification with no plan, confirmation or lesson',async()=>{
  const {context,check}=missingMappingBundle();let inv=0,checker=0;
  const tools:ToolRunner=async()=>({...context,check,context});
  const model:ModelCaller=async(_msgs,o)=>{
    let decision:unknown;
    if(o.role==='checker'){checker++;decision={kind:'accept',note:'complete scoped zero-row mapping read; no authoritative destination'};}
    else if(++inv===1)decision={kind:'call_tool',tool:'check_conditions',seeking:'current facts and read completeness'};
    else decision={kind:'propose_finding',finding:{conclusion:'No authoritative mapping; investigate mapping source before repair',statusClaim:'needs_verification',causalLinks:[],hypotheses:[{id:'absence',claim:'no unique current mapping',conditionId:'mapping.unique_current',conditionExpectedPassed:false,paymentLineId:'pl-1',status:'supported',evidenceIds:[]}],missingEvidence:check.lines[0].missing,evidenceIds:['e1']}};
    return {text:JSON.stringify(decision),provider:'test',model:'injected',providerResponseId:null};
  };
  const run=await runInvestigation({tenantId:'t-northwind',billingAccountId:'ba-1',observedAt:T},{tools,model});
  assert.equal(run.status,'completed');assert.equal(run.finding?.statusClaim,'needs_verification');assert.equal(run.eligibility,'needs_verification');
  assert.equal(run.repairPlan,undefined);assert.equal(runAllowsConfirmRepair(run).ok,false);assert.equal(lessonFromRun(run),null);
  assert.equal(inv,2);assert.equal(checker,1);assert.ok(run.finding?.missingEvidence.length);
});
