// Loads every cast member's facts twice (via Zetaris, and directly), runs the
// deterministic checks on both, and compares: the two read paths must agree,
// and the status must match what the seed expects. Exit 1 on any mismatch.
//
//   npx tsx scripts/check-facts.ts [--seed demo]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkContext } from "../src/data/checks.ts";
import { directContext, ZetarisFacts } from "../src/data/context.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const seed = args.includes("--seed") ? args[args.indexOf("--seed") + 1] : "demo";
const { cast, observed_at } = JSON.parse(fs.readFileSync(path.join(root, "seed/out", `${seed}.json`), "utf8"));
// Pinned to the seed's observation time: "processing" is time-relative, so a
// fixed instant keeps this check deterministic. Reseed to move it.
const observedAt = new Date(observed_at);

const zf = new ZetarisFacts();
let failed = 0;
for (const c of cast) {
  const [viaZ, direct] = await Promise.all([zf.context(c.tenant_id, c.billing_account_id, observedAt), directContext(c.tenant_id, c.billing_account_id, observedAt)]);
  const sz = checkContext(viaZ).lines.map((l) => l.status).join(",");
  const sd = checkContext(direct).lines.map((l) => l.status).join(",");
  const strip = (x: unknown) => JSON.stringify(x, (k, v) => (k === "ref" || k === "coverage" || k === "observedAt" ? undefined : v));
  const sameFacts = strip(viaZ) === strip(direct);
  const ok = sz === c.expected_finding && sd === c.expected_finding && sameFacts;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${String(c.role).padEnd(24)} ${String(c.kind).padEnd(17)} zetaris=${sz.padEnd(18)} direct=${sd.padEnd(18)} want=${c.expected_finding}${sameFacts ? "" : "  FACTS DIFFER"}`);
}
console.log(failed ? `${failed} mismatches` : `all ${cast.length} customers agree across both read paths`);
process.exit(failed ? 1 : 0);
