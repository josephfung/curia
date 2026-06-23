-- Up Migration
-- Woken/derived task authorization, step 1 (#1125).
--
-- Persist the TaskOriginator (lineage) on the tasks row. The originator is already stamped
-- durably on scheduled_jobs (migration 040), bullpen_threads, and secret_capture_tokens, but
-- NOT on tasks — so a heartbeat-woken task (BacklogHeartbeat mints a *fresh* wake job, with no
-- prior job to copy an originator from) loses all authorization provenance.
--
-- Stamped at task creation, copied from the creating event's originator (child tasks copy the
-- parent's lineage, never above it). Immutable thereafter — it is pure audit + the CEILING for
-- what a woken/derived execution may inherit via the score-keyed bypass ladder. Effective
-- standing is computed at skill-invocation time; the column itself confers nothing.
--
-- Nullable: pre-migration rows are NULL → treated as agent / no-bypass (the conservative
-- default), exactly as a task with an agent-systemRole originator would be.

ALTER TABLE tasks
  ADD COLUMN originator JSONB;   -- TaskOriginator {contactId, systemRole, channel, initiatedAt, tier}; NULL = no lineage

-- Down Migration

ALTER TABLE tasks
  DROP COLUMN originator;
