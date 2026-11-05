-- 119_structured_secrets_and_card_use.sql
--
-- Structured secrets (#1358, ADR-027, ADR-060). A saved credit card keeps its encrypted
-- number and CVV in `secrets` (json) and its non-secret facts (brand, last four, expiry,
-- cardholder, billing postal code) beside it in `user_secret_details`, so viewing a card
-- never decrypts anything. `schema` tags which structured type a key holds; `public_fields`
-- is present exactly when `schema` is.
--
-- card_use_requests records each approved-or-pending request to fill a card on a site
-- (ADR-027): one approval covers a bounded number of number/CVV fills in a conversation.

-- Up Migration

ALTER TABLE user_secret_details
  ADD COLUMN schema        TEXT CHECK (schema IN ('credit_card')),
  ADD COLUMN label         TEXT,
  ADD COLUMN public_fields JSONB,
  ADD CONSTRAINT user_secret_details_schema_public_fields_check
    CHECK ((schema IS NULL) = (public_fields IS NULL));

CREATE TABLE card_use_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_name        TEXT NOT NULL CHECK (starts_with(secret_name, 'user.')),
  -- The card's last four when the request was filed: a card replaced during the 30-minute
  -- window no longer matches the grant.
  last4              TEXT NOT NULL,
  site_domain        TEXT NOT NULL,
  conversation_id    TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  amount             TEXT NOT NULL,
  purpose            TEXT NOT NULL,
  origin             JSONB NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  approval_short_ref TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at        TIMESTAMPTZ,
  number_fills       INT NOT NULL DEFAULT 0,
  cvv_fills          INT NOT NULL DEFAULT 0
);

CREATE INDEX card_use_requests_approved_idx
  ON card_use_requests (secret_name, conversation_id, approved_at DESC)
  WHERE status = 'approved';

-- Down Migration

DROP TABLE IF EXISTS card_use_requests;

ALTER TABLE user_secret_details
  DROP CONSTRAINT IF EXISTS user_secret_details_schema_public_fields_check,
  DROP COLUMN IF EXISTS public_fields,
  DROP COLUMN IF EXISTS label,
  DROP COLUMN IF EXISTS schema;
