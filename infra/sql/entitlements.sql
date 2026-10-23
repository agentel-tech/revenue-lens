-- entitlements: where each paid entitlement currently points, how it got
-- there, and receipts for any repair. Every table carries tenant_id and every
-- key includes it.

CREATE TABLE entitlements (
  tenant_id            text NOT NULL,
  entitlement_id       text NOT NULL,
  payment_line_id      text NOT NULL,
  feature              text NOT NULL,
  period_start         timestamptz NOT NULL,
  period_end           timestamptz NOT NULL,
  target_workspace_id  text NOT NULL,
  status               text NOT NULL CHECK (status IN ('active', 'revoked')),
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, entitlement_id),
  -- one entitlement per paid line, feature and period: a repair retargets,
  -- it never adds a second grant
  UNIQUE (tenant_id, payment_line_id, feature, period_start),
  CHECK (period_end > period_start)
);

-- Append-only history. The original grant keeps the target it actually used
-- and the mapping version it read, so a stale-mapping cause is provable.
CREATE TABLE grant_events (
  tenant_id             text NOT NULL,
  event_id              text NOT NULL,
  entitlement_id        text NOT NULL,
  event_type            text NOT NULL CHECK (event_type IN ('grant', 'retarget', 'revoke')),
  target_workspace_id   text NOT NULL,
  mapping_version_used  integer,
  actor                 text NOT NULL,
  at                    timestamptz NOT NULL,
  receipt_id            text,
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, entitlement_id) REFERENCES entitlements (tenant_id, entitlement_id)
);

-- The provisioning workflow's own run log: the "all green" signal.
CREATE TABLE provisioning_runs (
  tenant_id             text NOT NULL,
  run_id                text NOT NULL,
  payment_line_id       text NOT NULL,
  status                text NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  target_used           text,
  mapping_version_used  integer,
  started_at            timestamptz NOT NULL,
  finished_at           timestamptz,
  PRIMARY KEY (tenant_id, run_id)
);

CREATE TABLE repair_receipts (
  tenant_id            text NOT NULL,
  receipt_id           text NOT NULL,
  intent_key           text NOT NULL,
  payload_fingerprint  text NOT NULL,
  entitlement_id       text NOT NULL,
  from_workspace       text NOT NULL,
  to_workspace         text NOT NULL,
  expected_version     integer NOT NULL,
  new_version          integer NOT NULL,
  evidence_refs        jsonb NOT NULL,
  created_at           timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, intent_key)
);

-- Sandbox app identities: a fixed test token maps to one user, tenant and
-- workspace. Server-side, so a caller cannot claim a tenant by header.
CREATE TABLE sandbox_sessions (
  token         text PRIMARY KEY,
  tenant_id     text NOT NULL,
  user_id       text NOT NULL,
  workspace_id  text NOT NULL
);

-- Zetaris reads business facts only, never session tokens.
CREATE ROLE zetaris_reader LOGIN PASSWORD :'reader_pw';
GRANT SELECT ON entitlements, grant_events, provisioning_runs, repair_receipts TO zetaris_reader;

-- The sandbox service checks access; read-only.
CREATE ROLE rl_service LOGIN PASSWORD :'service_pw';
GRANT SELECT ON entitlements, sandbox_sessions TO rl_service;

-- The repair executor: may retarget an existing entitlement and append
-- history and receipts. No INSERT on entitlements, no DELETE anywhere.
CREATE ROLE rl_executor LOGIN PASSWORD :'executor_pw';
GRANT SELECT, UPDATE ON entitlements TO rl_executor;
GRANT SELECT, INSERT ON grant_events, repair_receipts TO rl_executor;
