-- 124_principal_mailboxes_label_check.sql
--
-- A principal mailbox's label is shown in the console and in outage emails (#2475). The console
-- routes already cap it at 80 characters and refuse control characters; this keeps any other
-- writer to the same rule. Migration 123 is not edited: it may already be applied.

-- Up Migration

ALTER TABLE principal_mailboxes
  ADD CONSTRAINT principal_mailboxes_label_check
    CHECK (char_length(label) BETWEEN 1 AND 80 AND label !~ '[[:cntrl:]]');

-- Down Migration

ALTER TABLE principal_mailboxes DROP CONSTRAINT principal_mailboxes_label_check;
