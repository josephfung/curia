-- Up Migration

-- 074_shadow_eval_idempotency.sql
--
-- #1432: durable idempotency for shadow-draft competence reconciliation.
-- sent-observe inserts a pre-scored 'shadow_evaluated' row and THEN marks the shadow doc
-- reconciled_at. If the mark fails after the insert, the watermark is held and the next run
-- re-judges and re-inserts a DUPLICATE row (the marker was the only idempotency record, written
-- after the insert). This adds a DB-level backstop: one 'shadow_evaluated' row per
-- source_message_id, enforced by a partial unique index. The insert path uses ON CONFLICT DO
-- NOTHING (see ActionLogRepo.insertShadowEvaluated), so a re-run is a no-op.
--
-- Prod may already hold duplicates produced by the bug this fixes, so we DEDUP FIRST — otherwise
-- CREATE UNIQUE INDEX would abort on the pre-existing violating rows (the same class of failure
-- as migration 070, which only detonated against prod data).

-- NOTE ON LOCKING (mirrors migrations 044 / 073): node-pg-migrate wraps each SQL file in a single
-- transaction, so CREATE INDEX CONCURRENTLY is unavailable here. Building this partial index takes
-- a brief lock/scan on autonomy_action_log during deploy — acceptable at the current single-tenant
-- table size. If the table grows large enough that this stalls writes, split into a
-- non-transactional migration using CREATE INDEX CONCURRENTLY.

-- Remove all but the lowest-id row per source_message_id among existing shadow rows.
DELETE FROM autonomy_action_log a
USING autonomy_action_log b
WHERE a.outcome = 'shadow_evaluated'
  AND b.outcome = 'shadow_evaluated'
  AND a.payload->>'source_message_id' = b.payload->>'source_message_id'
  AND a.payload->>'source_message_id' IS NOT NULL
  AND a.id > b.id;

-- One shadow_evaluated row per source_message_id. `payload->>'source_message_id'` is immutable, so
-- it is legal in an index expression; the partial predicate scopes the constraint to shadow rows
-- only, so no other outcome/caller can ever collide with it. NULL source ids are naturally distinct
-- in a unique index and are not constrained (there should be none — the writer always sets it).
CREATE UNIQUE INDEX idx_aal_shadow_source
  ON autonomy_action_log ((payload->>'source_message_id'))
  WHERE outcome = 'shadow_evaluated';

-- Down Migration

-- Symmetric, non-aborting: just drop the index. The dedup DELETE above is deliberately NOT
-- reversed — the rows it removed were erroneous duplicates with no meaning to restore.
DROP INDEX IF EXISTS idx_aal_shadow_source;
