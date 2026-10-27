-- Up Migration
-- Host task of a follow-up drained into a live turn (#2018).
--
-- historyForLlm keeps a user row and the injected user rows after it as one
-- group. Without a column, that fact would have to be reconstructed from the
-- message body, and the body is attacker-controlled. A crafted inbound that
-- happened to match a marker would be kept or dropped as an injection, which
-- glues one contact's words onto another turn or drops a real question.
--
-- The writer sets this column. Readers do not infer it from content, and
-- contact-recent does not consult it: an injected row is still that sender's
-- words, and a null sender still marks the conversation shared. Treating the
-- column as "not a participant" would let a follow-up hide a second person
-- from the recall check.
--
-- Null means a normal turn. A non-null value is the host agent.task id the
-- row was drained into. No backfill: every existing row is a normal turn.
-- No index: readers load a conversation's active rows and look at the column
-- in process. Nothing queries by host task id.

ALTER TABLE working_memory
  ADD COLUMN injected_into_task_id text NULL;

-- Down Migration
-- Dropping the column loses which rows were drained into a host turn.
-- The turns themselves stay.
ALTER TABLE working_memory DROP COLUMN IF EXISTS injected_into_task_id;
