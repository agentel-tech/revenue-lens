-- billing: who paid, for which product and service period.
-- Authoritative for payment facts only; knows nothing about workspaces.

CREATE TABLE products (
  tenant_id   text NOT NULL,
  product_id  text NOT NULL,
  name        text NOT NULL,
  PRIMARY KEY (tenant_id, product_id)
);

-- Which features a product unlocks. Explicit, so entitlement checks never
-- guess the product -> feature relation.
CREATE TABLE product_features (
  tenant_id   text NOT NULL,
  product_id  text NOT NULL,
  feature     text NOT NULL,
  PRIMARY KEY (tenant_id, product_id, feature),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, product_id)
);

CREATE TABLE billing_accounts (
  tenant_id           text NOT NULL,
  billing_account_id  text NOT NULL,
  name                text NOT NULL,
  created_at          timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, billing_account_id)
);

CREATE TABLE payment_lines (
  tenant_id           text NOT NULL,
  payment_line_id     text NOT NULL,
  billing_account_id  text NOT NULL,
  product_id          text NOT NULL,
  period_start        timestamptz NOT NULL,
  period_end          timestamptz NOT NULL,
  amount_cents        integer NOT NULL CHECK (amount_cents >= 0),
  currency            char(3) NOT NULL,
  status              text NOT NULL CHECK (status IN ('paid', 'failed', 'refunded')),
  paid_at             timestamptz,
  record_version      integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, payment_line_id),
  FOREIGN KEY (tenant_id, billing_account_id) REFERENCES billing_accounts (tenant_id, billing_account_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, product_id),
  CHECK (period_end > period_start),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL) OR status = 'refunded')
);

CREATE ROLE zetaris_reader LOGIN PASSWORD :'reader_pw';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO zetaris_reader;
