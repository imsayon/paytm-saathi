-- Customer profile fields arrive from the source file or connector and stay
-- attached to the merchant's canonical customer record. The shortlist is a
-- merchant decision; it is never inferred by the model.
ALTER TABLE customer ADD COLUMN is_important BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customer ADD COLUMN importance_note TEXT;
ALTER TABLE customer ADD COLUMN profile JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX ix_customer_important ON customer (merchant_id, is_important);

-- Persist the exact merchant shortlist used to build a campaign version so
-- approval can re-check it against the current source data.
ALTER TABLE campaign_version ADD COLUMN selected_customer_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
