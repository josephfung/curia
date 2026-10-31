// briefing-service.ts — reads and actions for the principal home (#2340).
//
// Each method backs one console card. A failure throws (or, for the bullpen,
// reports unavailable) so the card can show an error instead of a false zero.

import type { Pool } from 'pg';
import { visibleToolNames, visibleToolWeights } from '../activity/describers.js';
import { OPEN_TASK_STATUSES } from '../agents/prompts/backlog-line.js';
import type { ActionLogRepo } from '../autonomy/action-log-repo.js';
import type { DisclosureDecisionRecorder } from '../autonomy/disclosure-decisions.js';
import type { EventBus } from '../bus/bus.js';
import type { ContactService } from '../contacts/contact-service.js';
import { TaskTerminalStateError, type TaskRepo } from '../db/task-repo.js';
import type { Logger } from '../logger.js';
import type { ExecutionLayer } from '../skills/execution.js';
import {
  AGGREGATE_CACHE_MS,
  BULLPEN_IN_FLIGHT_MS,
  HISTOGRAM_DAYS,
  STATS_WINDOW_DAYS,
  addCalendarDays,
  approvalNeedsDraft,
  approvalReviewSummary,
  hiccupsOver,
  isValidTimeZone,
  localDayKey,
  localMidnight,
  shapeHistogramFromCounts,
  type HistogramCount,
  type HistogramModel,
  type JobOutcome,
} from './briefing.js';
import {
  approveFromConsole,
  denyFromConsole,
  reviewFromConsole,
  type ApprovalOutcome,
  type ApprovalReview,
  type HeldDraftView,
} from './console-approval.js';

const CLEARED_BY = ['principal', 'console', 'ceo'];
const DONE_OUTCOMES: readonly JobOutcome[] = ['success', 'partial'];
const ALL_OUTCOMES: readonly JobOutcome[] = ['success', 'partial', 'failed'];

export interface WaitingTask {
  id: string;
  title: string;
  dueAt: string;
}

export interface WaitingApproval {
  id: number;
  title: string;
  createdAt: string;
  toolName: string;
  summary: string;
  /** True when Approve must wait for the mailbox draft to be loaded. */
  needsDraft: boolean;
}

export interface WaitingResponse {
  timezone: string;
  tasks: WaitingTask[];
  approvals: WaitingApproval[];
  clearedToday: number;
  curiaHandling: number;
}

export interface StatsResponse {
  timezone: string;
  /**
   * Principal-minutes saved in the current and previous 7 local days.
   * Sum of each successful visible tool's estimate. Reads and plumbing are 0.
   */
  minutesSaved: { current: number; previous: number };
  done: { current: number; previous: number };
  contacts: { total: number; newThisWeek: number };
  hiccups: { current: number; byDay: number[] };
  handledSinceYesterday: number;
}

export interface BullpenResponse {
  available: boolean;
  count: number;
  agents: string[];
}

export interface BriefingDeps {
  pool: Pool;
  actionLogRepo: Pick<ActionLogRepo, 'findAllPending' | 'findById' | 'resolveRow' | 'rejectStaleApproval' | 'insert'>;
  taskRepo: Pick<TaskRepo, 'listTasks' | 'updateTask'>;
  contactService: Pick<ContactService, 'findContactBySystemRole'>;
  executionLayer?: Pick<ExecutionLayer, 'invoke' | 'confirmPinnedSendResolution'>;
  disclosureDecisions?: Pick<DisclosureDecisionRecorder, 'recordForApproval'>;
  deleteMailboxDraft?: (account: string | undefined, draftId: string) => Promise<void>;
  loadHeldDraft?: (account: string | undefined, draftId: string) => Promise<HeldDraftView | null>;
  bus?: Pick<EventBus, 'publish'>;
  officeTimezone: string;
  logger: Logger;
}

/** Delegated work can finish after the window's end. Matches audit-log-repo's tail. */
const DELEGATION_TAIL_MS = 6 * 60 * 60 * 1000;
const MAX_DELEGATION_DEPTH = 10;

export class BriefingService {
  private modelCache: { key: string; expires: number; pending: Promise<HistogramModel> } | null = null;

  constructor(private readonly deps: BriefingDeps) {}

