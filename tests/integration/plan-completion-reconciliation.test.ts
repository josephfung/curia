// plan-completion-reconciliation.test.ts — completion reconciliation + frontier circuit breaker (#1239).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import type { Logger } from '../../src/logger.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { PlanFrontierSubscriber } from '../../src/agents/plan-frontier-subscriber.js';
import { createScheduleFired } from '../../src/bus/events.js';
import { DEFAULT_RESUMABLE_CEILINGS } from '../../src/config.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'PlanReconcile Test';
const logger: Logger = pino({ level: 'silent' });

async function cleanup(pool: pg.Pool): Promise<void> {
  const titleLike = `${PREFIX}%`;
  await pool.query(
    `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [titleLike],
  );
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [titleLike]);
}

describeIf('Plan completion reconciliation (#1239)', () => {
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
    bus = new EventBus(logger);
    repo = new TaskRepo(pool, bus, logger, 'UTC');
    schedulerService = new SchedulerService(pool, bus, logger, 'UTC');
  });

  it('reconcile-on-done leaves no open descendant children', async () => {
    const parent = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} parent reconcile`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
    });
    const child = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} orphan child`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: parent.id,
    });
    const grandchild = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} orphan grandchild`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: child.id,
    });

    await schedulerService.enqueueTaskWake({
      taskId: child.id,
      agentId: 'coordinator',
      runAt: new Date(Date.now() + 60_000),
      createdBy: 'test',
    });
    await schedulerService.enqueueTaskWake({
      taskId: grandchild.id,
      agentId: 'coordinator',
      runAt: new Date(Date.now() + 60_000),
      createdBy: 'test',
    });

    await repo.completeTask(parent.id, 'Parent finished early', 'coordinator');

    const reloadedChild = await repo.getTask(child.id);
    const reloadedGrandchild = await repo.getTask(grandchild.id);
    expect(reloadedChild?.status).toBe('cancelled');
    expect(reloadedGrandchild?.status).toBe('cancelled');

    const openChildren = await pool.query<{ count: string }>(
      `WITH RECURSIVE descendants AS (
         SELECT id, status FROM tasks WHERE parent_task_id = $1
         UNION ALL
         SELECT t.id, t.status FROM tasks t
         INNER JOIN descendants d ON t.parent_task_id = d.id
       )
       SELECT COUNT(*)::text AS count FROM descendants WHERE status NOT IN ('done', 'cancelled', 'failed')`,
      [parent.id],
    );
    expect(openChildren.rows[0]!.count).toBe('0');

    const pendingWakes = await pool.query(
      `SELECT id FROM scheduled_jobs
        WHERE task_id = ANY($1::uuid[]) AND status IN ('pending', 'running')`,
      [[child.id, grandchild.id]],
    );
    expect(pendingWakes.rows).toHaveLength(0);
  });

  it('auto-completes the parent when all children and the deliverable step are done', async () => {
    const subscriber = new PlanFrontierSubscriber({
      pool,
      bus,
      logger,
      schedulerService,
      taskRepo: repo,
      eligibleAgents: new Set(['coordinator']),
      continuationDelaySeconds: 30,
      resumableCeilings: DEFAULT_RESUMABLE_CEILINGS,
    });
    subscriber.start();

    const parent = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} auto-complete parent`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
    });
    const child1 = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} auto child 1`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: parent.id,
    });
    const child2 = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} auto child 2 deliverable`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: parent.id,
    });
    await repo.updateTask(child2.id, { progressNote: 'Deliverable synthesis output' }, 'coordinator');
    await repo.updateTask(child1.id, { status: 'done' }, 'coordinator');
    await repo.updateTask(child2.id, { status: 'done' }, 'coordinator');

    await repo.setPlanBlock(parent.id, {
      steps: [
        { id: 'step-1', taskId: child1.id },
        { id: 'step-2', taskId: child2.id },
      ],
      deliverableStepId: 'step-2',
      done: 2,
      total: 2,
      next: 'Done',
    }, 'coordinator');

    const parentWake = await schedulerService.enqueueTaskWake({
      taskId: parent.id,
      agentId: 'coordinator',
      runAt: new Date(),
      createdBy: 'test',
    });

    await bus.publish('system', createScheduleFired({
      jobId: parentWake.jobId,
      agentId: 'coordinator',
      agentTaskId: parent.id,
      parentEventId: 'auto-complete-wake',
    }));

    const reloadedParent = await repo.getTask(parent.id);
    expect(reloadedParent?.status).toBe('done');
    const notes = reloadedParent?.progress.notes as Array<{ note: string }> | undefined;
    expect(notes?.some((n) => n.note === 'Deliverable synthesis output')).toBe(true);
  });

  it('auto-completes the parent with a child-summary rollup when no deliverable is marked', async () => {
    const subscriber = new PlanFrontierSubscriber({
      pool,
      bus,
      logger,
      schedulerService,
      taskRepo: repo,
      eligibleAgents: new Set(['coordinator']),
      continuationDelaySeconds: 30,
      resumableCeilings: DEFAULT_RESUMABLE_CEILINGS,
    });
    subscriber.start();

    const parent = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} rollup parent`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
    });
    const child1 = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} rollup child 1`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: parent.id,
    });
    const child2 = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} rollup child 2`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: parent.id,
    });
    await repo.updateTask(child1.id, { progressNote: 'Found 12 competitors' }, 'coordinator');
    await repo.updateTask(child2.id, { progressNote: 'Outline complete' }, 'coordinator');
    await repo.updateTask(child1.id, { status: 'done' }, 'coordinator');
    await repo.updateTask(child2.id, { status: 'done' }, 'coordinator');

    await repo.setPlanBlock(parent.id, {
      steps: [
        { id: 'step-1', taskId: child1.id },
        { id: 'step-2', taskId: child2.id },
      ],
      deliverableStepId: null,
      done: 2,
      total: 2,
      next: 'Done',
    }, 'coordinator');

    const parentWake = await schedulerService.enqueueTaskWake({
      taskId: parent.id,
      agentId: 'coordinator',
      runAt: new Date(),
      createdBy: 'test',
    });

    await bus.publish('system', createScheduleFired({
      jobId: parentWake.jobId,
      agentId: 'coordinator',
      agentTaskId: parent.id,
      parentEventId: 'rollup-auto-complete-wake',
    }));

    const reloadedParent = await repo.getTask(parent.id);
    expect(reloadedParent?.status).toBe('done');
    const notes = reloadedParent?.progress.notes as Array<{ note: string }> | undefined;
    const completionNote = notes?.find((n) => n.note.includes('Found 12 competitors'))?.note;
    expect(completionNote).toBe(
      `${PREFIX} rollup child 1: Found 12 competitors\n\n${PREFIX} rollup child 2: Outline complete`,
    );
  });

  it('escalates a planned parent that wakes with no frontier progress', async () => {
    const ceilings = { ...DEFAULT_RESUMABLE_CEILINGS, maxStalls: 2 };
    const subscriber = new PlanFrontierSubscriber({
      pool,
      bus,
      logger,
      schedulerService,
      taskRepo: repo,
      eligibleAgents: new Set(['coordinator']),
      continuationDelaySeconds: 30,
      resumableCeilings: ceilings,
    });
    subscriber.start();

    const parent = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} stalled parent`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
    });
    const child = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} stalled child`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: parent.id,
    });
    await repo.setPlanBlock(parent.id, {
      steps: [{ id: 'only', taskId: child.id }],
      deliverableStepId: 'only',
      done: 0,
      total: 1,
      next: 'Waiting on child',
    }, 'coordinator');

    await repo.persistResumableCircuitState(parent.id, {
      stallCount: 1,
      iterationCount: 3,
      startedAt: new Date().toISOString(),
      totalCostUsd: 0,
      lastProgress: { done: 0, cursor: { terminalChildren: 0 } },
    });

    const parentWake = await schedulerService.enqueueTaskWake({
      taskId: parent.id,
      agentId: 'coordinator',
      runAt: new Date(),
      createdBy: 'test',
    });

    await bus.publish('system', createScheduleFired({
      jobId: parentWake.jobId,
      agentId: 'coordinator',
      agentTaskId: parent.id,
      parentEventId: 'stalled-wake',
    }));

    const reloaded = await repo.getTask(parent.id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.tags).toContain('needs-attention');
  });

  it('does not trip the breaker when the frontier advances between wakes', async () => {
    const ceilings = { ...DEFAULT_RESUMABLE_CEILINGS, maxStalls: 2 };

    const parent = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} healthy parent`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
    });
    const child1 = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} healthy child 1`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: parent.id,
    });
    const child2 = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} healthy child 2`,
      source: 'coordinator',
      sourceAgentId: 'coordinator',
      parentTaskId: parent.id,
      blockedByTaskId: child1.id,
    });
    await repo.setPlanBlock(parent.id, {
      steps: [
        { id: 'first', taskId: child1.id },
        { id: 'second', taskId: child2.id },
      ],
      deliverableStepId: 'second',
      done: 0,
      total: 2,
      next: 'Run first',
    }, 'coordinator');

    const subscriber = new PlanFrontierSubscriber({
      pool,
      bus,
      logger,
      schedulerService,
      taskRepo: repo,
      eligibleAgents: new Set(['coordinator']),
      continuationDelaySeconds: 30,
      resumableCeilings: ceilings,
    });
    subscriber.start();

    await repo.updateTask(child1.id, { status: 'done' }, 'coordinator');

    const parentWakes = await pool.query<{ id: string }>(
      `SELECT id FROM scheduled_jobs WHERE task_id = $1 AND status = 'pending'`,
      [parent.id],
    );
    expect(parentWakes.rows).toHaveLength(1);

    await bus.publish('system', createScheduleFired({
      jobId: parentWakes.rows[0]!.id,
      agentId: 'coordinator',
      agentTaskId: parent.id,
      parentEventId: 'healthy-wake',
    }));

    const reloaded = await repo.getTask(parent.id);
    expect(reloaded?.status).not.toBe('failed');
    expect(reloaded?.progress.resumableCircuit).toBeDefined();
    const circuit = reloaded?.progress.resumableCircuit as { stallCount: number };
    expect(circuit.stallCount).toBe(0);
  });
});
