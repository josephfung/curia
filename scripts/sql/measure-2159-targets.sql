-- measure-2159-targets.sql: the two-week targets of #2159, measured in prod (#2193).
--
-- READ-ONLY. The whole script runs in a READ ONLY transaction, so a typo cannot write.
-- Output is counts only: this tracker is public, so nothing here selects content, ids,
-- addresses or names.
--
-- Run one window at a time (psql, against the prod database):
--   psql "$DATABASE_URL" -v since='2026-10-19' -v until='2026-11-02' -f scripts/sql/measure-2159-targets.sql
-- Baseline: the same script over the two weeks before band gating went live:
--   -v since='2026-10-05' -v until='2026-10-19'
--
-- Definitions (written here so later runs measure the same thing):
--
--   Piece of work     The email thread the message joined (payload.threadId); else the
--                     conversation of the agent.task event that caused the send (found through
--                     payload.taskEventId, since outbound.delivered rows carry no task_id); else
--                     the row's own conversationId, which is the SENDER'S turn and so a last resort.
--   Principal-bound   An outbound.delivered row whose recipient (payload.channel + recipientId)
--                     is one of the principal contact's channel identities. Matched on the
--                     recipient, never on conversation_id. 'web' recipientId 'principal' counts.
--   Immediate         Principal-bound and not a digest. A digest is recognised by its spot-check
--                     header or by being the weekly fallback; see the "digest" CTE. This is the
--                     weakest part of the definition: digests are not tagged in audit_log.
--   Approval          An autonomy_action_log row with a short_ref and no parent_action_id (the
--                     re-execution rows carry the parent), created in the window. The row is
--                     updated in place, so "reached pending_approval" is read as "was raised".

\set ON_ERROR_STOP on
BEGIN READ ONLY;

\echo '== window =='
SELECT :'since'::timestamptz AS since, :'until'::timestamptz AS until;

-- ---------------------------------------------------------------------------
-- 1. Immediate principal-bound messages per piece of work
-- ---------------------------------------------------------------------------
\echo '== 1. immediate principal-bound messages per piece of work =='
WITH principal_ids AS (
  SELECT cci.channel, lower(cci.channel_identifier) AS ident
  FROM contacts c
  JOIN contact_channel_identities cci ON cci.contact_id = c.id
  WHERE c.system_role = 'principal'
),
delivered AS (
  -- Piece of work, most specific first: the email thread the message joined; else the
  -- conversation of the agent.task event that caused the send (payload.taskEventId is that
  -- event's id; outbound.delivered rows never carry task_id themselves); else the row's own
  -- conversationId (the sender's turn, so a last resort).
  SELECT a.id,
         a.timestamp,
         COALESCE(
           a.payload->>'threadId',
           t.conversation_id,
           a.conversation_id,
           a.payload->>'conversationId'
         ) AS work,
         a.payload->>'content' AS content
  FROM audit_log a
  LEFT JOIN audit_log t
    ON t.id::text = a.payload->>'taskEventId'
   AND t.event_type = 'agent.task'
  WHERE a.event_type = 'outbound.delivered'
    AND a.timestamp >= :'since'::timestamptz
    AND a.timestamp <  :'until'::timestamptz
    AND (
      EXISTS (
        SELECT 1 FROM principal_ids p
        WHERE p.channel = a.payload->>'channel'
          AND p.ident = lower(a.payload->>'recipientId')
      )
      OR (a.payload->>'channel' = 'web' AND a.payload->>'recipientId' = 'principal')
    )
),
digest AS (
  -- TODO: digests carry no tag in audit_log; this text match is the best available signal.
  -- If #2159 grows a structured marker (e.g. a digest flag on the delivery), use it here.
  SELECT id FROM delivered
  WHERE content LIKE '%Spot check (optional, reply with a number):%'
),
immediate AS (
  SELECT work, count(*) AS n
  FROM delivered
  WHERE id NOT IN (SELECT id FROM digest) AND work IS NOT NULL
  GROUP BY work
)
SELECT
  (SELECT count(*) FROM delivered)                                   AS principal_bound_total,
  (SELECT count(*) FROM digest)                                      AS digests_excluded,
  (SELECT count(*) FROM delivered WHERE work IS NULL)                AS unattributable_to_work,
  count(*)                                                           AS pieces_of_work,
  COALESCE(round(avg(n), 2), 0)                                      AS mean_immediate_per_work,
  COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY n), 0)        AS median,
  COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY n), 0)       AS p95,
  COALESCE(max(n), 0)                                                AS max,
  count(*) FILTER (WHERE n >= 5)                                     AS pieces_at_or_over_5
FROM immediate;

