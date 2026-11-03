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
-- Dates are read as UTC. The script prints "== done ==" last; a run without it is partial.
--
-- Definitions (written here so later runs measure the same thing):
--
--   Piece of work     The email thread the message joined (payload.threadId); else the
--                     conversation of the agent.task event that caused the send (found through
--                     payload.taskEventId, since outbound.delivered rows carry no task_id); else
--                     the row's own conversationId, which is the SENDER'S turn and so a last resort.
--                     Section 1a prints how many rows resolved at each tier; the more that fall to
--                     the last tier, the lower (softer) the per-work counts are.
--   Principal-bound   An outbound.delivered row whose recipient (payload.channel + recipientId)
--                     is one of the principal contact's channel identities. Matched on the
--                     recipient, never on conversation_id. 'web' recipientId 'principal' counts.
--                     Section 0 shows how many deliveries matched, per channel, so a format
--                     mismatch shows up as unmatched rows and not as a silent zero. A principal on
--                     cc is not seen: recipientId holds one value.
--   Immediate         Principal-bound and not a digest. A digest is recognised by its content:
--                     the spot-check header, or the opening lines of the weekly fallback digest
--                     (see the "digest" CTE). A regular digest sent without a spot-check block
--                     is not recognised and counts as immediate. This overstates the message
--                     count slightly, never understates it.
--   Approval          An autonomy_action_log row with a short_ref and no parent_action_id (the
--                     re-execution rows carry the parent), created in the window. The row is
--                     updated in place, so "reached pending_approval" is read as "was raised".
--                     Rows are grouped by their outcome at run time, so a window that ends just
--                     before the run shows rows still pending. Rows before #2159 Phase 1 carry
--                     resolved_by 'ceo'; later ones 'principal' or 'coordinator'. Read them as the
--                     same kind of resolution when comparing the baseline.
--   Spot-check        A pool row (autonomy_action_log.payload.sample) the principal answered. The
--   verdict           verdict has no timestamp of its own, so the windows below use
--                     payload.sample.sampledAt, the time the row was offered in a digest.

\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL timezone = 'UTC';

\echo '== window (UTC) =='
SELECT :'since'::timestamptz AS since, :'until'::timestamptz AS until, now() AS run_at;

-- ---------------------------------------------------------------------------
-- 0. Sanity: did principal matching work, and was the window populated?
-- ---------------------------------------------------------------------------
\echo '== 0. principal identities, and deliveries by channel (matched / not) =='
WITH principal_ids AS (
  SELECT cci.channel, lower(cci.channel_identifier) AS ident
  FROM contacts c
  JOIN contact_channel_identities cci ON cci.contact_id = c.id
  WHERE c.system_role = 'principal'
)
SELECT a.payload->>'channel' AS channel,
       (
         EXISTS (SELECT 1 FROM principal_ids p WHERE p.channel = a.payload->>'channel' AND p.ident = lower(a.payload->>'recipientId'))
         OR (a.payload->>'channel' = 'web' AND a.payload->>'recipientId' = 'principal')
       ) AS principal_bound,
       count(*) AS deliveries,
       (SELECT count(*) FROM principal_ids) AS principal_identity_rows
FROM audit_log a
WHERE a.event_type = 'outbound.delivered'
  AND a.timestamp >= :'since'::timestamptz
  AND a.timestamp <  :'until'::timestamptz
GROUP BY 1, 2
ORDER BY 1, 2;

-- ---------------------------------------------------------------------------
-- 1. Immediate principal-bound messages per piece of work
-- ---------------------------------------------------------------------------
-- The delivered CTE is repeated in 1a, 1 and 1b; keep the three copies identical.
\echo '== 1a. how each principal-bound delivery was attributed to a piece of work =='
WITH principal_ids AS (
  SELECT cci.channel, lower(cci.channel_identifier) AS ident
  FROM contacts c
  JOIN contact_channel_identities cci ON cci.contact_id = c.id
  WHERE c.system_role = 'principal'
),
delivered AS (
  SELECT a.id, a.timestamp,
         COALESCE(
           NULLIF(a.payload->>'threadId', ''),
           NULLIF(t.conversation_id, ''),
           NULLIF(a.conversation_id, ''),
           NULLIF(a.payload->>'conversationId', '')
         ) AS work,
         CASE
           WHEN NULLIF(a.payload->>'threadId', '') IS NOT NULL THEN '1 email thread'
           WHEN NULLIF(t.conversation_id, '') IS NOT NULL THEN '2 task conversation'
           WHEN COALESCE(NULLIF(a.conversation_id, ''), NULLIF(a.payload->>'conversationId', '')) IS NOT NULL THEN '3 own conversation (last resort)'
           ELSE '4 none'
         END AS tier,
         COALESCE(a.payload->>'content', '') AS content
  FROM audit_log a
  LEFT JOIN audit_log t
    ON t.id::text = a.payload->>'taskEventId'
   AND t.event_type = 'agent.task'
  WHERE a.event_type = 'outbound.delivered'
    AND a.timestamp >= :'since'::timestamptz
    AND a.timestamp <  :'until'::timestamptz
    AND (
      EXISTS (SELECT 1 FROM principal_ids p WHERE p.channel = a.payload->>'channel' AND p.ident = lower(a.payload->>'recipientId'))
      OR (a.payload->>'channel' = 'web' AND a.payload->>'recipientId' = 'principal')
    )
)
SELECT tier, count(*) AS deliveries FROM delivered GROUP BY 1 ORDER BY 1;

