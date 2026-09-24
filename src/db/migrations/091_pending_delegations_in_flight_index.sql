-- Up Migration: index the in-flight delegation lookup (#1858)
--
-- delegate checks pending_delegations on every call for an unresolved handle
-- matching target agent + originating conversation. Migration 086 indexed only
-- (expires_at) for the sweep. Rows are never deleted — resolved handles stay —
-- so without this index that check seq-scans the lifetime of every timed-out
-- delegation. created_at is in the key so ORDER BY created_at ASC LIMIT 1
-- can stop at the first match.

CREATE INDEX idx_pending_delegations_in_flight
  ON pending_delegations (target_agent, origin_conversation_id, created_at)
  WHERE status = 'pending';

-- Rollback: DROP INDEX idx_pending_delegations_in_flight;
