-- Up Migration

ALTER TABLE bullpen_threads ADD COLUMN source_message_id TEXT;

-- Unique constraint scoped to non-null values only (partial index).
-- Null source_message_id means "no dedup key" — threads without one are
-- always created unconditionally and must not block each other.
CREATE UNIQUE INDEX idx_bullpen_threads_source_message_id
  ON bullpen_threads (source_message_id)
  WHERE source_message_id IS NOT NULL;

-- Rollback:
-- DROP INDEX IF EXISTS idx_bullpen_threads_source_message_id;
-- ALTER TABLE bullpen_threads DROP COLUMN source_message_id;