\echo '== 1. immediate principal-bound messages per piece of work =='
WITH principal_ids AS (
  SELECT cci.channel, lower(cci.channel_identifier) AS ident
  FROM contacts c
  JOIN contact_channel_identities cci ON cci.contact_id = c.id
  WHERE c.system_role = 'principal'
),
delivered AS (
  SELECT a.id, a.timestamp,
         COALESCE(
           NULLIF(a.payload->>'threadId', ''),
           NULLIF(t.conversation_id, ''),
           NULLIF(a.conversation_id, ''),
           NULLIF(a.payload->>'conversationId', '')
         ) AS work,
         COALESCE(a.payload->>'content', '') AS content
  FROM audit_log a
  LEFT JOIN audit_log t
    ON t.id::text = a.payload->>'taskEventId'
   AND t.event_type = 'agent.task'
  WHERE a.event_type = 'outbound.delivered'
    AND a.timestamp >= :'since'::timestamptz
    AND a.timestamp <  :'until'::timestamptz
    AND (
      EXISTS (SELECT 1 FROM principal_ids p WHERE p.channel = a.payload->>'channel' AND p.ident = lower(a.payload->>'recipientId'))
      OR (a.payload->>'channel' = 'web' AND a.payload->>'recipientId' = 'principal')
    )
),
digest AS (
  -- TODO: digests carry no tag in audit_log; this text match is the best available signal.
  -- If #2159 grows a structured marker (e.g. a digest flag on the delivery), use it here.
  SELECT id FROM delivered
  WHERE content LIKE '%Spot check (optional, reply with a number):%'
     OR content LIKE 'There was no digest this week%'
     OR content LIKE '%waited more than % days for a digest.%'
),
immediate AS (
  SELECT work, count(*) AS n
  FROM delivered
  WHERE id NOT IN (SELECT id FROM digest) AND work IS NOT NULL
  GROUP BY work
)
-- Statistics are NULL, not 0, when there is no work, so an empty window cannot read as "none per work".
SELECT
  (SELECT count(*) FROM delivered)                                   AS principal_bound_total,
  (SELECT count(*) FROM digest)                                      AS digests_excluded,
  (SELECT count(*) FROM delivered WHERE work IS NULL)                AS unattributable_to_work,
  count(*)                                                           AS pieces_of_work,
  round(avg(n), 2)                                                   AS mean_immediate_per_work,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY n)                     AS median,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY n)                    AS p95,
  max(n)                                                             AS max,
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
  SELECT a.id, a.timestamp,
         COALESCE(
           NULLIF(a.payload->>'threadId', ''),
           NULLIF(t.conversation_id, ''),
           NULLIF(a.conversation_id, ''),
           NULLIF(a.payload->>'conversationId', '')
         ) AS work,
         COALESCE(a.payload->>'content', '') AS content
  FROM audit_log a
  LEFT JOIN audit_log t
    ON t.id::text = a.payload->>'taskEventId'
   AND t.event_type = 'agent.task'
  WHERE a.event_type = 'outbound.delivered'
    AND a.timestamp >= :'since'::timestamptz
    AND a.timestamp <  :'until'::timestamptz
    AND (
      EXISTS (SELECT 1 FROM principal_ids p WHERE p.channel = a.payload->>'channel' AND p.ident = lower(a.payload->>'recipientId'))
      OR (a.payload->>'channel' = 'web' AND a.payload->>'recipientId' = 'principal')
    )
)
SELECT count(*) AS messages,
       round(extract(epoch FROM max(timestamp) - min(timestamp)) / 3600, 1) AS span_hours
FROM delivered
WHERE work IS NOT NULL
  AND content NOT LIKE '%Spot check (optional, reply with a number):%'
  AND content NOT LIKE 'There was no digest this week%'
  AND content NOT LIKE '%waited more than % days for a digest.%'