  async waiting(now: Date = new Date()): Promise<WaitingResponse> {
    const timezone = await this.timeZone();
    const todayStart = localMidnight(localDayKey(now, timezone), timezone);
    const [tasks, approvals, clearedTasks, clearedApprovals, curiaHandling] = await Promise.all([
      this.deps.taskRepo.listTasks({
        owner: 'ceo',
        statuses: [...OPEN_TASK_STATUSES],
        dueBefore: now,
        limit: 100,
      }),
      this.deps.actionLogRepo.findAllPending(),
      this.count(
        `SELECT count(*)::int AS n FROM tasks
         WHERE owner = 'ceo' AND status IN ('done', 'cancelled') AND updated_at >= $1`,
        [todayStart],
      ),
      this.count(
        `SELECT count(*)::int AS n FROM autonomy_action_log
         WHERE outcome IN ('approved', 'denied', 'resolved_externally')
           AND resolved_at >= $1
           AND resolved_by = ANY($2::text[])`,
        [todayStart, CLEARED_BY],
      ),
      this.count(
        `SELECT count(*)::int AS n FROM tasks
         WHERE owner = 'curia' AND status = ANY($1::text[])`,
        [OPEN_TASK_STATUSES],
      ),
    ]);

    const waitingTasks: WaitingTask[] = tasks.flatMap((task) => {
      // node-pg returns timestamptz as a Date. The list type says string.
      const dueAt = asIso(task.dueAt);
      if (!dueAt) return [];
      return [{
        id: task.id,
        title: task.title.trim() || task.intentAnchor,
        dueAt,
      }];
    })
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

    const waitingApprovals: WaitingApproval[] = approvals
      .map((row) => ({
        id: row.id,
        title: row.description?.trim() || row.toolName,
        createdAt: row.createdAt.toISOString(),
        toolName: row.toolName,
        summary: approvalReviewSummary(row),
        needsDraft: approvalNeedsDraft(row.toolName, row.payload),
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return {
      timezone,
      tasks: waitingTasks,
      approvals: waitingApprovals,
      clearedToday: clearedTasks + clearedApprovals,
      curiaHandling,
    };
  }

  async stats(now: Date = new Date()): Promise<StatsResponse> {
    const timezone = await this.timeZone();
    const model = await this.cachedModel(now, timezone);
    const last7 = model.days.slice(-STATS_WINDOW_DAYS);
    const prev7 = model.days.slice(0, HISTOGRAM_DAYS - STATS_WINDOW_DAYS);
    const sinceYesterday = model.days.slice(-2);
    const currentStart = localMidnight(model.days[HISTOGRAM_DAYS - STATS_WINDOW_DAYS]!.key, timezone);
    const previousStart = localMidnight(model.days[0]!.key, timezone);

    const [minutesSaved, contacts] = await Promise.all([
      this.minutesSaved(previousStart, currentStart, now),
      this.contactCounts(currentStart),
    ]);

    return {
      timezone,
      minutesSaved,
      done: {
        current: outcomeTotal(last7, DONE_OUTCOMES),
        previous: outcomeTotal(prev7, DONE_OUTCOMES),
      },
      contacts,
      hiccups: {
        current: hiccupsOver(model, STATS_WINDOW_DAYS),
        byDay: model.days.map((day) => day.hiccups),
      },
      handledSinceYesterday: outcomeTotal(sinceYesterday, ALL_OUTCOMES),
    };
  }

  async histogram(now: Date = new Date()): Promise<HistogramModel & { timezone: string }> {
    const timezone = await this.timeZone();
    const model = await this.cachedModel(now, timezone);
    return { timezone, ...model };
  }

  /**
   * Distinct agents with an in-flight root task. A failed read reports
   * unavailable so the card keeps its static copy instead of a made-up count.
   */
  async bullpen(now: Date = new Date()): Promise<BullpenResponse> {
    try {
      const since = new Date(now.getTime() - BULLPEN_IN_FLIGHT_MS);
      const result = await this.deps.pool.query<{ agent: string }>(
        `SELECT COALESCE(NULLIF(r.payload->>'agentId', ''), r.source_id) AS agent
         FROM audit_log r
         WHERE r.event_type = 'agent.task'
           AND r.timestamp >= $1
           AND (r.payload->'metadata'->'delegationOrigin'->>'taskEventId') IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM audit_log c
             WHERE c.parent_event_id = r.id::text
               AND c.event_type = 'agent.response'
           )
         GROUP BY 1
         ORDER BY count(*) DESC, agent ASC`,
        [since],
      );
      const agents = result.rows.map((row) => row.agent).filter((agent) => agent.length > 0);
      return { available: true, count: agents.length, agents };
    } catch (err) {
      this.deps.logger.error({ err }, 'briefing: bullpen count failed — static copy');
      return { available: false, count: 0, agents: [] };
    }
  }

  async setTaskStatus(id: string, status: 'done' | 'cancelled'): Promise<ApprovalOutcome> {
    try {
      const updated = await this.deps.taskRepo.updateTask(id, { status }, 'console');
      if (!updated) return { ok: false, status: 404, error: 'Task not found.' };
      return { ok: true, sent: false };
    } catch (err) {
      if (err instanceof TaskTerminalStateError) return { ok: false, status: 400, error: err.message };
      this.deps.logger.error({ err, taskId: id }, 'briefing: task status update failed');
      return { ok: false, status: 500, error: 'Failed to update task.' };
    }
  }

  async preview(id: number): Promise<{ ok: true } & ApprovalReview | { ok: false; status: number; error: string }> {
    const row = await this.deps.actionLogRepo.findById(id);
    if (!row) return { ok: false, status: 404, error: 'Approval not found.' };
    const review = await reviewFromConsole(row, this.deps);
    return { ok: true, ...review };
  }

  async approve(id: number, shown = false): Promise<ApprovalOutcome> {
    return this.resolveApproval(id, 'approve', shown);
  }

  async deny(id: number): Promise<ApprovalOutcome> {
    return this.resolveApproval(id, 'deny');
  }

  private async resolveApproval(id: number, action: 'approve' | 'deny', shown = false): Promise<ApprovalOutcome> {
    const row = await this.deps.actionLogRepo.findById(id);
    if (!row) return { ok: false, status: 404, error: 'Approval not found.' };
    const principalContactId = await this.principalId();
    const deps = { ...this.deps, principalContactId };
    return action === 'approve' ? approveFromConsole(row, deps, new Date(), { shown }) : denyFromConsole(row, deps);
  }

  /**
   * One grouped read of the 14-day window, shared by stats and the histogram.
   * Outcome follows the activity feed: only described, non-hidden tools count,
   * and only failure, error and denied are hard failures. A job the feed drops
   * entirely (no visible call and no error reply) still counts as success.
   */
  private cachedModel(now: Date, timezone: string): Promise<HistogramModel> {
    const today = localDayKey(now, timezone);
    const from = localMidnight(addCalendarDays(today, -(HISTOGRAM_DAYS - 1)), timezone);
    const key = `${timezone}|${from.toISOString()}|${today}`;
    const hit = this.modelCache;
    if (hit && hit.key === key && hit.expires > Date.now()) return hit.pending;
    const pending = this.loadModel(from, now, timezone);
    this.modelCache = { key, expires: Date.now() + AGGREGATE_CACHE_MS, pending };
    pending.catch(() => {
      if (this.modelCache?.pending === pending) this.modelCache = null;
    });
    return pending;
  }

  private async loadModel(from: Date, to: Date, timezone: string): Promise<HistogramModel> {
    const result = await this.deps.pool.query<{ day: string; actor: string; outcome: string; n: number }>(
      HISTOGRAM_SQL,
      [from, to, new Date(to.getTime() + DELEGATION_TAIL_MS), timezone, MAX_DELEGATION_DEPTH, visibleToolNames()],
    );
    const counts: HistogramCount[] = [];
    for (const row of result.rows) {
      if (row.outcome !== 'success' && row.outcome !== 'partial' && row.outcome !== 'failed') continue;
      const n = Number(row.n);
      if (!Number.isFinite(n) || typeof row.day !== 'string') continue;
      counts.push({
        day: row.day,
        actor: typeof row.actor === 'string' ? row.actor : 'agent',
        outcome: row.outcome,
        n,
      });
    }
    return shapeHistogramFromCounts(counts, to, timezone);
  }

  /**
   * Sum of per-tool minutes for successful calls the activity feed would show.
   * The tool name is resolved the same way as HISTOGRAM_SQL (invoke first, then
   * the result). A read, a hidden tool, or a result with no invoke adds nothing.
   */
  private async minutesSaved(
    previousStart: Date,
    currentStart: Date,
    now: Date,
  ): Promise<{ current: number; previous: number }> {
    const weights = visibleToolWeights();
    const result = await this.deps.pool.query<{ current: number; previous: number }>(
      `SELECT
         COALESCE(SUM(w.minutes) FILTER (WHERE r.timestamp >= $2 AND r.timestamp < $3), 0)::float8 AS current,
         COALESCE(SUM(w.minutes) FILTER (WHERE r.timestamp >= $1 AND r.timestamp < $2), 0)::float8 AS previous
       FROM audit_log r
       JOIN audit_log i
         ON r.parent_event_id = i.id::text
        AND i.event_type = ANY(ARRAY['tool.invoke', 'skill.invoke']::text[])
       JOIN unnest($4::text[], $5::float8[]) AS w(name, minutes)
         ON w.name = COALESCE(
           CASE
             WHEN i.target_type = 'skill'
               AND i.target_id IS NOT NULL
               AND i.target_id <> ''
               AND i.target_id <> '[EXTRACTION_FAILED]'
             THEN i.target_id
           END,
           i.payload->>'toolName',
           i.payload->>'skillName',
           CASE
             WHEN r.target_type = 'skill'
               AND r.target_id IS NOT NULL
               AND r.target_id <> ''
               AND r.target_id <> '[EXTRACTION_FAILED]'
             THEN r.target_id
           END,
           r.payload->>'toolName',
           r.payload->>'skillName'
         )
       WHERE r.event_type = ANY($6::text[])
         AND r.timestamp >= $1 AND r.timestamp < $3
         AND (
           r.outcome = 'success'
           OR (r.outcome IS NULL AND r.payload->'result'->>'success' = 'true')
         )`,
      [previousStart, currentStart, now, weights.names, weights.minutes, ['tool.result', 'skill.result']],
    );
    const row = result.rows[0];
    return {
      current: Number(row?.current ?? 0),
      previous: Number(row?.previous ?? 0),
    };
  }

  private async contactCounts(since: Date): Promise<{ total: number; newThisWeek: number }> {
    const result = await this.deps.pool.query<{ total: number; recent: number }>(
      `SELECT
         count(*) FILTER (WHERE kind = 'person')::int AS total,
         count(*) FILTER (WHERE kind = 'person' AND created_at >= $1)::int AS recent
       FROM contacts`,
      [since],
    );
    const row = result.rows[0];
    return { total: Number(row?.total ?? 0), newThisWeek: Number(row?.recent ?? 0) };
  }

  private async count(sql: string, params: unknown[]): Promise<number> {
    const result = await this.deps.pool.query<{ n: number }>(sql, params);
    return Number(result.rows[0]?.n ?? 0);
  }

  private async timeZone(): Promise<string> {
    try {
      const principal = await this.deps.contactService.findContactBySystemRole('principal');
      const zone = principal?.timezone;
      if (zone && isValidTimeZone(zone)) return zone;
    } catch (err) {
      this.deps.logger.warn({ err }, 'briefing: principal timezone lookup failed');
    }
    return isValidTimeZone(this.deps.officeTimezone) ? this.deps.officeTimezone : 'UTC';
  }

  private async principalId(): Promise<string | null> {
    try {
      const principal = await this.deps.contactService.findContactBySystemRole('principal');
      return principal?.id ?? null;
    } catch (err) {
      this.deps.logger.warn({ err }, 'briefing: principal lookup failed');
      return null;
    }
  }
}

function asIso(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

function outcomeTotal(days: HistogramModel['days'], outcomes: readonly JobOutcome[]): number {
  let n = 0;
  for (const day of days) {
    for (const outcome of outcomes) n += day.byOutcome[outcome];
  }
  return n;
}

/**
 * One row per local day, actor and outcome for root jobs in [$1, $2).
 * Delegated tasks fold into their root, up to $5 levels, and may finish as late as $3.
 * A call counts only when the feed would classify it. The tool name is read the
 * same way as readAuditToolName (invoke first, then the result; target_id only
 * when target_type is skill). $6 is the visible set: described and not hidden.
 * Anything else, including a tool with no describer, is left out. An unnamed
 * call is left out too, because NULL never matches. Success is outcome 'success',
 * or any other outcome except failure, error and denied when the payload says
 * success. Those three are failures even if the payload says otherwise. A failed root reply
 * with no successful visible call is a failure; mixed with successes it is partial.
 */
const HISTOGRAM_SQL = `
WITH RECURSIVE chain AS (
  SELECT
    id,
    id AS root_id,
    timestamp AS root_ts,
    COALESCE(NULLIF(payload->>'agentId', ''), NULLIF(source_id, ''), 'agent') AS actor,
    0 AS depth
  FROM audit_log
  WHERE event_type = 'agent.task'
    AND timestamp >= $1
    AND timestamp < $2
    AND (payload->'metadata'->'delegationOrigin'->>'taskEventId') IS NULL
  UNION ALL
  SELECT
    child.id,
    chain.root_id,
    chain.root_ts,
    chain.actor,
    chain.depth + 1
  FROM audit_log child
  JOIN chain ON (child.payload->'metadata'->'delegationOrigin'->>'taskEventId') = chain.id::text
  WHERE child.event_type = 'agent.task'
    AND child.timestamp >= $1
    AND child.timestamp < $3
    AND chain.depth < $5::int
),
roots AS (
  SELECT root_id, root_ts, actor
  FROM chain
  WHERE depth = 0
),
results AS (
  SELECT
    c.root_id,
    CASE
      WHEN r.outcome = 'success' THEN 'ok'
      WHEN r.outcome IN ('failure', 'error', 'denied') THEN 'bad'
      WHEN r.payload->'result'->>'success' = 'true' THEN 'ok'
      ELSE 'bad'
    END AS kind
  FROM audit_log r
  JOIN audit_log i ON r.parent_event_id = i.id::text
  JOIN chain c ON i.parent_event_id = c.id::text
  WHERE r.event_type = ANY(ARRAY['tool.result', 'skill.result']::text[])
    AND i.event_type = ANY(ARRAY['tool.invoke', 'skill.invoke']::text[])
    AND COALESCE(
      CASE
        WHEN i.target_type = 'skill'
          AND i.target_id IS NOT NULL
          AND i.target_id <> ''
          AND i.target_id <> '[EXTRACTION_FAILED]'
        THEN i.target_id
      END,
      i.payload->>'toolName',
      i.payload->>'skillName',
      CASE
        WHEN r.target_type = 'skill'
          AND r.target_id IS NOT NULL
          AND r.target_id <> ''
          AND r.target_id <> '[EXTRACTION_FAILED]'
        THEN r.target_id
      END,
      r.payload->>'toolName',
      r.payload->>'skillName'
    ) = ANY($6::text[])
),
responses AS (
  SELECT c.root_id, bool_or(COALESCE(a.payload->>'isError', '') = 'true') AS failed
  FROM audit_log a
  JOIN chain c ON a.parent_event_id = c.id::text AND c.depth = 0
  WHERE a.event_type = 'agent.response'
  GROUP BY c.root_id
),
classified AS (
  SELECT
    roots.root_ts,
    roots.actor,
    CASE
      WHEN COALESCE(ok.n, 0) > 0 AND COALESCE(bad.n, 0) > 0 THEN 'partial'
      WHEN COALESCE(bad.n, 0) > 0 THEN 'failed'
      WHEN COALESCE(resp.failed, false) AND COALESCE(ok.n, 0) > 0 THEN 'partial'
      WHEN COALESCE(resp.failed, false) THEN 'failed'
      ELSE 'success'
    END AS outcome
  FROM roots
  LEFT JOIN (
    SELECT root_id, count(*)::int AS n FROM results WHERE kind = 'ok' GROUP BY root_id
  ) ok ON ok.root_id = roots.root_id
  LEFT JOIN (
    SELECT root_id, count(*)::int AS n FROM results WHERE kind = 'bad' GROUP BY root_id
  ) bad ON bad.root_id = roots.root_id
  LEFT JOIN responses resp ON resp.root_id = roots.root_id
)
SELECT
  to_char(root_ts AT TIME ZONE $4, 'YYYY-MM-DD') AS day,
  actor,
  outcome,
  count(*)::int AS n
FROM classified
GROUP BY 1, 2, 3`;
