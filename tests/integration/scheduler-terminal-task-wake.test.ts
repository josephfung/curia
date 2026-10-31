// scheduler-terminal-task-wake.test.ts — a wake whose task is finished never runs (#2378).
//
// Completing a task cancels its pending, running, suspended and paused wakes, but not a
// `failed` one. A wake that failed once keeps a past next_run_at, the claim accepts
// 'failed', so it fired on the next poll and woke an agent onto a done task. The claim now
// retires such a wake instead.
//
// fireJob is private; the cast is deliberate so the production claim SQL is exercised
// (pollDueJobs would also pick up other tests' due rows in the shared database).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import type { EventBus as EventBusType } from '../../src/bus/bus.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { SchedulerService, type JobRow } from '../../src/scheduler/scheduler-service.js';
import { TaskRepo } from '../../src/db/task-repo.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const PREFIX = 'SchedulerTerminalTaskWake Test';
const AGENT_ID = 'terminal-wake-test-agent';
const logger = pino({ level: 'silent' });
const noopBus = { publish: async () => {}, subscribe: () => {} } as unknown as EventBusType;

async function cleanup(pool: pg.Pool): Promise<void> {
  await pool.query(
    `DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE $1)`,
    [`${PREFIX}%`],
  );
  await pool.query(`DELETE FROM tasks WHERE title LIKE $1`, [`${PREFIX}%`]);
}

describeIf('Scheduler: wakes for finished tasks (#2378)', () => {
  let pool: pg.Pool;
  let bus: EventBus;
  let repo: TaskRepo;
  let scheduler: Scheduler;
  let fired: string[];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    bus = new EventBus(logger as never);
    repo = new TaskRepo(pool, noopBus, logger as never, 'UTC');
    const schedulerService = new SchedulerService(pool, bus, logger as never, 'UTC');
    scheduler = new Scheduler({ pool, bus, logger: logger as never, schedulerService, ownsAgent: () => true });
    bus.subscribe('agent.task', 'system', (event) => {
      fired.push((event as { payload: { agentId: string } }).payload.agentId);
    });
  });
  afterAll(async () => { await cleanup(pool); await pool.end(); });
  beforeEach(async () => { fired = []; await cleanup(pool); });

  /** A task whose one wake has failed once. Its next_run_at is left in the future so other
   *  test files' pollDueJobs (same database, run in parallel) never pick it up; the one-shot
   *  claim fireJob runs does not check next_run_at, so the claim under test is unchanged. */
  async function taskWithFailedWake(title: string): Promise<{ taskId: string; jobId: string }> {
    const task = await repo.createTask({
      agentId: AGENT_ID,
      title: `${PREFIX} ${title}`,
      source: 'coordinator',
      wakeAt: new Date(Date.now() + 3_600_000),
    });
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE scheduled_jobs
          SET status = 'failed', consecutive_failures = 1, last_error = 'boom',
              run_at = now() + interval '1 day', next_run_at = now() + interval '1 day'
        WHERE task_id = $1
        RETURNING id`,
      [task.id],
    );
    return { taskId: task.id, jobId: rows[0]!.id };
  }

  function jobRow(jobId: string, taskId: string): JobRow {
    const past = new Date(Date.now() - 60_000).toISOString();
    return {
      id: jobId, agentId: AGENT_ID, cronExpr: null, runAt: past,
      taskPayload: { type: 'task-wake', task_id: taskId }, status: 'failed',
      lastRunAt: null, nextRunAt: past, lastError: 'boom', consecutiveFailures: 1,
      createdBy: 'task-create', createdAt: past, timezone: 'UTC',
      agentTaskId: taskId, intentAnchor: null, progress: null,
      taskErrorBudget: null, taskTags: null, taskTitle: `${PREFIX}`,
      runStartedAt: null, expectedDurationSeconds: null, lastRunOutcome: null,
      lastRunSummary: null, lastRunContext: null, originator: null,
    };
  }

  const fireJob = (job: JobRow) =>
    (scheduler as unknown as { fireJob(j: JobRow): Promise<string> }).fireJob(job);

  async function wakeStatus(jobId: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM scheduled_jobs WHERE id = $1`, [jobId]);
    return rows[0]!.status;
  }

  it('retires a failed wake whose task was completed, without waking the agent', async () => {
    const { taskId, jobId } = await taskWithFailedWake('completed');
    await repo.completeTask(taskId, 'done elsewhere', AGENT_ID);
    // Completion leaves the failed wake in place — the gap this guards.
    expect(await wakeStatus(jobId)).toBe('failed');

    const outcome = await fireJob(jobRow(jobId, taskId));

    expect(outcome).toBe('skipped');
    expect(fired).toEqual([]);
    expect(await wakeStatus(jobId)).toBe('cancelled');
  });

  it('retires a pending wake whose task was cancelled behind its back', async () => {
    const { taskId, jobId } = await taskWithFailedWake('cancelled');
    await pool.query(`UPDATE tasks SET status = 'cancelled' WHERE id = $1`, [taskId]);
    await pool.query(`UPDATE scheduled_jobs SET status = 'pending' WHERE id = $1`, [jobId]);

    const outcome = await fireJob({ ...jobRow(jobId, taskId), status: 'pending' });

    expect(outcome).toBe('skipped');
    expect(fired).toEqual([]);
    expect(await wakeStatus(jobId)).toBe('cancelled');
  });

  it('still fires a failed wake whose task is open', async () => {
    const { taskId, jobId } = await taskWithFailedWake('open');

    const outcome = await fireJob(jobRow(jobId, taskId));

    expect(outcome).toBe('dispatched');
    // The publish is detached from fireJob (#1160).
    await vi.waitFor(() => expect(fired).toEqual([AGENT_ID]));
  });
});
