-- Up Migration
-- Contact-scoped recent history (#1599).
--
-- working_memory has no sender, so a later conversation cannot find "what this
-- person said earlier" without scanning every thread. sender_contact_id is the
-- resolved contact on a user turn. Assistant and system turns leave it null.
-- channel_id is the inbound channel, used only to label the recall block.
--
-- ON DELETE SET NULL: deleting a contact must not block, and must not keep
-- serving that person's words as theirs.
--
-- Backfill covers the conversation ids that encode a single peer (Signal 1:1,
-- SMS, and voice sessions). Email threads, Slack threads, and Signal groups
-- do not — those senders are stamped on write from here on. The voice greeting
-- cue is not a thing the caller said, so it stays unattributed. The recall
-- read ignores that exact cue when deciding a call is shared.
--
-- Each UPDATE is limited to the last 7 days so a full rewrite of
-- working_memory does not sit inside the boot transaction. Recall only
-- renders rows from the local day, but the shared-conversation check reads
-- every user row, including archived ones. An older null sender on a
-- long-lived Signal 1:1 or SMS thread would hide that thread's replies.
-- Those older rows are stamped after boot by backfillDirectChannelSenders
-- (src/memory/direct-sender-backfill.ts), in batches, and only where the
-- sender is still null. Email, Slack, and Signal groups are not backfilled.

ALTER TABLE working_memory
  ADD COLUMN sender_contact_id UUID NULL REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN channel_id TEXT NULL;

-- Hot path: recent user turns for one contact and agent.
CREATE INDEX idx_wm_sender_active
  ON working_memory (sender_contact_id, agent_id, created_at DESC)
  WHERE archived = false AND role = 'user' AND sender_contact_id IS NOT NULL;

UPDATE working_memory wm
SET sender_contact_id = cci.contact_id,
    channel_id = COALESCE(wm.channel_id, 'signal')
FROM contact_channel_identities cci
WHERE wm.role = 'user'
  AND wm.sender_contact_id IS NULL
  AND wm.created_at >= now() - interval '7 days'
  AND wm.conversation_id LIKE 'signal:%'
  AND wm.conversation_id NOT LIKE 'signal:group=%'
  AND cci.channel = 'signal'
  AND cci.channel_identifier = substring(wm.conversation_id FROM '^signal:(.+)$');

UPDATE working_memory wm
SET sender_contact_id = cci.contact_id,
    channel_id = COALESCE(wm.channel_id, 'sms')
FROM contact_channel_identities cci
WHERE wm.role = 'user'
  AND wm.sender_contact_id IS NULL
  AND wm.created_at >= now() - interval '7 days'
  AND wm.conversation_id LIKE 'sms:%'
  AND cci.channel = 'sms'
  AND cci.channel_identifier = substring(wm.conversation_id FROM '^sms:(.+)$');

UPDATE working_memory wm
SET sender_contact_id = vs.caller_contact_id,
    channel_id = COALESCE(wm.channel_id, 'voice')
FROM voice_sessions vs
WHERE wm.conversation_id = vs.conversation_id
  AND wm.role = 'user'
  AND wm.sender_contact_id IS NULL
  AND wm.created_at >= now() - interval '7 days'
  AND vs.caller_contact_id IS NOT NULL
  AND wm.content IS DISTINCT FROM '[Call connected — open the conversation.]';

-- Down Migration
DROP INDEX IF EXISTS idx_wm_sender_active;
ALTER TABLE working_memory DROP COLUMN IF EXISTS channel_id;
ALTER TABLE working_memory DROP COLUMN IF EXISTS sender_contact_id;
