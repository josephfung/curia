-- 120_secret_capture_template.sql
--
-- Card capture links (#1358, ADR-060). A capture token can carry a template, so the public
-- form renders card fields (a new card, or the expiry and security code of a saved one)
-- instead of one text box. NULL is the existing single-value link. The column holds a
-- template name only, never any card data.

-- Up Migration

ALTER TABLE secret_capture_tokens
  ADD COLUMN capture_template TEXT
    CHECK (capture_template IN ('credit_card', 'credit_card_renewal'));

-- A renewal link names the card it was minted for by brand and last four (both public), so a
-- card later replaced under the same name does not take the old link's expiry and code.
ALTER TABLE secret_capture_tokens
  ADD COLUMN card_fingerprint TEXT;

-- Down Migration

ALTER TABLE secret_capture_tokens
  DROP COLUMN IF EXISTS card_fingerprint;

ALTER TABLE secret_capture_tokens
  DROP COLUMN IF EXISTS capture_template;
