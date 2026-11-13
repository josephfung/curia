-- 125_principal_mail_dedupe.sql
--
-- Cross-mailbox message dedupe for inbox triage (#2475, D4). A message addressed to two of the
-- principal's mailboxes arrives in each inbox with a different Nylas id but the same RFC
-- Message-ID header. Triage claims the header here; the first claim wins and the message is
-- triaged once. The header is stored normalised (trimmed, no angle brackets, lowercase).
-- Rows older than the 30-day retention are expired: a later claim replaces them, and a sweep
-- deletes them.

-- Up Migration

CREATE TABLE principal_mail_dedupe (
  message_id_header TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  nylas_message_id TEXT NOT NULL,
  triaged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_principal_mail_dedupe_triaged_at ON principal_mail_dedupe (triaged_at);

-- Down Migration

DROP TABLE IF EXISTS principal_mail_dedupe;
