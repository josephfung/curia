-- Up Migration

-- 031_create_autonomy_action_log.sql
--
-- Phase 3 autonomy scoring foundation (issue #148) + ADR-018 approval lifecycle.
-- This table records autonomy-gated skill invocations and their outcomes.
-- The scoring engine (AutonomyScoringPass) consumes terminal rows to compute
-- a Competence/Commitment/Compatibility composite that drives automatic
-- autonomy score adjustment.
--
-- Approval lifecycle columns (payload, notification_sent_at, resolved_at,
-- resolved_by, expires_at, parent_action_id, short_ref, description) are
-- populated by #427/#428/#429 — not by this migration's companion code.

CREATE TABLE autonomy_action_log (
  id                   BIGSERIAL PRIMARY KEY,
  task_id              TEXT NOT NULL,
  -- TODO: conversation_id enables a future upgrade (approach C) where the
  -- LLM judge queries the audit log for the full conversation transcript,
  -- replacing summary-based scoring with richer Competence/Compatibility context.
  conversation_id      TEXT,
  skill_name           TEXT NOT NULL,
  action_risk          TEXT NOT NULL,
  outcome              TEXT NOT NULL CHECK (outcome IN (
    'success', 'failure', 'rejected',
    'pending_approval', 'approved', 'denied', 'expired', 'resolved_externally'
  )),
  task_summary         TEXT,

  -- Phase 3 scoring flags (LLM judge or deterministic from approval outcome)
  competence_flag      SMALLINT CHECK (competence_flag IN (0, 1)),
  commitment_flag      SMALLINT CHECK (commitment_flag IN (0, 1)),
  compatibility        SMALLINT CHECK (compatibility IN (0, 1)),
  scored_by            TEXT,  -- 'llm-judge' for now; 'ceo' reserved for future manual override

  -- ADR-018 approval lifecycle columns (populated by #427/#428/#429)
  payload              JSONB,
  notification_sent_at TIMESTAMPTZ,
  resolved_at          TIMESTAMPTZ,
  resolved_by          TEXT,
  expires_at           TIMESTAMPTZ,
  parent_action_id     BIGINT REFERENCES autonomy_action_log(id),
  short_ref            TEXT,
  description          TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Scoring pass: find unscored terminal rows
CREATE INDEX idx_aal_unscored
  ON autonomy_action_log (created_at)
  WHERE scored_by IS NULL
    AND outcome IN ('success', 'failure', 'approved', 'denied', 'expired', 'resolved_externally');

-- Approval lifecycle (#427/#428/#429): find pending rows by expiry
CREATE INDEX idx_aal_pending ON autonomy_action_log (expires_at)
  WHERE outcome = 'pending_approval';

-- Approval skills (#428): look up by short_ref
CREATE INDEX idx_aal_short_ref ON autonomy_action_log (short_ref)
  WHERE short_ref IS NOT NULL;

-- TODO: conversation_id enables the judge to query the audit log for the full
-- conversation transcript, replacing summary-based scoring with richer context.
CREATE INDEX idx_aal_conversation ON autonomy_action_log (conversation_id)
  WHERE conversation_id IS NOT NULL;

-- Deduplication (#427): find existing pending rows for same skill+task
CREATE INDEX idx_aal_task ON autonomy_action_log (task_id);

-- Approval lifecycle (#427/#428/#429): find re-execution rows by parent approval
CREATE INDEX idx_aal_parent ON autonomy_action_log (parent_action_id)
  WHERE parent_action_id IS NOT NULL;

-- Down Migration

DROP TABLE IF EXISTS autonomy_action_log;
