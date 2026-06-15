-- Up Migration
-- Routing context for agent resume after secret capture (#972), follow-up to #971.
--
-- When an agent mints a capture link it is blocked waiting on the user. These columns record
-- WHERE to route the resume once the value arrives: the originating conversation/agent/channel,
-- the agent.task event id to thread parentEventId from, who started the chain (originator), and
-- an optional natural-language description of what to resume. On redemption the capture endpoint
-- reads these back and publishes a `secret.captured` event; a thin subscriber re-enters the agent.
--
-- Still NO secret material here — only routing metadata. The value never lands on this row.
-- All columns are nullable so #971 tokens minted before this migration (and any capture minted
-- outside an agent context) remain valid; the resume subscriber simply skips a row with no
-- routable context.

ALTER TABLE secret_capture_tokens
  ADD COLUMN conversation_id TEXT,
  ADD COLUMN channel_id      TEXT,
  ADD COLUMN agent_id        TEXT,
  ADD COLUMN task_event_id   TEXT,        -- originating agent.task event id (parentEventId source)
  ADD COLUMN originator      JSONB,       -- TaskOriginator who started the chain (round-tripped only)
  ADD COLUMN resume_intent   TEXT;        -- NL description of what to resume (e.g. the original ask)

-- Down Migration

ALTER TABLE secret_capture_tokens
  DROP COLUMN conversation_id,
  DROP COLUMN channel_id,
  DROP COLUMN agent_id,
  DROP COLUMN task_event_id,
  DROP COLUMN originator,
  DROP COLUMN resume_intent;
