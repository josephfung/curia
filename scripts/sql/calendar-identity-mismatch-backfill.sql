-- Backfill / forensics queries for calendar identity mismatch (#1854)
--
-- Use these against audit_log to find wrong-identity calendar reads.
-- Past silent-lie pattern (pre-#1854): MCP get_events returned success + prose
-- empty for Curia's service account. New pattern: IDENTITY_MISMATCH on tool.result
-- and/or agent.error.

-- =============================================================================
-- A. Past silent empty reads via google-workspace get_events (pre-fix)
-- =============================================================================
-- Matches the #1853/#1854 incident shape: success:true with "No events found
-- in calendar ..." prose. The resolved identity is buried in the data string.

SELECT
  id,
  timestamp,
  payload->>'toolName' AS tool_name,
  payload->'result'->>'success' AS success,
  left(payload->'result'->>'data', 240) AS data_preview,
  payload->>'agentId' AS agent_id,
  payload->>'conversationId' AS conversation_id
FROM audit_log
WHERE event_type IN ('tool.result', 'skill.result')
  AND COALESCE(payload->>'toolName', payload->>'skillName') = 'get_events'
  AND (payload->'result'->>'success') = 'true'
  AND payload->'result'->>'data' ILIKE '%No events found in calendar%'
ORDER BY timestamp DESC;

-- =============================================================================
-- B. New structured mismatches (post-#1854) — preferred query
-- =============================================================================
-- tool.result carries errorType: IDENTITY_MISMATCH (public ToolResultPayload).

SELECT
  id,
  timestamp,
  payload->>'toolName' AS tool_name,
  payload->'result'->>'errorType' AS error_type,
  left(payload->'result'->>'error', 400) AS error_preview,
  payload->>'agentId' AS agent_id,
  payload->>'conversationId' AS conversation_id
FROM audit_log
WHERE event_type IN ('tool.result', 'skill.result')
  AND payload->'result'->>'errorType' = 'IDENTITY_MISMATCH'
ORDER BY timestamp DESC;

-- Also surfaces on agent.error when the runtime hard-fails the task (#1854).

SELECT
  id,
  timestamp,
  payload->>'errorType' AS error_type,
  payload->>'source' AS source,
  left(payload->>'message', 400) AS message_preview,
  payload->>'agentId' AS agent_id,
  payload->>'conversationId' AS conversation_id
FROM audit_log
WHERE event_type = 'agent.error'
  AND payload->>'errorType' = 'IDENTITY_MISMATCH'
ORDER BY timestamp DESC;

-- =============================================================================
-- C. Stable code substring (works across tool.result error text)
-- =============================================================================

SELECT
  id,
  timestamp,
  event_type,
  payload->>'toolName' AS tool_name,
  left(COALESCE(payload->'result'->>'error', payload->>'message'), 400) AS preview
FROM audit_log
WHERE (
    payload->'result'->>'error' ILIKE '%calendar_identity_mismatch%'
    OR payload->>'message' ILIKE '%calendar_identity_mismatch%'
  )
ORDER BY timestamp DESC;
