// plan-lifecycle-e2e.test.ts — end-to-end "plan primitive" loop (Phase 2 / #1177 closeout).
//
// The per-PR suites cover each mechanism in isolation (plan block #1236, plan skill
// #1237, frontier #1238, reconciliation/auto-complete #1239, deliverable #1240,
// KG promotion #1241). This is the single test the design memo's "Verification"
// section asks for: a multi-step goal that materializes child rows via the real
// `plan()` skill, advances its frontier as children complete, and auto-completes
// when the subtree resolves — surfacing the deliverable step's output as the
// parent's result, with no orphaned open subtasks left behind.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { PlanFrontierSubscriber } from '../../src/agents/plan-frontier-subscriber.js';
import { createScheduleFired } from '../../src/bus/events.js';
import { DEFAULT_RESUMABLE_CEILINGS } from '../../src/config.js';
import { PlanHandler } from '../../skills/plan/handler.js';
import type { SkillContext } from '../../src/skills/types.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'PlanE2E Test';
const logger = pino({ level: 'silent' });

async function cleanup(pool: pg.Pool): Promise<void> {
  const titleLike = `${PREFIX}%`;
  await pool.query(
    `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [titleLike],
  );
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [titleLike]);
}

describeIf('Plan primitive end-to-end (#1177)', () => {
  let pool: pg.Pool;
  let bus: EventBus;
  let repo: TaskRepo;
  let schedulerService: SchedulerService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await cleanup(pool);
    bus = new EventBus(logger as never);
    repo = new TaskRepo(pool, bus, logger as never, 'UTC');
    schedulerService = new SchedulerService(pool, bus, logger as never, 'UTC');
  });

  function planCtx(input: Record<string, unknown>): SkillContext {
    return {
      input,
      secret: () => 'unused',
      log: logger,
      agentId: 'coordinator',
      taskRepo: repo,
      // The handler only calls agentRegistry.has() to validate target agents.
      agentRegistry: { has: () => true } as unknown as SkillContext['agentRegistry'],
    } as unknown as SkillContext;
  }

  it('materializes a plan, advances the frontier, and auto-completes with the deliverable', async () => {
    const subscriber = new PlanFrontierSubscriber({
      pool,
      bus,
      logger: logger as never,
      schedulerService,
      taskRepo: repo,
      eligibleAgents: new Set(['coordinator']),
      continuationDelaySeconds: 30,
      resumableCeilings: DEFAULT_RESUMABLE_CEILINGS,
    });
    subscriber.start();

    // 1. A goal the LLM judges complex enough to plan.
    const parent = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} design the kickoff`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
    });

    // 2. The real plan() skill materializes child rows directly (rows-direct) and
    //    writes the progress.plan block: gather (atomic) → synth (deliverable).
    const planResult = await new PlanHandler().execute(planCtx({
      task_id: parent.id,
      steps: [
        { id: 'gather', title: `${PREFIX} gather input`, target_agent_id: 'coordinator' },
        {
          id: 'synth',
          title: `${PREFIX} synthesize the kickoff plan`,
          target_agent_id: 'coordinator',
          blocked_by_step_id: 'gather',
        },
      ],
      deliverable_step_id: 'synth',
      next: 'Gather input first',
    }));
    expect(planResult.success).toBe(true);

    const plan = await repo.getPlanBlock(parent.id);
    expect(plan).toMatchObject({ total: 2, deliverableStepId: 'synth' });
    const gatherId = plan!.steps.find((s) => s.id === 'gather')!.taskId!;
    const synthId = plan!.steps.find((s) => s.id === 'synth')!.taskId!;
    expect(gatherId).toBeTruthy();
    expect(synthId).toBeTruthy();

    // Two real child rows materialized under the parent.
    const childCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tasks WHERE parent_task_id = $1`,
      [parent.id],
    );
    expect(childCount.rows[0]!.count).toBe('2');

    // 3. Complete the first child → frontier wakes the parent.
    await repo.updateTask(gatherId, { status: 'done' }, 'coordinator');
    const wakeAfterGather = await pool.query<{ id: string }>(
      `SELECT id FROM scheduled_jobs WHERE task_id = $1 AND status = 'pending'`,
      [parent.id],
    );
    expect(wakeAfterGather.rows).toHaveLength(1);
    const parentWakeId = wakeAfterGather.rows[0]!.id;

    // 4. Fire the wake → frontier dispatches the now-unblocked deliverable child.
    await bus.publish('system', createScheduleFired({
      jobId: parentWakeId,
      agentId: 'coordinator',
      agentTaskId: parent.id,
      parentEventId: 'e2e-wake-1',
    }));
    expect(await repo.getPlanBlock(parent.id)).toMatchObject({ done: 1, total: 2 });
    const synthDispatch = await pool.query(
      `SELECT id FROM scheduled_jobs WHERE task_id = $1 AND status = 'pending'`,
      [synthId],
    );
    expect(synthDispatch.rows).toHaveLength(1);

    // Mark the already-fired gather wake completed (as the scheduler would after a
    // run), so the one-active-wake-per-task dedup frees. This lets us prove synth
    // completion schedules a *fresh* parent wake rather than recycling the gather one.
    await schedulerService.completeJobRun(parentWakeId, true);

    // 5. The deliverable child produces its output and completes.
    const deliverable = `${PREFIX} kickoff plan: agenda, sessions, owners`;
    await repo.updateTask(synthId, { progressNote: deliverable }, 'coordinator');
    await repo.updateTask(synthId, { status: 'done' }, 'coordinator');

    // Synth completion must enqueue a brand-new parent wake (not the gather one).
    const wakeAfterSynth = await pool.query<{ id: string }>(
      `SELECT id FROM scheduled_jobs WHERE task_id = $1 AND status = 'pending'`,
      [parent.id],
    );
    expect(wakeAfterSynth.rows).toHaveLength(1);
    const completionWakeId = wakeAfterSynth.rows[0]!.id;
    expect(completionWakeId).not.toBe(parentWakeId);

    // 6. Fire the fresh wake → subtree resolved → parent auto-completes.
    await bus.publish('system', createScheduleFired({
      jobId: completionWakeId,
      agentId: 'coordinator',
      agentTaskId: parent.id,
      parentEventId: 'e2e-wake-2',
    }));

    const reloadedParent = await repo.getTask(parent.id);
    expect(reloadedParent?.status).toBe('done');

    // The deliverable step's output surfaces as the parent's result.
    const notes = reloadedParent?.progress.notes as Array<{ note: string }> | undefined;
    expect(notes?.some((n) => n.note === deliverable)).toBe(true);

    // No orphaned open subtasks remain (the memo's verification).
    const openDescendants = await pool.query<{ count: string }>(
      `WITH RECURSIVE descendants AS (
         SELECT id, status FROM tasks WHERE parent_task_id = $1
         UNION ALL
         SELECT t.id, t.status FROM tasks t
         INNER JOIN descendants d ON t.parent_task_id = d.id
       )
       SELECT COUNT(*)::text AS count FROM descendants WHERE status NOT IN ('done', 'cancelled', 'failed')`,
      [parent.id],
    );
    expect(openDescendants.rows[0]!.count).toBe('0');
  });
});
