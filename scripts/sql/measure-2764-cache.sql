-- measure-2764-cache.sql: Round-1 cache share and activation path counts (#2764).
--
-- READ-ONLY. Run against prod (or a prod copy) to measure:
--   - Round-1 vs later-round cache share (AC: before/after stable-prefix PR; Layer 3)
--   - Cache share on the first call after a tool-list change (append-only AC)
--   - skill.activated counts by `by` and skill (Layer 3; needs PR 1+ shipped)
--
-- Output is aggregates only — no message content, addresses, or ids beyond counts.
--
--   psql "$DATABASE_URL" -v days=28 -f scripts/sql/measure-2764-cache.sql
--
-- `days` defaults to 28 when omitted. The script prints "== done ==" last.

\set ON_ERROR_STOP on
BEGIN READ ONLY;

SELECT COALESCE(NULLIF(:'days', ''), '28') AS window_days \gset
\echo
\echo '== #2764 cache / activation window (days)' :window_days

\echo
\echo '== 1. Coordinator llm.call cache share by round and activation adjacency'
-- Same grouping as the measurements comment on #2764 (cache share around tool-list changes).
WITH calls AS (
  SELECT parent_event_id AS task, timestamp AS ts,
    (payload->>'inputTokens')::numeric AS inp,
    (payload->>'cacheReadInputTokens')::numeric AS rd,
    row_number() OVER (PARTITION BY parent_event_id ORDER BY timestamp) AS rn
  FROM audit_log
  WHERE event_type = 'llm.call'
    AND source_id = 'coordinator'
    AND timestamp > now() - (:window_days || ' days')::interval
), acts AS (
  SELECT payload->>'taskEventId' AS task, timestamp AS ts
  FROM audit_log
  WHERE event_type = 'tool.invoke'
    AND payload->>'agentId' = 'coordinator'
    AND payload->>'toolName' IN ('skill-activate', 'tool-registry')
    AND timestamp > now() - (:window_days || ' days')::interval
), labelled AS (
  SELECT c.*,
    EXISTS (SELECT 1 FROM acts a WHERE a.task = c.task) AS task_has_act,
    EXISTS (
      SELECT 1 FROM acts a
      JOIN calls p ON p.task = c.task AND p.rn = c.rn - 1
      WHERE a.task = c.task AND a.ts > p.ts AND a.ts < c.ts
    ) AS first_after_act
  FROM calls c
)
SELECT
  CASE
    WHEN first_after_act THEN 'first call after activation'
    WHEN task_has_act THEN 'other, tasks with activation'
    ELSE 'tasks without activation'
  END AS grp,
  CASE WHEN rn = 1 THEN 'round 1' ELSE 'round 2+' END AS rnd,
  count(*) AS n,
  round(100.0 * sum(rd) / nullif(sum(inp + rd), 0), 1) AS pct_cached,
  round(avg(inp)) AS avg_uncached_in
FROM labelled
GROUP BY 1, 2
ORDER BY 1, 2;

\echo
\echo '== 2. skill.activated counts by by + skill (empty until #2764 ships)'
SELECT
  payload->>'by' AS activated_by,
  payload->>'skill' AS skill,
  count(*) AS n
FROM audit_log
WHERE event_type = 'skill.activated'
  AND timestamp > now() - (:window_days || ' days')::interval
GROUP BY 1, 2
ORDER BY n DESC, activated_by, skill;

\echo
\echo '== 3. Coordinator calls per turn + p50/p90 latency'
WITH t AS (
  SELECT id,
    CASE
      WHEN conversation_id LIKE 'scheduler:%' THEN 'sched'
      WHEN payload->>'liveTurn' = 'true' THEN 'live'
      ELSE 'other'
    END AS seg
  FROM audit_log
  WHERE event_type = 'agent.task'
    AND source_id = 'coordinator'
    AND timestamp > now() - (:window_days || ' days')::interval
), c AS (
  SELECT t.seg, t.id, (l.payload->>'latencyMs')::numeric AS ms
  FROM t
  JOIN audit_log l ON l.event_type = 'llm.call' AND l.parent_event_id = t.id::text
)
SELECT seg,
  count(DISTINCT id) AS turns,
  round(count(*)::numeric / count(DISTINCT id), 1) AS calls_per_turn,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::int AS p50_ms,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY ms)::int AS p90_ms
FROM c
GROUP BY 1
ORDER BY 1;

\echo
\echo '== done =='
COMMIT;
