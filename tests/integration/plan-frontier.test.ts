// plan-frontier.test.ts — integration tests for planned-parent frontier advancement (#1238).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { PlanFrontierSubscriber } from '../../src/agents/plan-frontier-subscriber.js';
import { createScheduleFired } from '../../src/bus/events.js';
import { RESUMABLE_CONTINUATION_CREATED_BY } from '../../src/agents/resumable-continuation.js';
import { PLAN_FRONTIER_CHILD_DISPATCH_CREATED_BY } from '../../src/agents/plan-frontier.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'PlanFrontier Test';
const logger = pino({ level: 'silent' });

async function cleanup(pool: pg.Pool): Promise<void> {
  const titleLike = `${PREFIX}%`;
  await pool.query(
    `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [titleLike],
  );
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [titleLike]);
}

describeIf('Plan frontier advancement (#1238)', () => {
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

  it('completing the first child wakes the parent and dispatches blocked siblings', async () => {
    const subscriber = new PlanFrontierSubscriber({
      pool,
      bus,
      logger: logger as never,
      schedulerService,
      taskRepo: repo,
      eligibleAgents: new Set(['coordinator']),
      continuationDelaySeconds: 30,
    });
    subscriber.start();

    const parent = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} parent`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
    });

    const child1 = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} child 1`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: parent.id,
    });
    const child2 = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} child 2`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: parent.id,
      blockedByTaskId: child1.id,
    });
    const child3 = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} child 3 deliverable`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: parent.id,
      blockedByTaskId: child1.id,
    });

    await repo.setPlanBlock(parent.id, {
      steps: [
        { id: 'step-1', taskId: child1.id },
        { id: 'step-2', taskId: child2.id },
        { id: 'step-3', taskId: child3.id },
      ],
      deliverableStepId: 'step-3',
      done: 0,
      total: 3,
      next: 'Complete step 1 first',
    }, 'coordinator');

    await repo.updateTask(child1.id, { status: 'done' }, 'coordinator');

    const parentWakes = await pool.query<{ id: string; created_by: string; status: string }>(
      `SELECT id, created_by, status FROM scheduled_jobs WHERE task_id = $1`,
      [parent.id],
    );
    expect(parentWakes.rows).toHaveLength(1);
    expect(parentWakes.rows[0]!.created_by).toBe(RESUMABLE_CONTINUATION_CREATED_BY);
    expect(parentWakes.rows[0]!.status).toBe('pending');

    await bus.publish('system', createScheduleFired({
      jobId: parentWakes.rows[0]!.id,
      agentId: 'coordinator',
      agentTaskId: parent.id,
      parentEventId: 'test-parent-wake-1',
    }));

    const planAfterFirstWake = await repo.getPlanBlock(parent.id);
    expect(planAfterFirstWake).toMatchObject({ done: 1, total: 3 });

    const childWakes = await pool.query<{ task_id: string; created_by: string }>(
      `SELECT task_id, created_by FROM scheduled_jobs
        WHERE task_id = ANY($1::uuid[]) AND status = 'pending'`,
      [[child2.id, child3.id]],
    );
    expect(childWakes.rows).toHaveLength(2);
    expect(childWakes.rows.every((row) => row.created_by === PLAN_FRONTIER_CHILD_DISPATCH_CREATED_BY)).toBe(true);

    await repo.updateTask(child2.id, { status: 'done' }, 'coordinator');
    await repo.updateTask(child3.id, { status: 'done' }, 'coordinator');

    await bus.publish('system', createScheduleFired({
      jobId: parentWakes.rows[0]!.id,
      agentId: 'coordinator',
      agentTaskId: parent.id,
      parentEventId: 'test-parent-wake-2',
    }));

    const plan = await repo.getPlanBlock(parent.id);
    expect(plan).toMatchObject({ done: 3, total: 3, deliverableStepId: 'step-3' });
  });

  it('deduplicates parent wakes while one is already pending', async () => {
    const subscriber = new PlanFrontierSubscriber({
      pool,
      bus,
      logger: logger as never,
      schedulerService,
      taskRepo: repo,
      eligibleAgents: new Set(['coordinator']),
      continuationDelaySeconds: 30,
    });
    subscriber.start();

    const parent = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} dedup parent`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
    });
    const child1 = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} dedup child 1`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: parent.id,
    });
    const child2 = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} dedup child 2`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: parent.id,
    });
    await repo.setPlanBlock(parent.id, {
      steps: [
        { id: 'first', taskId: child1.id },
        { id: 'second', taskId: child2.id },
      ],
      deliverableStepId: null,
      done: 0,
      total: 2,
      next: 'Finish',
    }, 'coordinator');

    await repo.updateTask(child1.id, { status: 'done' }, 'coordinator');
    await repo.updateTask(child2.id, { status: 'done' }, 'coordinator');

    const parentWakes = await pool.query(
      `SELECT id FROM scheduled_jobs WHERE task_id = $1 AND status = 'pending'`,
      [parent.id],
    );
    expect(parentWakes.rows).toHaveLength(1);
  });
});
