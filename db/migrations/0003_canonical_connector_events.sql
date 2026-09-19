-- Canonical connector boundary. External providers keep their own event IDs;
-- Saathi retains them to make retries safe and auditable.

ALTER TABLE consent ADD COLUMN purpose TEXT NOT NULL DEFAULT 'merchant_reengagement';
ALTER TABLE consent ADD COLUMN channel TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE consent ADD COLUMN expires_at TIMESTAMPTZ;
ALTER TABLE consent ADD COLUMN source_event_id TEXT;
CREATE INDEX ix_consent_scope ON consent (merchant_id, customer_id, purpose, observed_at, seq);

CREATE TABLE connector_event (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchant(id),
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('payment', 'consent')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX ux_connector_event_identity
  ON connector_event (merchant_id, source, source_event_id, event_type);
CREATE INDEX ix_connector_event_merchant
  ON connector_event (merchant_id, received_at DESC);
