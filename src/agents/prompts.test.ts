import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOMAIN_POLICY,
  checkerSystemPrompt,
  investigatorSystemPrompt,
} from "./prompts.ts";

const POLICY_MARKERS = [
  "GENERIC DOMAIN POLICY",
  "unique workspace mapping",
  "observedAt",
  "needs_verification",
  "does not create new entitlements",
  "check_conditions",
  "not proof of a causal claim",
  "Compare timestamps exactly",
  "Do not infer before/after from free-text narration",
  "inaccessible historical snapshots",
  "repeating the same unchanged queries",
];

test("DOMAIN_POLICY encodes generic eligibility rules (not a case verdict)", () => {
  for (const m of POLICY_MARKERS) {
    assert.match(DOMAIN_POLICY, new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(DOMAIN_POLICY, /Acme Freight|ba-d2063d|stale_mapping role/i);
});

test("investigator and checker system prompts both include the same domain policy", () => {
  const inv = investigatorSystemPrompt({
    tenantId: "t-northwind",
    billingAccountId: "ba-1",
    observedAt: "2026-10-23T12:00:00.000Z",
  });
  const chk = checkerSystemPrompt();
  assert.ok(inv.includes(DOMAIN_POLICY));
  assert.ok(chk.includes(DOMAIN_POLICY));
  for (const m of POLICY_MARKERS) {
    assert.match(inv, new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(chk, new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(inv, /evidenceId/);
  assert.match(chk, /evidenceId/);
  assert.match(inv, /when generic policy eligibility is challenged/i);
  assert.match(chk, /Prefer suggesting check_conditions/i);
  assert.match(chk, /equally policy-valid/i);
  assert.match(inv, /paymentEvidenceId/);
  assert.match(inv, /entitlementEvidenceId/);
  assert.match(inv, /currentMappingEvidenceId/);
  assert.match(inv, /Do not emit expectedVersion/);
});
