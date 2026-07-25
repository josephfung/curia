-- Up Migration
--
-- Phase 1 audit log hardening (#1383 / spec 10): full prompt/response archive
-- for llm.call provenance. Kept separate from audit_log so scans stay fast;
-- keyed by audit_event_id so the audit row outlives archive retention purges.

CREATE TABLE IF NOT EXISTS llm_call_archive (
  audit_event_id    UUID PRIMARY KEY REFERENCES audit_log(id),
  prompt            JSONB NOT NULL,
  response          JSONB NOT NULL,
  tool_definitions  JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_call_archive_created_at
  ON llm_call_archive (created_at);

-- Down Migration

DROP INDEX IF EXISTS idx_llm_call_archive_created_at;
DROP TABLE IF EXISTS llm_call_archive;
