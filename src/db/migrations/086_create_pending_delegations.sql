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
-- rather than by timing.
--
-- Status is a three-step lease, not a two-step flip. 'claimed' + claimed_at is what makes the
-- work recoverable: the actor takes a lease, performs the side effects (annotate the review
-- task, publish the audit event), and only then marks the handle 'resolved'. A crash or a
-- transient failure in between leaves an expired lease the sweep picks back up, whereas a
-- straight flip to 'resolved' would have recorded the work as done and dropped it. Only one
-- actor can hold a live lease, so recovery does not reintroduce concurrent duplicates.
--
-- claim_token is what makes the lease *ownable* rather than merely held. Every claim mints a
-- fresh token, and finalize/release require it, so an actor that stalled past its lease cannot
-- come back and close out — or hand back — work a later claimant now owns. Without it,
-- `status = 'claimed'` is proof that someone holds the lease, not that the caller does.

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
                             CHECK (status IN ('pending', 'claimed', 'resolved')),
  -- When the current actor took its lease. NULL unless status is 'claimed'/'resolved'.
  claimed_at               TIMESTAMPTZ,
  -- Minted fresh on every claim; finalize/release must present it to act on the handle.
  claim_token              UUID,
  -- LateDelegationResolution (src/bus/events.ts); set when the lease is taken, because the
  -- classification is a pure function of the response and cannot change under a retry.
  resolution               TEXT,
  -- The agent.response that resolved the handle; NULL when it expired unresolved.
  late_response_event_id   TEXT,
  -- The wake agent.task published back to the originator (delivered resolutions only).
  wake_task_event_id       TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ NOT NULL,
  resolved_at              TIMESTAMPTZ,
  -- Each status carries exactly the fields it has earned: a pending handle claims nothing, a
  -- claimed one knows its verdict and holds a lease, a resolved one is finished.
  CONSTRAINT pending_delegations_resolution_shape CHECK (
    (status = 'pending'  AND resolution IS NULL     AND claimed_at IS NULL     AND claim_token IS NULL     AND resolved_at IS NULL) OR
    (status = 'claimed'  AND resolution IS NOT NULL AND claimed_at IS NOT NULL AND claim_token IS NOT NULL AND resolved_at IS NULL) OR
    (status = 'resolved' AND resolution IS NOT NULL AND claimed_at IS NOT NULL AND claim_token IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

-- Sweep tick: unfinished handles, oldest expiry first. Covers both a pending
-- handle and one whose lease was abandoned mid-flight. Not the only hot query —
-- delegate's in-flight lookup (target agent + originating conversation) is
-- indexed separately in migration 091.
CREATE INDEX idx_pending_delegations_open
  ON pending_delegations (expires_at)
  WHERE status IN ('pending', 'claimed');

-- Rollback: DROP TABLE pending_delegations;
