-- Up Migration
--
-- Issue #1101: email_accounts — console-managed, provider-agnostic email mailboxes.
--
-- Replaces the YAML channel_accounts.email path. Each row is a mailbox the agent owns,
-- polls, and replies from. The row holds only the non-secret identity of the account;
-- the Nylas grant is sensitive and lives in the secrets vault at
-- channel.email.<name>.nylas_grant_id (ADR-020), not here. The shared nylas_api_key is
-- one-per-Nylas-app and stays at channel.email.nylas_api_key.
--
-- provider is the transport discriminator ('nylas' today). It is the seam for future
-- IMAP/other providers — adding one is a new provider value + adapter + vault-key
-- convention, with no change to this table.

CREATE TABLE email_accounts (
  -- Logical account id. Stamped onto inbound.message as accountId for reply routing,
  -- and used as the poll high-water-mark key (<name>.last_seen_at). Constrained to
  -- [a-z0-9][a-z0-9_-]* at the application layer because it is embedded in the dotted
  -- vault key channel.email.<name>.nylas_grant_id.
  name        TEXT        PRIMARY KEY,
  self_email  TEXT        NOT NULL,
  provider    TEXT        NOT NULL DEFAULT 'nylas',
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT        NOT NULL DEFAULT 'web-console',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS email_accounts;
