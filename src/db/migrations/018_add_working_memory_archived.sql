-- Up Migration
-- Add archived column to working_memory for context summarization (spec §01-memory-system.md).
-- Archived rows remain in Postgres for audit purposes but are excluded from active context loading.

ALTER TABLE working_memory ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;

-- Partial index covering only active (non-archived) rows — the hot query path for get().
-- Coexists with idx_wm_conversation (added in migration 002); the planner will prefer
-- idx_wm_active for queries that filter archived = false.
CREATE INDEX idx_wm_active ON working_memory (conversation_id, agent_id, created_at)
  WHERE archived = false;

-- Down Migration
DROP INDEX IF EXISTS idx_wm_active;
ALTER TABLE working_memory DROP COLUMN IF EXISTS archived;
