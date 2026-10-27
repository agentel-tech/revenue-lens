# Zetaris USL: separate synthetic-data validation

Revenue Lens investigates why a paid customer may lose access after a workspace migration. In addition to its original read-only investigation queries, we separately built and tested a Zetaris Unified Semantic Layer (USL) and a data-quality (DQ) rule against three local PostgreSQL sources:

| Registered source | Relevant table | Role |
| --- | --- | --- |
| `rl_billing` | `payment_lines` | Synthetic payment status and account |
| `rl_workspace_map` | `workspace_mappings` | Effective workspace mapping |
| `rl_entitlements` | `entitlements` | Workspace receiving the entitlement |

The existing Investigator does **not** query the USL. This is a separate evidence and learning exercise, not a change to the application's investigation or repair path. The entire example uses synthetic sandbox data; it is not a production integration or a measured business outcome.

## Recorded validation

On 27 October 2026, local Zetaris 2.4.3.1 compiled and deployed the `revenue_access` model, activated its `access_alignment` table, and executed the `target_matches_current` DQ rule. `RUN DQ` returned **29 total rows, 26 valid and 3 invalid**; `SHOW DQ INVALID RECORD` returned 3 rows. Results are a point-in-time observation, not a guaranteed fixture count after a repair or reseed.

The activation query uses an inner join. It excludes payments without matching entitlements or active mappings, and multiple active mappings may produce multiple rows per payment. The counts represent **joined rows**, not customers, a complete scan, or repair candidates. A failed DQ row is an investigation lead, not permission to repair. The normal application performs additional evidence, consistency, version and human-approval checks.

## Reproduction

This is an optional demonstration against an already configured disposable sandbox. It requires admin privileges on a compatible local Zetaris instance and the three registered datasources. SQL statements are examples for a SQL editor or a client that preserves each complete statement; they are not executed automatically by the application.

Use a **fresh namespace and model name**. Inspect existing namespaces first. Never run `COMPILE ... DEPLOY` over an existing model or run registration, seed, cleanup, or drop commands against a valuable instance. Create missing parent namespaces only after checking the local installation. Do not paste credentials into SQL, code, logs, commits, or screenshots. Match observation time and seed state when comparing results. No source data is changed by the queries below, but the namespace, model, activation and DQ registration write Zetaris metadata.

Example with the names used for our disposable trial:

```sql
SHOW NAMESPACES OR TABLES IN lightning.metastore;
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.revenue_lens_trial;
```

If the local installation reports that parent namespace `metastore` is missing, consult the official setup documentation and initialize it only on your own disposable instance. We initialized that parent in our local environment before creating the child.

```sql
COMPILE USL revenue_access DEPLOY NAMESPACE lightning.metastore.revenue_lens_trial DDL
CREATE TABLE access_alignment (
  tenant_id STRING,
  payment_line_id STRING,
  billing_account_id STRING,
  granted_workspace STRING,
  current_workspace STRING
)
```

```sql
ACTIVATE USL TABLE lightning.metastore.revenue_lens_trial.revenue_access.access_alignment AS
SELECT p.tenant_id AS tenant_id,
       p.payment_line_id AS payment_line_id,
       p.billing_account_id AS billing_account_id,
       e.target_workspace_id AS granted_workspace,
       m.workspace_id AS current_workspace
FROM rl_billing.payment_lines p
JOIN rl_entitlements.entitlements e
  ON e.tenant_id = p.tenant_id AND e.payment_line_id = p.payment_line_id
JOIN rl_workspace_map.workspace_mappings m
  ON m.tenant_id = p.tenant_id
 AND m.billing_account_id = p.billing_account_id AND m.valid_to IS NULL
WHERE p.status = 'paid'
```

```sql
LOAD USL revenue_access NAMESPACE lightning.metastore.revenue_lens_trial;
SELECT COUNT(*) AS total FROM lightning.metastore.revenue_lens_trial.revenue_access.access_alignment;
SELECT COUNT(*) AS matches FROM lightning.metastore.revenue_lens_trial.revenue_access.access_alignment WHERE granted_workspace = current_workspace;
SELECT COUNT(*) AS mismatches FROM lightning.metastore.revenue_lens_trial.revenue_access.access_alignment WHERE granted_workspace <> current_workspace;
```

```sql
REGISTER DQ target_matches_current TABLE lightning.metastore.revenue_lens_trial.revenue_access.access_alignment AS granted_workspace = current_workspace;
RUN DQ target_matches_current TABLE lightning.metastore.revenue_lens_trial.revenue_access.access_alignment;
SHOW DQ INVALID RECORD target_matches_current TABLE lightning.metastore.revenue_lens_trial.revenue_access.access_alignment;
```

Example read-only source checks, run as separate statements:

```sql
SELECT COUNT(*) AS n FROM rl_billing.payment_lines;
SELECT status, COUNT(*) AS n FROM rl_billing.payment_lines GROUP BY status;
SELECT COUNT(*) AS n FROM rl_workspace_map.workspace_mappings;
SELECT COUNT(*) AS n FROM rl_workspace_map.workspace_mappings WHERE valid_to IS NULL;
SELECT COUNT(*) AS n FROM rl_entitlements.entitlements;
SELECT status, COUNT(*) AS n FROM rl_entitlements.entitlements GROUP BY status;
```

## Reflections

**Compared with direct connectors.** Zetaris provides a shared cross-source query surface. A hand-coded approach would need to manage retrieval and correlation between sources. We did not time either approach and cannot claim a numerical time saving. Provenance, authorization and repair checks still belong to the application.

**Where a semantic layer could help.** A reusable vocabulary for payment lines, active workspace mappings and entitlement targets could make repeated investigations easier to understand. The current model is a narrow synthetic experiment, not evidence that the application uses a USL in production.

**Potential product improvement.** It could be useful to declare effective-dated relationship constraints and inspect missing or overlapping mappings alongside their source records and observation time. This is a proposal to investigate, not an assertion that Zetaris lacks such a feature.

Official reference: [Zetaris Lightning Command Reference](https://github.com/zetaris/getting-started/blob/main/docs/guides/zetaris-lightning-sql-commands.md), sections on Unified Semantic Layer and Data Quality. The hackathon resource says the evaluation methodology will be applied flexibly; this document does not claim judge approval or that all scoring conditions have been satisfied.
