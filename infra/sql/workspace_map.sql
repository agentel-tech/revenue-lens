-- workspace_map: which workspace a billing account belongs to, and when.
-- Authoritative mapping with validity intervals; a migration closes one
-- mapping and opens the next.

CREATE TABLE workspace_mappings (
  tenant_id           text NOT NULL,
  mapping_id          text NOT NULL,
  billing_account_id  text NOT NULL,
  workspace_id        text NOT NULL,
  valid_from          timestamptz NOT NULL,
  valid_to            timestamptz,            -- NULL: still valid
  mapping_version     integer NOT NULL,
  source_ref          text NOT NULL,          -- e.g. the migration ticket
  recorded_at         timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, mapping_id),
  UNIQUE (tenant_id, billing_account_id, mapping_version),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
-- Overlaps are deliberately NOT prevented here: real mapping stores can hold
-- conflicting rows, and the investigation must detect them, not assume them away.

CREATE TABLE migration_events (
  tenant_id           text NOT NULL,
  migration_id        text NOT NULL,
  billing_account_id  text NOT NULL,
  from_workspace      text NOT NULL,
  to_workspace        text NOT NULL,
  effective_at        timestamptz NOT NULL,
  source_ref          text NOT NULL,
  PRIMARY KEY (tenant_id, migration_id)
);

CREATE ROLE zetaris_reader LOGIN PASSWORD :'reader_pw';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO zetaris_reader;
