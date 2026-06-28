// resumable-circuit-breaker.test.ts — no-progress continuation escalates (#1176).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { ResumableContinuationSubscriber } from '../../src/agents/resumable-continuation-subscriber.js';
import { createAgentResponse } from '../../src/bus/events.js';
import { DEFAULT_RESUMABLE_CEILINGS } from '../../src/config.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'ResumableCircuitBreaker Test';
const logger = pino({ level: 'silent' });

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(
    `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [`${PREFIX}%`],
  );
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`Review: resumable task stalled (${PREFIX}%`]);
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1 OR parent_task_id IN (
    SELECT id FROM tasks WHERE title LIKE $1
  )`, [`${PREFIX}%`]);
}

describeIf('Resumable circuit breaker (#1176)', () => {
  let pool: pg.Pool;
  let repo: TaskRepo;
  let bus: EventBus;

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
  });

  it('escalates after K no-progress pauses instead of scheduling another continuation', async () => {
    const task = await repo.createTask({
      agentId: 'social-media',
      title: `${PREFIX} stalled audit`,
      source: 'coordinator',
      sourceAgentId: 'social-media',
      resumable: true,
      tags: ['resumable'],
    });
    await repo.setResumableBlock(task.id, {
      cursor: 'page:3',
      done: 25,
      total: 1300,
      accumulator: [],
      lastSliceUnits: 25,
      next: 'Review page 4',
    }, 'social-media');
    await repo.updateTask(task.id, { status: 'in_progress' }, 'social-media');

    // Seed circuit state one stall away from the limit (K=2 for this test).
    await repo.persistResumableCircuitState(task.id, {
      stallCount: 1,
      iterationCount: 5,
      startedAt: new Date().toISOString(),
      totalCostUsd: 0,
      lastProgress: { done: 25, cursor: 'page:3' },
    });

    const ceilings = { ...DEFAULT_RESUMABLE_CEILINGS, maxStalls: 2 };

    const coordinatorTasks: Array<{ content: string }> = [];
    bus.subscribe('agent.task', 'system', (event) => {
      const e = event as { payload: { agentId: string; content: string } };
      if (e.payload.agentId === 'coordinator') {
        coordinatorTasks.push({ content: e.payload.content });
      }
    });

    const subscriber = new ResumableContinuationSubscriber({
      pool,
      bus,
      logger: logger as never,
      schedulerService: { enqueueTaskWake: vi.fn() } as never,
      taskRepo: repo,
      eligibleAgents: new Set(['social-media', 'coordinator']),
      continuationDelaySeconds: 1,
      resumableCeilings: ceilings,
    });
    subscriber.start();

    const pausedPayload = {
      _curia_protocol: 'execution_paused',
      task_id: task.id,
      done: 25,
      total: 1300,
      cursor: 'page:3',
      last_slice_units: 0,
      next: 'Still stuck',
    };

    await bus.publish('agent', createAgentResponse({
      agentId: 'social-media',
      conversationId: 'conv-stall',
      content: JSON.stringify(pausedPayload),
      parentEventId: 'parent-stall',
    }));

    const reloaded = await repo.getTask(task.id);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.tags).toContain('needs-attention');

    const { rows: wakes } = await pool.query(
      `SELECT id FROM scheduled_jobs WHERE task_id = $1 AND status = 'pending'`,
      [task.id],
    );
    expect(wakes).toHaveLength(0);

    expect(coordinatorTasks.length).toBeGreaterThan(0);
    expect(coordinatorTasks[0]!.content).toContain('circuit breaker');

    const { rows: ceoTasks } = await pool.query(
      `SELECT id, owner, tags FROM tasks WHERE owner = 'ceo' AND tags @> ARRAY['resumable-circuit-breach']::text[]`,
    );
    expect(ceoTasks.length).toBeGreaterThan(0);
  });

  it('schedules continuation when progress advances', async () => {
    const task = await repo.createTask({
      agentId: 'social-media',
      title: `${PREFIX} healthy audit`,
      source: 'coordinator',
      sourceAgentId: 'social-media',
      resumable: true,
    });
    await repo.setResumableBlock(task.id, {
      cursor: 'page:3',
      done: 25,
      total: 1300,
      accumulator: [],
      lastSliceUnits: 25,
      next: 'Review page 4',
    }, 'social-media');
    await repo.persistResumableCircuitState(task.id, {
      stallCount: 0,
      iterationCount: 1,
      startedAt: new Date().toISOString(),
      totalCostUsd: 0,
      lastProgress: { done: 25, cursor: 'page:3' },
    });

    const enqueueTaskWake = vi.fn().mockResolvedValue({ jobId: 'job-healthy' });
    const subscriber = new ResumableContinuationSubscriber({
      pool,
      bus,
      logger: logger as never,
      schedulerService: { enqueueTaskWake } as never,
      taskRepo: repo,
      eligibleAgents: new Set(['social-media']),
      continuationDelaySeconds: 1,
      resumableCeilings: DEFAULT_RESUMABLE_CEILINGS,
    });
    subscriber.start();

    await bus.publish('agent', createAgentResponse({
      agentId: 'social-media',
      conversationId: 'conv-ok',
      content: JSON.stringify({
        _curia_protocol: 'execution_paused',
        task_id: task.id,
        done: 50,
        total: 1300,
        cursor: 'page:4',
        last_slice_units: 25,
        next: 'Review page 5',
      }),
      parentEventId: 'parent-ok',
    }));

    expect(enqueueTaskWake).toHaveBeenCalled();
    const reloaded = await repo.getTask(task.id);
    expect(reloaded?.status).toBe('open');
  });
});
