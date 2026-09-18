-- Paytm Saathi initial schema (Neon Postgres).
-- Money is integer paise. Dates are merchant-local calendar dates. Timestamps are timestamptz.
-- `seq` columns preserve insertion order where the domain depends on it.

CREATE TABLE merchant (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  default_cap_minor INTEGER NOT NULL DEFAULT 30000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE import_batch (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  checksum TEXT NOT NULL,
  source_name TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published', 'failed')),
  id_strategy TEXT NOT NULL CHECK (id_strategy IN ('file_payment_id', 'derived_id'))
);
CREATE UNIQUE INDEX ux_import_batch_checksum ON import_batch (merchant_id, checksum);

CREATE TABLE customer (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  external_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  contact_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX ux_customer_external ON customer (merchant_id, external_id);

CREATE TABLE consent (
  seq BIGSERIAL,
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  customer_id TEXT NOT NULL REFERENCES customer(id),
  state TEXT NOT NULL CHECK (state IN ('true', 'false', 'unknown')),
  source TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ix_consent_customer ON consent (merchant_id, customer_id, observed_at, seq);

CREATE TABLE payment (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  payment_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customer(id),
  paid_at TIMESTAMPTZ NOT NULL,
  local_date DATE NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  status TEXT NOT NULL CHECK (status IN ('settled', 'refunded', 'duplicate')),
  import_batch_id TEXT NOT NULL REFERENCES import_batch(id)
);
CREATE UNIQUE INDEX ux_payment_id ON payment (merchant_id, payment_id);
CREATE INDEX ix_payment_customer ON payment (merchant_id, customer_id, local_date, status);

CREATE TABLE campaign (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  intent TEXT NOT NULL,
  status TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  as_of DATE NOT NULL,
  window_start DATE,
  window_end DATE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ix_campaign_merchant ON campaign (merchant_id, created_at);

CREATE TABLE campaign_version (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  version INTEGER NOT NULL,
  proposal JSONB NOT NULL,
  rule_result JSONB NOT NULL,
  cohort_hash TEXT NOT NULL,
  cap_minor INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  ai_source TEXT NOT NULL CHECK (ai_source IN ('model', 'template_fallback')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX ux_campaign_version ON campaign_version (campaign_id, version);

CREATE TABLE campaign_recipient (
  seq BIGSERIAL,
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES campaign_version(id),
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  customer_id TEXT NOT NULL REFERENCES customer(id),
  assignment_group TEXT NOT NULL CHECK (assignment_group IN ('campaign', 'holdout')),
  eligibility_reason TEXT NOT NULL,
  reward_amount_minor INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_recipient_version_customer ON campaign_recipient (version_id, customer_id);

CREATE TABLE campaign_exclusion (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES campaign_version(id),
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  customer_id TEXT NOT NULL REFERENCES customer(id),
  reason TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_exclusion_version_customer ON campaign_exclusion (version_id, customer_id);

CREATE TABLE campaign_approval (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  version_id TEXT NOT NULL REFERENCES campaign_version(id),
  version INTEGER NOT NULL,
  approver TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired')),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX ux_approval_version ON campaign_approval (version_id);
CREATE UNIQUE INDEX ux_approval_idempotency ON campaign_approval (merchant_id, idempotency_key);

CREATE TABLE delivery_job (
  seq BIGSERIAL,
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  version_id TEXT NOT NULL REFERENCES campaign_version(id),
  recipient_id TEXT NOT NULL REFERENCES campaign_recipient(id),
  customer_id TEXT NOT NULL REFERENCES customer(id),
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'PROCESSING', 'DELIVERED', 'FAILED', 'UNKNOWN', 'NEEDS_REVIEW', 'CANCELLED')),
  provider_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  -- Mock-provider demo scaffolding: a stable slot so the rehearsed demo always
  -- exercises one timeout-then-status-check and one terminal failure.
  scenario_slot INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX ux_job_version_recipient ON delivery_job (version_id, recipient_id);
CREATE UNIQUE INDEX ux_job_provider_key ON delivery_job (provider_key);
CREATE INDEX ix_job_status ON delivery_job (status, lease_expires_at);

CREATE TABLE delivery_attempt (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES delivery_job(id),
  attempt_no INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  provider_message_id TEXT,
  provider_response TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX ux_attempt_job_no ON delivery_attempt (job_id, attempt_no);

CREATE TABLE outcome (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  campaign_id TEXT NOT NULL REFERENCES campaign(id),
  version_id TEXT NOT NULL REFERENCES campaign_version(id),
  customer_id TEXT NOT NULL REFERENCES customer(id),
  assignment_group TEXT NOT NULL CHECK (assignment_group IN ('campaign', 'holdout')),
  returned BOOLEAN NOT NULL,
  return_at TIMESTAMPTZ,
  settled_amount_minor INTEGER NOT NULL DEFAULT 0,
  reward_cost_minor INTEGER NOT NULL DEFAULT 0,
  opted_out BOOLEAN NOT NULL DEFAULT false,
  window_start DATE NOT NULL,
  window_end DATE NOT NULL,
  simulated BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX ux_outcome_unique ON outcome (campaign_id, customer_id, window_start);

CREATE TABLE audit_event (
  seq BIGSERIAL,
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  campaign_id TEXT,
  version_id TEXT,
  job_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  old_state TEXT,
  new_state TEXT,
  request_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ix_audit_campaign ON audit_event (merchant_id, campaign_id, created_at, seq);
