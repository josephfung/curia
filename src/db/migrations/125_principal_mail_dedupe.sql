-- 125_principal_mail_dedupe.sql
--
-- Cross-mailbox message dedupe for inbox triage (#2475, D4). A message addressed to two of the
-- principal's mailboxes arrives in each inbox with a different Nylas id but the same RFC
-- Message-ID header. Triage claims the header here; the first claim wins and the message is
-- triaged once. The header is stored normalised (trimmed, no angle brackets, lowercase), together
-- with the normalised From address (R54): a Message-ID reused by another sender is a different
-- message, so it cannot suppress the real one.
-- Rows older than the 30-day retention are expired: a later claim replaces them, and a sweep
-- deletes them.

-- Up Migration

CREATE TABLE principal_mail_dedupe (
  message_id_header TEXT NOT NULL,
  from_address TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  nylas_message_id TEXT NOT NULL,
  triaged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id_header, from_address)
);

CREATE INDEX idx_principal_mail_dedupe_triaged_at ON principal_mail_dedupe (triaged_at);

-- Down Migration

DROP TABLE IF EXISTS principal_mail_dedupe;
