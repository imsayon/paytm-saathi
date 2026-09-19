-- Identity linkage, outbound integration events, and merchant memory.
-- Data stays in Neon; Supabase Auth only supplies the user id and email.

ALTER TABLE merchant ADD COLUMN auth_user_id TEXT;
ALTER TABLE merchant ADD COLUMN email TEXT;
ALTER TABLE merchant ADD COLUMN phone TEXT;
ALTER TABLE merchant ADD COLUMN created_via TEXT NOT NULL DEFAULT 'seed';
CREATE UNIQUE INDEX ux_merchant_auth_user ON merchant (auth_user_id) WHERE auth_user_id IS NOT NULL;

-- Every domain transition that an automation (n8n) may react to. Written in
-- the same transaction as the change, delivered afterwards, retained forever.
CREATE TABLE integration_event (
  seq BIGSERIAL,
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  campaign_id TEXT,
  event TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ
);
CREATE INDEX ix_integration_event_pending ON integration_event (status, seq);
CREATE INDEX ix_integration_event_merchant ON integration_event (merchant_id, created_at);

-- What the planner may remember about a merchant: aggregate, decision-level
-- facts only (never a customer identifier or contact reference).
CREATE TABLE merchant_memory (
  seq BIGSERIAL,
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  campaign_id TEXT,
  kind TEXT NOT NULL,
  fact TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'rules',
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ix_merchant_memory ON merchant_memory (merchant_id, created_at);

-- Generated synthetic datasets, so a merchant can see which one is loaded.
CREATE TABLE synthetic_dataset (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  seed INTEGER NOT NULL,
  persona JSONB NOT NULL DEFAULT '{}'::jsonb,
  persona_source TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  customer_count INTEGER NOT NULL,
  import_batch_id TEXT REFERENCES import_batch(id),
  created_at TIMESTAMPTZ NOT NULL
);
