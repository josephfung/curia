// task-plan-progress.test.ts — round-trip persistence for progress.plan (#1236).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { TaskRepo } from '../../src/db/task-repo.js';
import {
  PLAN_BLOCK_MAX_BYTES,
  computePlanRollup,
  isPlannedStep,
  planBlockBytes,
  readPlanBlock,
} from '../../src/db/plan-progress.js';
import type { EventBus } from '../../src/bus/bus.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'PlanProgress Test';
const logger = pino({ level: 'silent' });
const noopBus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBus;

const CHILD_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHILD_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function cleanup(pool: pg.Pool): Promise<void> {
  const titleLike = `${PREFIX}%`;
  await pool.query(
    `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [titleLike],
  );
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [titleLike]);
}

describeIf('TaskRepo plan progress (#1236)', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new TaskRepo(pool, noopBus, logger as never, 'UTC');
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { await cleanup(pool); });

  it('round-trips a plan block', async () => {
    const task = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} kickoff`,
      source: 'coordinator',
    });

    const steps = [
      { id: 'gather-input', taskId: CHILD_A },
      { id: 'assemble-plan', taskId: CHILD_B },
    ];

    const first = await repo.setPlanBlock(task.id, {
      steps,
      deliverableStepId: 'assemble-plan',
      done: 0,
      total: 2,
      next: 'Gather exec input',
    });
    expect('task' in first).toBe(true);
    if (!('task' in first)) return;

    const reread = await repo.getPlanBlock(task.id);
    expect(reread?.deliverableStepId).toBe('assemble-plan');
    expect(reread?.steps).toEqual(steps);
    expect(isPlannedStep((await repo.getTask(task.id))!.progress)).toBe(true);
  });

  it('does not clobber resumable or notes when writing the plan block', async () => {
    const task = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} siblings`,
      source: 'coordinator',
    });

    await repo.updateTask(task.id, { progressNote: 'Planning started' }, 'coordinator');
    await repo.setResumableBlock(task.id, {
      cursor: 'page:1',
      done: 0,
      total: 100,
      accumulator: [],
      lastSliceUnits: 10,
      next: 'Keep paging',
    });

    const result = await repo.setPlanBlock(task.id, {
      steps: [{ id: 'only-step', taskId: CHILD_A }],
      deliverableStepId: null,
      done: 0,
      total: 1,
      next: 'Run the only step',
    });
    expect('task' in result).toBe(true);

    const reloaded = await repo.getTask(task.id);
    const progress = reloaded?.progress ?? {};
    const notes = (progress as { notes?: Array<{ note: string }> }).notes ?? [];
    expect(notes.some((n) => n.note === 'Planning started')).toBe(true);
    expect(await repo.getResumableBlock(task.id)).toMatchObject({ cursor: 'page:1' });
    expect(await repo.getPlanBlock(task.id)).toMatchObject({ total: 1 });
    expect(readPlanBlock(progress)).not.toBeNull();
  });

  it('persists plan block under the size cap', async () => {
    const task = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} cap`,
      source: 'coordinator',
    });

    const steps = Array.from({ length: 10 }, (_, i) => ({
      id: `step-${i}`,
      taskId: `${String(i).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
    }));

    const result = await repo.setPlanBlock(task.id, {
      steps,
      deliverableStepId: 'step-9',
      done: 3,
      total: 10,
      next: 'Advance frontier on child completion',
    }, 'coordinator');
    expect('task' in result).toBe(true);
    if (!('task' in result)) return;

    expect(planBlockBytes(result.block)).toBeLessThanOrEqual(PLAN_BLOCK_MAX_BYTES);
    const persisted = await repo.getPlanBlock(task.id);
    expect(persisted).not.toBeNull();
    expect(planBlockBytes(persisted!)).toBeLessThanOrEqual(PLAN_BLOCK_MAX_BYTES);
  });

  it('rollup helper reflects child statuses from the database', async () => {
    const parent = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} parent rollup`,
      source: 'coordinator',
    });
    const childDone = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} child done`,
      source: 'coordinator',
      parentTaskId: parent.id,
    });
    const childOpen = await repo.createTask({
      agentId: 'coordinator',
      title: `${PREFIX} child open`,
      source: 'coordinator',
      parentTaskId: parent.id,
    });

    await repo.updateTask(childDone.id, { status: 'done' }, 'coordinator');

    const steps = [
      { id: 'first', taskId: childDone.id },
      { id: 'second', taskId: childOpen.id },
    ];
    const rollup = computePlanRollup(steps, {
      [childDone.id]: 'done',
      [childOpen.id]: 'open',
    });
    expect(rollup).toEqual({ done: 1, total: 2 });

    await repo.setPlanBlock(parent.id, {
      steps,
      deliverableStepId: null,
      done: rollup.done,
      total: rollup.total,
      next: 'Wait for second child',
    });
    expect(await repo.getPlanBlock(parent.id)).toMatchObject({ done: 1, total: 2 });
  });
});
