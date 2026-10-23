// Registers the three sandbox sources in Zetaris as separate datasources,
// using the read-only zetaris_reader role, then runs one cross-source query to
// prove the join happens in Zetaris. Safe to re-run: drops and recreates.
//
//   npx tsx scripts/register-sources.ts

import { credentials, SOURCES, type SourceName } from "../src/sources.ts";
import { records, Zetaris } from "../src/zetaris.ts";

const TABLES: Record<SourceName, string[]> = {
  billing: ["products", "product_features", "billing_accounts", "payment_lines"],
  workspace_map: ["workspace_mappings", "migration_events"],
  entitlements: ["entitlements", "grant_events", "provisioning_runs", "repair_receipts"],
};

const z = new Zetaris();
const reader = credentials("reader");

for (const [source, tables] of Object.entries(TABLES) as [SourceName, string[]][]) {
  const ds = `rl_${source}`;
  const { container, database } = SOURCES[source];
  await z.sql(`DROP DATASOURCE ${ds}`).catch(() => undefined); // absent on first run
  await z.sql(
    `CREATE DATASOURCE ${ds} DESCRIBE BY "revenue-lens.sandbox.${source}" OPTIONS (` +
      `jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://${container}:5432/${database}", ` +
      `username "${reader.user}", password "${reader.password}", fetchsize "1000")`,
  );
  for (const t of tables) await z.sql(`REGISTER DATASOURCE TABLE '${t}' FROM ${ds}`);
  const counts = await Promise.all(tables.map(async (t) => `${t}=${(await z.sql(`SELECT count(*) AS n FROM ${ds}.${t}`)).data[0][0]}`));
  console.log(`${ds}: ${counts.join(" ")}`);
}

// Cross-source check: for every paid line, where did the entitlement go, and
// which workspace does the authoritative mapping say is current? Three
// datasources, one query, joined by Zetaris.
const r = await z.sql(`
  SELECT p.tenant_id, p.billing_account_id, p.payment_line_id,
         e.target_workspace_id AS granted_to, g.mapping_version_used,
         m.workspace_id AS current_workspace, m.mapping_version AS current_version
    FROM rl_billing.payment_lines p
    JOIN rl_entitlements.entitlements e
      ON e.tenant_id = p.tenant_id AND e.payment_line_id = p.payment_line_id
    JOIN rl_entitlements.grant_events g
      ON g.tenant_id = e.tenant_id AND g.entitlement_id = e.entitlement_id AND g.event_type = 'grant'
    JOIN rl_workspace_map.workspace_mappings m
      ON m.tenant_id = p.tenant_id AND m.billing_account_id = p.billing_account_id AND m.valid_to IS NULL
   WHERE p.status = 'paid' AND e.target_workspace_id <> m.workspace_id
   ORDER BY p.tenant_id, p.billing_account_id`);
console.log(`\ncross-source mismatches (granted_to <> current mapping): ${r.total} rows in ${r.timeUsed} ms`);
for (const row of records(r)) {
  console.log(`  ${row.tenant_id} ${row.billing_account_id} granted_to=${row.granted_to} (mapping v${row.mapping_version_used}) current=${row.current_workspace} (v${row.current_version})`);
}