-- Pieces of work with 5 or more immediate messages: how many, and over what span. A long span
-- is a standing thread (messages spread over days); a short one is the burst the target is about.
-- Counts and hours only, no ids.
\echo '== 1b. pieces of work at 5+ immediate messages (messages, span in hours) =='
WITH principal_ids AS (
  SELECT cci.channel, lower(cci.channel_identifier) AS ident
  FROM contacts c
  JOIN contact_channel_identities cci ON cci.contact_id = c.id
  WHERE c.system_role = 'principal'
),
delivered AS (
  SELECT a.timestamp,
         COALESCE(a.payload->>'threadId', t.conversation_id, a.conversation_id, a.payload->>'conversationId') AS work,
         a.payload->>'content' AS content
  FROM audit_log a
  LEFT JOIN audit_log t ON t.id::text = a.payload->>'taskEventId' AND t.event_type = 'agent.task'
  WHERE a.event_type = 'outbound.delivered'
    AND a.timestamp >= :'since'::timestamptz
    AND a.timestamp <  :'until'::timestamptz
    AND (
      EXISTS (SELECT 1 FROM principal_ids p WHERE p.channel = a.payload->>'channel' AND p.ident = lower(a.payload->>'recipientId'))
      OR (a.payload->>'channel' = 'web' AND a.payload->>'recipientId' = 'principal')
    )
)
SELECT count(*) AS messages,
       round(extract(epoch FROM max(timestamp) - min(timestamp)) / 3600) AS span_hours
FROM delivered
WHERE work IS NOT NULL
  AND content NOT LIKE '%Spot check (optional, reply with a number):%'
GROUP BY work
HAVING count(*) >= 5
ORDER BY 1 DESC;

-- ---------------------------------------------------------------------------
-- 2. Approvals per week (autonomy_action_log), by how they ended
-- ---------------------------------------------------------------------------
\echo '== 2. approvals raised per week, by outcome and resolver =='
SELECT date_trunc('week', created_at)::date AS week,
       outcome,
       COALESCE(resolved_by, '(unresolved)') AS resolved_by,
       count(*) AS approvals
FROM autonomy_action_log
WHERE short_ref IS NOT NULL
  AND parent_action_id IS NULL
  AND created_at >= :'since'::timestamptz
  AND created_at <  :'until'::timestamptz
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- The target is "at spot-check", i.e. score 80+. The row does not store the score it was raised
-- at, so this splits by skill instead; the band at raise time needs the autonomy score history.
-- TODO: the steered-versus-other split asked for in #2193 has no structured source today:
-- band review's hold reason is not written to the row (description holds the action, not
-- the rule). Count steered holds from a new column or audit event, then add it here.
\echo '== 2b. approvals raised, by skill =='
SELECT skill_name, count(*) AS approvals
FROM autonomy_action_log
WHERE short_ref IS NOT NULL
  AND parent_action_id IS NULL
  AND created_at >= :'since'::timestamptz
  AND created_at <  :'until'::timestamptz
GROUP BY 1
ORDER BY 2 DESC;

-- ---------------------------------------------------------------------------
-- 3. The four extra metrics
-- ---------------------------------------------------------------------------
-- Judge failures at 80+: the send went out unreviewed and queued a report item.
\echo '== 3a. judge failures (sent without review) =='
SELECT count(*) AS sent_without_review
FROM audit_log
WHERE event_type = 'principal.report'
  AND payload->>'source' = 'sent_without_review'
  AND timestamp >= :'since'::timestamptz
  AND timestamp <  :'until'::timestamptz;

-- Grounding bounces are logged by band-send-review.ts, not audited, so audit_log cannot count them.
-- TODO: emit an audit event for bounces (and for "resolved by lookup") so this is a query.
\echo '== 3b. grounding bounces: not recorded in audit_log (see TODO) =='

-- Spot-check "bad" rate: principal-scored rows, by flag.
\echo '== 3c. spot-check verdicts from the principal =='
SELECT count(*) FILTER (WHERE competence_flag = 0) AS bad,
       count(*) FILTER (WHERE competence_flag = 1) AS ok,
       count(*)                                    AS principal_scored
FROM autonomy_action_log
WHERE scored_by = 'principal'
  AND created_at >= :'since'::timestamptz
  AND created_at <  :'until'::timestamptz;

-- Principal verdicts reaching the scorer, per week (target: every week).
\echo '== 3d. principal-resolved rows per week =='
SELECT date_trunc('week', resolved_at)::date AS week,
       count(*) FILTER (WHERE scored_by = 'principal')     AS principal_scored,
       count(*) FILTER (WHERE resolved_by = 'principal')   AS principal_resolved_approvals
FROM autonomy_action_log
WHERE resolved_at >= :'since'::timestamptz
  AND resolved_at <  :'until'::timestamptz
GROUP BY 1
ORDER BY 1;

ROLLBACK;
