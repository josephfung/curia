-- 117_activity_describers.sql
--
-- Learned describers for the activity feed (#2455, ADR-059). One row per agent and
-- tool that has no describer in src/activity/describers.ts: whether the tool reads
-- or writes, and the words the feed uses for it ("logged" / "an expense" /
-- "expenses"). A fast-tier model writes the row the first time the agent uses the
-- tool; the feed and the dashboard histogram read it.
--
-- Display only: nothing in autonomy reads this table.
--
-- source:
--   hint     — effect from a deterministic signal (action_risk, MCP annotations), words learned
--   learned  — effect and words both from the model
--   operator — edited by hand; the learner never overwrites it
--
-- description_hash is the tool's description and input schema when the row was
-- learned. A tool whose hash no longer matches is learned again (unless operator).

-- Up Migration

CREATE TABLE activity_describers (
  agent_id         TEXT        NOT NULL,
  tool_name        TEXT        NOT NULL,
  effect           TEXT        NOT NULL CHECK (effect IN ('read', 'write')),
  verb             TEXT        NOT NULL,
  one              TEXT        NOT NULL,
  many             TEXT        NOT NULL,
  attempt          TEXT        NOT NULL,
  description_hash TEXT        NOT NULL,
  source           TEXT        NOT NULL CHECK (source IN ('hint', 'learned', 'operator')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, tool_name)
);

-- Down Migration

DROP TABLE IF EXISTS activity_describers;