GROUP BY work
HAVING count(*) >= 5
ORDER BY 1 DESC;

-- ---------------------------------------------------------------------------
-- 2. Approvals per week (autonomy_action_log), by how they ended
-- ---------------------------------------------------------------------------
-- Weeks start on Monday (UTC). A window that does not start on a Monday has short first and last
-- weeks, which read as low weeks; the 14-day windows used for #2193 start on Mondays.
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
ORDER BY 2 DESC, 1;

-- ---------------------------------------------------------------------------
-- 3. The four extra metrics
-- ---------------------------------------------------------------------------
-- Judge failures at 80+: the send went out unreviewed and queued a report item. This does not
-- count the sends held below 80 because the reviewer was down, nor a report whose publish failed.
-- The second query shows principal.report rows by source in the window, so a source that is
-- never recorded (and so reads 0 above) is visible.
\echo '== 3a. judge failures (sent without review) =='
SELECT count(*) AS sent_without_review
FROM audit_log
WHERE event_type = 'principal.report'
  AND payload->>'source' = 'sent_without_review'
  AND timestamp >= :'since'::timestamptz
  AND timestamp <  :'until'::timestamptz;

\echo '== 3a. principal.report rows in the window, by source =='
SELECT payload->>'source' AS source, count(*) AS rows
FROM audit_log
WHERE event_type = 'principal.report'
  AND timestamp >= :'since'::timestamptz
  AND timestamp <  :'until'::timestamptz
GROUP BY 1
ORDER BY 2 DESC, 1;

-- Grounding bounces are logged by band-send-review.ts, not audited, so audit_log cannot count them.
-- TODO: emit an audit event for bounces (and for "resolved by lookup") so this is a query.
\echo '== 3b. grounding bounces: not recorded in audit_log (see TODO) =='

-- Spot-check pool: rows offered in a digest in the window, and how many the principal answered.
-- A verdict sets competence_flag and scored_by 'principal' on the pool row; it has no timestamp,
-- so rows are windowed by when they were offered (payload.sample.sampledAt).
\echo '== 3c. spot-check rows offered, and the principal verdicts on them =='
SELECT count(*)                                                     AS offered,
       count(*) FILTER (WHERE scored_by = 'principal')              AS answered,
       count(*) FILTER (WHERE scored_by = 'principal' AND competence_flag = 0) AS bad,
       count(*) FILTER (WHERE scored_by = 'principal' AND competence_flag = 1) AS ok,
       count(*) FILTER (WHERE scored_by = 'principal' AND competence_flag IS NULL) AS answered_no_flag
FROM autonomy_action_log
WHERE payload->'sample'->>'sampledAt' IS NOT NULL
  AND (payload->'sample'->>'sampledAt')::timestamptz >= :'since'::timestamptz
  AND (payload->'sample'->>'sampledAt')::timestamptz <  :'until'::timestamptz;

-- Principal verdicts reaching the scorer, per week offered (target: every week). resolved_by is
-- counted on approval rows only; the two columns are different kinds of principal feedback.
\echo '== 3d. principal feedback per week (spot-check verdicts; approvals resolved by the principal) =='
WITH verdicts AS (
  SELECT date_trunc('week', (payload->'sample'->>'sampledAt')::timestamptz)::date AS week,
         count(*) AS spot_check_verdicts, 0 AS approvals_resolved_by_principal
  FROM autonomy_action_log
  WHERE scored_by = 'principal'
    AND payload->'sample'->>'sampledAt' IS NOT NULL
    AND (payload->'sample'->>'sampledAt')::timestamptz >= :'since'::timestamptz
    AND (payload->'sample'->>'sampledAt')::timestamptz <  :'until'::timestamptz
  GROUP BY 1
),
approvals AS (
  SELECT date_trunc('week', resolved_at)::date AS week,
         0 AS spot_check_verdicts, count(*) AS approvals_resolved_by_principal
  FROM autonomy_action_log
  WHERE resolved_by IN ('principal', 'console', 'ceo')
    AND short_ref IS NOT NULL
    AND resolved_at >= :'since'::timestamptz
    AND resolved_at <  :'until'::timestamptz
  GROUP BY 1
)
SELECT week, sum(spot_check_verdicts) AS spot_check_verdicts,
       sum(approvals_resolved_by_principal) AS approvals_resolved_by_principal
FROM (SELECT * FROM verdicts UNION ALL SELECT * FROM approvals) u
GROUP BY week
ORDER BY week;

\echo '== done =='
ROLLBACK;
