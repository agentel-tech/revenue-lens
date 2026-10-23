// Calls the sandbox service as each named cast member and compares the real
// HTTP status with the status the seed expects. Exit code 1 on any mismatch.
//
//   npx tsx scripts/check-access.ts [--seed demo] [--all]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const seed = args.includes("--seed") ? args[args.indexOf("--seed") + 1] : "demo";
const base = process.env.SANDBOX_URL ?? "http://127.0.0.1:8790";
const { cast } = JSON.parse(fs.readFileSync(path.join(root, "seed/out", `${seed}.json`), "utf8"));

let failed = 0;
for (const c of cast) {
  if (c.role === "cohort" && !args.includes("--all")) continue;
  const res = await fetch(`${base}/w/${c.current_workspace}/features/reports`, { headers: { Authorization: `Bearer ${c.token}` } });
  const body = await res.json();
  const ok = res.status === c.expected_access;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${String(c.role).padEnd(24)} ${String(c.kind).padEnd(17)} ${c.current_workspace}  got ${res.status} want ${c.expected_access}  ${body.reason ?? body.content ?? ""}`);
}
// identity must come from the session: a valid token cannot reach another workspace
const main = cast.find((c: { role: string }) => c.role === "main");
const other = cast.find((c: { role: string }) => c.role === "healthy");
const cross = await fetch(`${base}/w/${other.current_workspace}/features/reports`, { headers: { Authorization: `Bearer ${main.token}` } });
console.log(`${cross.status === 403 ? "PASS" : "FAIL"}  cross-workspace token use     got ${cross.status} want 403`);
if (cross.status !== 403) failed++;
const anon = await fetch(`${base}/w/${main.current_workspace}/features/reports`);
console.log(`${anon.status === 401 ? "PASS" : "FAIL"}  missing token                 got ${anon.status} want 401`);
if (anon.status !== 401) failed++;
process.exit(failed ? 1 : 0);
