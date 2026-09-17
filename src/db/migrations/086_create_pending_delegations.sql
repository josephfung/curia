-- Up Migration: durable handles for timed-out delegations (#1799)
--
-- When a delegate wait times out the specialist keeps running (#1288 leaves the run alive on
-- purpose) and eventually publishes an agent.response that nothing consumes: the coordinator's
-- turn has already stopped. One row per timed-out delegation makes that response matchable
-- after the fact — including across a process restart, which an in-memory map cannot survive.
--
-- delegate_event_id is the delegate agent.task event id. The specialist stamps it as
-- parent_event_id on its response, so it is the correlation key and is UNIQUE: one handle per
-- delegation, which is also what makes "deliver at most once" enforceable by the database
-- rather than by timing (claim = UPDATE ... WHERE status = 'pending' RETURNING).

CREATE TABLE pending_delegations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Correlation key: the late agent.response arrives with this as its parent_event_id.
  delegate_event_id        TEXT NOT NULL UNIQUE,
  delegate_conversation_id TEXT NOT NULL,
  target_agent             TEXT NOT NULL,
  -- The raw `task` input, so a resume can rebuild delegationKey(agent, task).
  delegate_task            TEXT NOT NULL,
  -- Where the delegation came from: enough to re-enter that turn later.
  origin_agent_id          TEXT NOT NULL,
  origin_conversation_id   TEXT NOT NULL,
  origin_channel_id        TEXT NOT NULL,
  origin_sender_id         TEXT NOT NULL,
  origin_task_event_id     TEXT,
  -- TaskOriginator of the originating turn (validated before write; never the raw bag).
  originator               JSONB,
  -- Parsed from a scheduler:<jobId>:<runId> origin conversation; NULL for every other origin.
  scheduler_job_id         TEXT,
  -- The CEO backlog row the escalation created. ON DELETE SET NULL mirrors migration 049's
  -- treatment of scheduled_jobs.task_id: a deleted task must not strand or delete the handle.
  review_task_id           UUID REFERENCES tasks(id) ON DELETE SET NULL,
  status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'resolved')),
  -- LateDelegationResolution (src/bus/events.ts); NULL while pending.
  resolution               TEXT,
  -- The agent.response that resolved the handle; NULL when it expired unresolved.
  late_response_event_id   TEXT,
  -- The wake agent.task published back to the originator (delivered resolutions only).
  wake_task_event_id       TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ NOT NULL,
  resolved_at              TIMESTAMPTZ,
  -- A resolved handle must always say how, and a pending one must not claim a resolution.
  CONSTRAINT pending_delegations_resolution_shape CHECK (
    (status = 'pending'  AND resolution IS NULL     AND resolved_at IS NULL) OR
    (status = 'resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

-- The only hot query: open handles, oldest expiry first (subscriber match + sweep tick).
CREATE INDEX idx_pending_delegations_open
  ON pending_delegations (expires_at)
  WHERE status = 'pending';

-- Rollback: DROP TABLE pending_delegations;
