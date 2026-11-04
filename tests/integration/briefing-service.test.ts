// Briefing reads against Postgres (#2340 review): waiting counts, the histogram
// aggregate, open-task counts, the hiccup list and the bullpen query. The unit
// tests mock the pool.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import type { EventBus } from '../../src/bus/bus.js';
import { ActivityService } from '../../src/activity/activity-service.js';
import { timeSavedDetail, timeSavedHelp, UNDESCRIBED_CALL_MINUTES } from '../../src/activity/describers.js';
import { LearnedDescriberRepo } from '../../src/activity/learned-describer-repo.js';
import { AuditLogRepo } from '../../src/audit/audit-log-repo.js';
import { BriefingService } from '../../src/dashboard/briefing-service.js';
import { HISTOGRAM_DAYS, STATS_WINDOW_DAYS, addCalendarDays, localDayKey, localMidnight } from '../../src/dashboard/briefing.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('briefing service against Postgres', () => {
  let pool: pg.Pool;
  const logger = createSilentLogger();

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('counts seeded tasks, approvals and jobs in the principal window, and lists the hiccups', async () => {
    const client = await pool.connect();
    try {
      // REPEATABLE READ pins one snapshot for the whole test. The assertions are
      // deltas against a baseline, and some counts are global (open curia-owned
      // and ceo-owned tasks). Under READ COMMITTED a concurrent test file that
      // commits one between the baseline and the re-read breaks the delta (#2369).
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const now = await emptyFortnight(client);
      const today = localDayKey(now, 'UTC');
      const yesterday = addCalendarDays(today, -1);
      const bus = { publish: async () => {} } as unknown as EventBus;
      const service = new BriefingService({
        pool: asPool(client),
        actionLogRepo: new ActionLogRepo(client as unknown as pg.Pool, logger),
        taskRepo: new TaskRepo(client as unknown as pg.Pool, bus, logger),
        contactService: { findContactBySystemRole: async () => null },
        activity: new ActivityService({
          auditLogRepo: new AuditLogRepo(client as unknown as pg.Pool, logger),
          contactService: {
            getContact: async () => null,
            findContactBySystemRole: async () => null,
            resolveByChannelIdentity: async () => null,
          } as unknown as ConstructorParameters<typeof ActivityService>[0]['contactService'],
          officeTimezone: 'UTC',
          logger,
        }),
        officeTimezone: 'UTC',
        logger,
      });

      const beforeWaiting = await service.waiting(now);
      const beforeOpen = await client.query<{ total: number; overdue: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE due_at < $1)::int AS overdue
         FROM tasks
         WHERE owner = 'ceo' AND status IN ('open', 'in_progress', 'blocked', 'waiting')`,
        [now],
      );

      const title = `Briefing aggregate ${randomUUID()}`;
      await client.query(
        `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, created_by, tags, updated_at, due_at)
         VALUES ('coordinator', $1, 'seeded', 'open', '{}'::jsonb, '{}'::jsonb, 'ceo', 50, 'agent', 'test', '{}', $2, $3)`,
        [title, now, new Date(now.getTime() - 86_400_000)],
      );
      await client.query(
        `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, created_by, tags, updated_at)
         VALUES ('coordinator', $1, 'seeded', 'open', '{}'::jsonb, '{}'::jsonb, 'curia', 50, 'agent', 'test', '{}', $2)`,
        [`${title} curia`, now],
      );
      await client.query(
        `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, created_by, tags, updated_at)
         VALUES ('coordinator', $1, 'seeded', 'done', '{}'::jsonb, '{}'::jsonb, 'ceo', 50, 'agent', 'test', '{}', $2)`,
        [`${title} done`, now],
      );
      await client.query(
        `INSERT INTO autonomy_action_log
           (task_id, skill_name, action_risk, outcome, payload, description, expires_at, created_at)
         VALUES ('briefing-itest', 'email-send', 'medium', 'pending_approval', $1::jsonb, $2, '2099-01-01', $3)`,
        [JSON.stringify({ to: 'ada@example.com', subject: 'Renewal', body: 'Please sign.' }), `${title} approval`, now],
      );
      await client.query(
        `INSERT INTO autonomy_action_log
           (task_id, skill_name, action_risk, outcome, resolved_at, resolved_by, created_at)
         VALUES ('briefing-itest', 'email-send', 'medium', 'approved', $1, 'console', $1)`,
        [now],
      );
      await client.query(
        `INSERT INTO tasks (agent_id, title, intent_anchor, status, progress, error_budget, owner, priority, source, created_by, tags, updated_at)
         VALUES ('coordinator', $1, 'seeded', 'blocked', '{}'::jsonb, '{}'::jsonb, 'ceo', 50, 'agent', 'test', '{}', $2)`,
        [`${title} blocked`, now],
      );

      const successRoot = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 5 * 60_000),
        eventType: 'agent.task',
        payload: { agentId: 'coordinator' },
      });
      const successInvoke = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 4 * 60_000),
        eventType: 'tool.invoke',
        parentEventId: successRoot,
        payload: { toolName: 'email-archive' },
      });
      await seedAudit(client, {
        timestamp: new Date(now.getTime() - 3 * 60_000),
        eventType: 'tool.result',
        parentEventId: successInvoke,
        outcome: 'success',
        payload: { result: { success: true } },
      });

      const partialRoot = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 2 * 3_600_000),
        eventType: 'agent.task',
        payload: { agentId: 'research' },
      });
      const partialInvoke = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 2 * 3_600_000 + 1000),
        eventType: 'tool.invoke',
        parentEventId: partialRoot,
        payload: { toolName: 'email-archive' },
      });
      await seedAudit(client, {
        timestamp: new Date(now.getTime() - 2 * 3_600_000 + 2000),
        eventType: 'tool.result',
        parentEventId: partialInvoke,
        outcome: 'success',
        payload: { result: { success: true } },
      });
      const delegated = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 2 * 3_600_000 + 3000),
        eventType: 'agent.task',
        payload: { agentId: 'specialist', metadata: { delegationOrigin: { taskEventId: partialRoot } } },
      });
      const delegatedInvoke = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 2 * 3_600_000 + 4000),
        eventType: 'tool.invoke',
        parentEventId: delegated,
        payload: { toolName: 'email-send' },
      });
      // denied stays a failure even when the legacy payload says the call worked.
      await seedAudit(client, {
        timestamp: new Date(now.getTime() - 2 * 3_600_000 + 5000),
        eventType: 'tool.result',
        parentEventId: delegatedInvoke,
        outcome: 'denied',
        payload: { result: { success: true } },
      });

      const replyRoot = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 3 * 3_600_000),
        eventType: 'agent.task',
        payload: { agentId: 'calendar' },
      });
      await seedAudit(client, {
        timestamp: new Date(now.getTime() - 3 * 3_600_000 + 1000),
        eventType: 'agent.response',
        parentEventId: replyRoot,
        payload: { isError: true },
      });

      // A failed hidden call beside a visible success is still a success.
      const quietRoot = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 90 * 60_000),
        eventType: 'agent.task',
        payload: { agentId: 'contacts' },
      });
      const quietInvoke = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 90 * 60_000 + 1000),
        eventType: 'tool.invoke',
        parentEventId: quietRoot,
        payload: { toolName: 'email-archive' },
      });
      await seedAudit(client, {
        timestamp: new Date(now.getTime() - 90 * 60_000 + 2000),
        eventType: 'tool.result',
        parentEventId: quietInvoke,
        outcome: 'success',
        payload: { result: { success: true } },
      });
      const hiddenInvoke = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 90 * 60_000 + 3000),
        eventType: 'tool.invoke',
        parentEventId: quietRoot,
        targetType: 'skill',
        targetId: 'extract-facts',
        payload: { toolName: 'extract-facts' },
      });
      await seedAudit(client, {
        timestamp: new Date(now.getTime() - 90 * 60_000 + 4000),
        eventType: 'tool.result',
        parentEventId: hiddenInvoke,
        outcome: 'failure',
        payload: { result: { success: false } },
      });
      // contact-lookup has no describer, so the feed treats it as hidden too.
      const lookupFail = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 90 * 60_000 + 5000),
        eventType: 'tool.invoke',
        parentEventId: quietRoot,
        payload: { toolName: 'contact-lookup' },
      });
      await seedAudit(client, {
        timestamp: new Date(now.getTime() - 90 * 60_000 + 6000),
        eventType: 'tool.result',
        parentEventId: lookupFail,
        outcome: 'failure',
        payload: { result: { success: false } },
      });

      // An outcome other than failure/error/denied falls back to the payload.
      const fallbackRoot = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 4 * 3_600_000),
        eventType: 'agent.task',
        payload: { agentId: 'digest' },
      });
      const fallbackInvoke = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 4 * 3_600_000 + 1000),
        eventType: 'tool.invoke',
        parentEventId: fallbackRoot,
        payload: { toolName: 'email-archive' },
      });
      await seedAudit(client, {
        timestamp: new Date(now.getTime() - 4 * 3_600_000 + 2000),
        eventType: 'tool.result',
        parentEventId: fallbackInvoke,
        outcome: 'skipped',
        payload: { result: { success: true } },
      });

      const yesterdayRoot = await seedAudit(client, {
        timestamp: new Date(now.getTime() - 26 * 3_600_000),
        eventType: 'agent.task',
        payload: { agentId: 'ceo-inbox' },
      }).then(async (root) => {
        const invoke = await seedAudit(client, {
          timestamp: new Date(now.getTime() - 26 * 3_600_000 + 1000),
          eventType: 'tool.invoke',
          parentEventId: root,
          payload: { toolName: 'email-archive' },
        });
        await seedAudit(client, {
          timestamp: new Date(now.getTime() - 26 * 3_600_000 + 2000),
          eventType: 'tool.result',
          parentEventId: invoke,
          outcome: 'failure',
          payload: { result: { success: false } },
        });
        return root;
      });

      await seedAudit(client, {
        timestamp: new Date(now.getTime() - (HISTOGRAM_DAYS + 3) * 86_400_000),
        eventType: 'agent.task',
        payload: { agentId: 'coordinator' },
      });

      const waiting = await service.waiting(now);
      expect(waiting.tasks.some((task) => task.title === title)).toBe(true);
      expect(waiting.curiaHandling - beforeWaiting.curiaHandling).toBe(1);
      expect(waiting.clearedToday - beforeWaiting.clearedToday).toBe(2);
      const approval = waiting.approvals.find((item) => item.title === `${title} approval`);
      expect(approval?.summary).toContain('Body: Please sign.');
      expect(approval?.needsDraft).toBe(false);

      const stats = await service.stats(now);
      const histogram = await service.histogram(now);
      // Seeded: one open and overdue, one blocked with no due date; done is not open.
      const open = beforeOpen.rows[0]!;
      expect(stats.openTasks.total).toBe(Number(open.total) + 2);
      expect(stats.openTasks.overdue).toBe(Number(open.overdue) + 1);
      expect(stats.hiccups.current).toBe(histogram.days.slice(-7).reduce((sum, day) => sum + day.hiccups, 0));

      const todayBar = histogram.days.find((day) => day.key === today);
      const yesterdayBar = histogram.days.find((day) => day.key === yesterday);
      expect(todayBar).toMatchObject({ total: 5, hiccups: 2 });
      expect(todayBar?.byAgent['coordinator']).toBe(1);
      expect(todayBar?.byAgent['research']).toBe(1);
      expect(todayBar?.byAgent['contacts']).toBe(1);
      expect(todayBar?.byOutcome).toMatchObject({ success: 3, partial: 1, failed: 1 });
      expect(yesterdayBar).toMatchObject({ total: 1, hiccups: 1 });
      expect(stats.done.current).toBe(4);
      expect(stats.handledSinceYesterday).toBe(6);

      // The list behind the tile holds the same jobs as its number, newest first.
      const hiccups = await service.hiccups(now);
      expect(hiccups.total).toBe(stats.hiccups.current);
      expect(hiccups.items.map((item) => item.id)).toEqual([partialRoot, replyRoot, yesterdayRoot]);
      expect(hiccups.items.map((item) => item.outcome)).toEqual(['partial', 'failed', 'failed']);
      const yesterdayOnly = await service.hiccups(now, yesterday);
      expect(yesterdayOnly).toMatchObject({ day: yesterday, total: 1 });
      expect(yesterdayOnly.items.map((item) => item.id)).toEqual([yesterdayRoot]);

      const bullpen = await service.bullpen(now);
      expect(bullpen).toEqual({ available: true, count: 1, agents: ['coordinator'] });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('sums weighted visible actions, the undescribed default, and zero for hidden plumbing', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const now = await emptyFortnight(client);
      const bus = { publish: async () => {} } as unknown as EventBus;
      const service = new BriefingService({
        pool: asPool(client),
        actionLogRepo: new ActionLogRepo(client as unknown as pg.Pool, logger),
        taskRepo: new TaskRepo(client as unknown as pg.Pool, bus, logger),
        contactService: { findContactBySystemRole: async () => null },
        officeTimezone: 'UTC',
        logger,
      });

      // One turn: lookups, plumbing, a file read, then the actions that count.
      const currentAt = new Date(now.getTime() - 60 * 60_000);
      const root = await seedAudit(client, {
        timestamp: currentAt,
        eventType: 'agent.task',
        payload: { agentId: 'coordinator' },
      });
      let step = 0;
      const succeed = async (
        parent: string,
        tool: string,
        at: Date,
        opts: {
          eventType?: string;
          targetId?: string;
          outcome?: string | null;
          skillName?: boolean;
          input?: Record<string, unknown>;
        } = {},
      ) => {
        step += 1;
        const atInvoke = new Date(at.getTime() + step * 1000);
        const invokeType = opts.eventType === 'skill.result' ? 'skill.invoke' : 'tool.invoke';
        const resultType = opts.eventType ?? 'tool.result';
        const named = opts.skillName ? { skillName: tool } : { toolName: tool };
        const invoke = await seedAudit(client, {
          timestamp: atInvoke,
          eventType: invokeType,
          parentEventId: parent,
          payload: {
            ...(opts.targetId ? {} : named),
            ...(opts.input ? { input: opts.input } : {}),
          },
          targetType: opts.targetId ? 'skill' : undefined,
          targetId: opts.targetId,
        });
        const outcome = opts.outcome === undefined ? 'success' : opts.outcome;
        await seedAudit(client, {
          timestamp: new Date(atInvoke.getTime() + 1),
          eventType: resultType,
          parentEventId: invoke,
          // Null outcome still counts when the payload says the call worked.
          ...(outcome === null ? {} : { outcome }),
          // A target_id-only call must not also carry the name in the payload.
          payload: opts.targetId ? { result: { success: true } } : { ...named, result: { success: true } },
        });
      };

      for (const tool of ['contact-lookup', 'entity-context', 'ceo-inbox-search', 'extract-facts', 'web-search', 'file-parse']) {
        await succeed(root, tool, currentAt);
      }
      // Shipped zero-effort tools are hidden. They must not add the default.
      for (const tool of ['ceo-inbox-list', 'task-list', 'contact-register', 'bullpen-post', 'ceo-inbox-shadow-draft']) {
        await succeed(root, tool, currentAt);
      }
      await succeed(root, 'ceo-inbox-draft-reply', currentAt);
      await succeed(root, 'email-archive', currentAt);
      await succeed(root, 'calendar-create-event', currentAt);
      // Name lives only on the invoke's structured column.
      await succeed(root, 'email-archive', currentAt, { targetId: 'email-archive' });
      // Pre-rename rows, and a null outcome whose payload says success.
      await succeed(root, 'email-label', currentAt, { eventType: 'skill.result', skillName: true, outcome: null });
      // Any outcome other than failure, error, or denied still counts when the payload says success.
      await succeed(root, 'email-archive', currentAt, { outcome: 'skipped' });
      // The feed hides a dry run, so it adds nothing.
      await succeed(root, 'contact-merge', currentAt, {
        input: { dry_run: true, primary_contact_id: 'a', secondary_contact_id: 'b' },
      });
      // An invoke whose parent is not an agent.task never reaches Recent Activity.
      const noise = await seedAudit(client, {
        timestamp: new Date(currentAt.getTime() + 40_000),
        eventType: 'agent.response',
        payload: { text: 'not a task' },
      });
      await succeed(noise, 'calendar-create-event', currentAt);

      const failedInvoke = await seedAudit(client, {
        timestamp: new Date(currentAt.getTime() + 30_000),
        eventType: 'tool.invoke',
        parentEventId: root,
        payload: { toolName: 'email-send' },
      });
      await seedAudit(client, {
        timestamp: new Date(currentAt.getTime() + 31_000),
        eventType: 'tool.result',
        parentEventId: failedInvoke,
        outcome: 'failure',
        payload: { toolName: 'email-send', result: { success: false } },
      });
      // A result whose parent is the task, not an invoke, is not a call.
      await seedAudit(client, {
        timestamp: new Date(currentAt.getTime() + 32_000),
        eventType: 'tool.result',
        parentEventId: root,
        outcome: 'success',
        payload: { toolName: 'calendar-create-event', result: { success: true } },
      });

      const previousAt = new Date(now.getTime() - 10 * 86_400_000);
      const previousRoot = await seedAudit(client, {
        timestamp: previousAt,
        eventType: 'agent.task',
        payload: { agentId: 'calendar' },
      });
      await succeed(previousRoot, 'calendar-create-event', previousAt);

      // Starts 10 minutes before the current window; its result lands 10 minutes after.
      // Both tiles use the root timestamp, so the meeting stays in the previous window.
      const todayKey = localDayKey(now, 'UTC');
      const windowStart = localMidnight(addCalendarDays(todayKey, -(STATS_WINDOW_DAYS - 1)), 'UTC');
      const boundaryRoot = await seedAudit(client, {
        timestamp: new Date(windowStart.getTime() - 10 * 60_000),
        eventType: 'agent.task',
        payload: { agentId: 'calendar' },
      });
      await succeed(boundaryRoot, 'calendar-create-event', new Date(windowStart.getTime() + 10 * 60_000));

      const stats = await service.stats(now);
      // 5 draft + 0.5 archive + 10 meeting + 0.5 archive-by-target-id + 0.5 label
      // + 0.5 skipped-but-successful archive. Three unlisted lookups add the
      // default each, as one day's count. extract-facts, web-search, file-parse,
      // and the five hidden zero-effort tools add 0. Dry-run and the non-task
      // invoke add 0.
      const unlistedLookups = 3 * UNDESCRIBED_CALL_MINUTES;
      expect(stats.minutesSaved.current).toBeCloseTo(17 + unlistedLookups);
      expect(stats.done.current).toBe(1);
      // The earlier meeting plus the one that started just before this window.
      expect(stats.minutesSaved.previous).toBeCloseTo(20);
      expect(stats.done.previous).toBe(2);
      expect(stats.minutesSaved.help).toBe(timeSavedHelp());
      expect(stats.minutesSaved.detail).toBe(timeSavedDetail());
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('counts undescribed writes as the feed does: learned rows per agent, known writes, never reads (#2455)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const now = await emptyFortnight(client);
      const suffix = randomUUID().slice(0, 8);
      const expenses = `expenses-${suffix}`;
      const sheetWrite = `sheet-append-${suffix}`;
      const sheetRead = `sheet-read-${suffix}`;
      const payment = `custom-payment-${suffix}`;
      await client.query(
        `INSERT INTO activity_describers (agent_id, tool_name, effect, verb, one, many, attempt, description_hash, source)
         VALUES ($1, $2, 'write', 'logged', 'an expense', 'expenses', 'log an expense', 'h', 'learned'),
                ($1, $3, 'read', 'checked', 'the expense sheet', 'the expense sheet', 'check the expense sheet', 'h', 'hint')`,
        [expenses, sheetWrite, sheetRead],
      );
      const activity = new ActivityService({
        auditLogRepo: new AuditLogRepo(client as unknown as pg.Pool, logger),
        contactService: {
          getContact: async () => null,
          findContactBySystemRole: async () => null,
          resolveByChannelIdentity: async () => null,
        } as unknown as ConstructorParameters<typeof ActivityService>[0]['contactService'],
        describers: new LearnedDescriberRepo(client),
        knownWriteTools: () => [payment],
        officeTimezone: 'UTC',
        logger,
      });
      const bus = { publish: async () => {} } as unknown as EventBus;
      const service = new BriefingService({
        pool: asPool(client),
        actionLogRepo: new ActionLogRepo(client as unknown as pg.Pool, logger),
        taskRepo: new TaskRepo(client as unknown as pg.Pool, bus, logger),
        contactService: { findContactBySystemRole: async () => null },
        activity,
        knownWriteTools: () => [payment],
        officeTimezone: 'UTC',
        logger,
      });

      let minute = 0;
      const at = () => new Date(now.getTime() - 3 * 3_600_000 + (minute += 1) * 60_000);
      const root = (agentId: string, metadata?: Record<string, unknown>) =>
        seedAudit(client, { timestamp: at(), eventType: 'agent.task', payload: { agentId, channelId: 'internal', ...(metadata ? { metadata } : {}) } });
      const call = async (taskId: string, toolName: string, ok: boolean) => {
        const invoke = await seedAudit(client, { timestamp: at(), eventType: 'tool.invoke', parentEventId: taskId, payload: { toolName } });
        await seedAudit(client, {
          timestamp: at(),
          eventType: 'tool.result',
          parentEventId: invoke,
          outcome: ok ? 'success' : 'failure',
          payload: { result: ok ? { success: true, data: {} } : { success: false, error: 'quota' } },
        });
      };

      const loggedOnly = await root(expenses);
      await call(loggedOnly, sheetWrite, true);
      await call(loggedOnly, sheetWrite, true);
      const partial = await root(expenses);
      await call(partial, sheetWrite, true);
      await call(partial, sheetWrite, false);
      const failedAlone = await root(expenses);
      await call(failedAlone, sheetWrite, false);
      // A retried read: the failure is never a hiccup.
      const retriedRead = await root(expenses);
      await call(retriedRead, sheetRead, false);
      await call(retriedRead, sheetRead, true);
      // A known write with no row.
      const knownWrite = await root(expenses);
      await call(knownWrite, payment, false);
      // A specialist's failed write under the coordinator's job, keyed by the specialist.
      const delegating = await root('coordinator');
      const specialist = await root(expenses, { delegationOrigin: { taskEventId: delegating } });
      await call(specialist, sheetWrite, false);
      // The same tool from an agent with no row and no signal stays out.
      const otherAgent = await root(`other-${suffix}`);
      await call(otherAgent, sheetWrite, false);

      const stats = await service.stats(now);
      const hiccups = await service.hiccups(now);
      expect(hiccups.total).toBe(stats.hiccups.current);
      expect(hiccups.items.map((item) => [item.id, item.outcome])).toEqual([
        [delegating, 'failed'],
        [knownWrite, 'failed'],
        [failedAlone, 'failed'],
        [partial, 'partial'],
      ]);
      expect(hiccups.total).toBe(4);

      const histogram = await service.histogram(now);
      const today = histogram.days.find((day) => day.key === localDayKey(now, 'UTC'));
      expect(today).toMatchObject({ hiccups: 4 });
      expect(today?.byOutcome).toMatchObject({ partial: 1, failed: 3 });

      // The feed agrees, row by row, and names no tool.
      const feed = await activity.listByIds([loggedOnly, partial, failedAlone, retriedRead, knownWrite, delegating], now);
      const byId = new Map(feed.map((item) => [item.id, item]));
      expect(byId.get(loggedOnly)).toMatchObject({ headline: 'logged 2 expenses', outcome: 'success' });
      expect(byId.get(partial)).toMatchObject({ headline: 'logged an expense', outcome: 'partial' });
      expect(byId.get(failedAlone)).toMatchObject({ headline: "couldn't log an expense", outcome: 'failed' });
      expect(byId.get(retriedRead)).toMatchObject({ headline: 'checked the expense sheet', outcome: 'success' });
      expect(byId.get(knownWrite)).toMatchObject({ headline: "couldn't finish an action", outcome: 'failed' });
      expect(byId.get(delegating)).toMatchObject({ outcome: 'failed' });
      const text = feed.flatMap((item) => [item.headline, ...item.details]).join('\n');
      for (const tool of [sheetWrite, sheetRead, payment]) expect(text).not.toContain(tool);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

async function emptyFortnight(client: pg.PoolClient): Promise<Date> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const day = new Date(Date.UTC(1972, 0, 1) + Math.floor(Math.random() * 6_000) * 86_400_000);
    day.setUTCHours(15, 0, 0, 0);
    const today = localDayKey(day, 'UTC');
    const from = localMidnight(addCalendarDays(today, -(HISTOGRAM_DAYS - 1)), 'UTC');
    const found = await client.query(
      'SELECT 1 FROM audit_log WHERE timestamp >= $1 AND timestamp < $2 LIMIT 1',
      [new Date(from.getTime() - 5 * 86_400_000), new Date(day.getTime() + 8 * 3_600_000)],
    );
    if (found.rowCount === 0) return day;
  }
  throw new Error('no unused audit_log fortnight for the briefing test');
}

/**
 * The test's client, shaped as the pool the service reads from, so every read
 * sees the seeded rows in the open transaction. connect() hands back the same
 * client; release() leaves it to the test.
 */
function asPool(client: pg.PoolClient): pg.Pool {
  const query = client.query.bind(client);
  return { query, connect: async () => ({ query, release: () => {} }) } as unknown as pg.Pool;
}

async function seedAudit(
  client: pg.PoolClient,
  opts: {
    timestamp: Date;
    eventType: string;
    payload: Record<string, unknown>;
    parentEventId?: string;
    outcome?: string;
    targetType?: string;
    targetId?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO audit_log (id, timestamp, event_type, source_layer, source_id, payload, parent_event_id, outcome, target_type, target_id)
     VALUES ($1, $2, $3, 'test-briefing', 'coordinator', $4::jsonb, $5, $6, $7, $8)`,
    [
      id,
      opts.timestamp,
      opts.eventType,
      JSON.stringify(opts.payload),
      opts.parentEventId ?? null,
      opts.outcome ?? null,
      opts.targetType ?? null,
      opts.targetId ?? null,
    ],
  );
  return id;
}
