-- Up Migration
--
-- Issue #1065: bullpen_thread_reads — per-agent read watermark for bullpen threads.
--
-- Bullpen threads are injected into an agent's context as ambient awareness on every
-- task (getPendingThreadsForAgent). When an agent fulfils a thread's request *out of
-- band* (a send, a spreadsheet write, anything that leaves no in-thread reply), the
-- thread's surfacing conditions never change, so it is re-injected on the next wake and
-- the action is re-run — a duplicate out-of-band action.
--
-- This table records, per (thread, agent), the latest message timestamp the agent has
-- already seen. getPendingThreadsForAgent stops surfacing a thread to that agent until a
-- message newer than seen_through arrives, so a handled thread no longer nags — and this
-- is action-agnostic (no per-skill allowlist).
--
-- The watermark is monotonic: markThreadsSeen upserts with GREATEST so it only ever
-- advances.

CREATE TABLE bullpen_thread_reads (
  thread_id     UUID        NOT NULL REFERENCES bullpen_threads(id) ON DELETE CASCADE,
  agent_id      TEXT        NOT NULL,
  -- The newest bullpen_messages.created_at this agent had in context when it last
  -- processed the thread. A thread re-surfaces only when last_message_at exceeds this.
  seen_through  TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (thread_id, agent_id)
);

-- getPendingThreadsForAgent joins on (thread_id, agent_id); the PK index already covers
-- thread_id-prefixed lookups. An agent_id index supports the per-agent scan direction.
CREATE INDEX idx_bullpen_thread_reads_agent ON bullpen_thread_reads (agent_id);

-- Down Migration
DROP INDEX IF EXISTS idx_bullpen_thread_reads_agent;
DROP TABLE IF EXISTS bullpen_thread_reads;
