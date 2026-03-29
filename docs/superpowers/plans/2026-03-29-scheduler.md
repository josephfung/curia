# Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Postgres-backed scheduler from spec 07 — cron and one-shot jobs, persistent multi-burst agent tasks, skills, HTTP API, and system layer documentation.

**Architecture:** A `SchedulerService` handles all job CRUD logic, shared by three consumers: the scheduler loop (fires due jobs), three agent skills (runtime job management), and HTTP API routes (ops management). The scheduler registers as `system` layer on the bus and publishes `schedule.*` events for audit plus `agent.task` events to trigger agent work.

**Tech Stack:** TypeScript/ESM, PostgreSQL, Fastify, pino, vitest, cron-parser

---

### Task 1: Database Migration

**Files:**
- Create: `src/db/migrations/008_create_scheduler.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- Up Migration

-- Scheduled jobs: the job registry for cron and one-shot tasks.
-- The scheduler loop polls for due jobs every 30s using FOR UPDATE SKIP LOCKED.
CREATE TABLE scheduled_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id              TEXT NOT NULL,
  cron_expr             TEXT,
  run_at                TIMESTAMPTZ,
  task_payload          JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  last_run_at           TIMESTAMPTZ,
  next_run_at           TIMESTAMPTZ,
  last_error            TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  created_by            TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cron_or_run_at CHECK (cron_expr IS NOT NULL OR run_at IS NOT NULL)
);

-- Partial index: the scheduler loop only queries pending/failed jobs by next_run_at.
-- Completed, suspended, and cancelled rows are excluded from the index.
CREATE INDEX idx_scheduled_jobs_due
  ON scheduled_jobs (next_run_at)
  WHERE status IN ('pending', 'failed');

-- Agent tasks: persistent state for multi-burst agent work.
-- Each burst, the agent loads intent_anchor + progress, does work, updates progress.
CREATE TABLE agent_tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          TEXT NOT NULL,
  intent_anchor     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  progress          JSONB NOT NULL DEFAULT '{}',
  error_budget      JSONB NOT NULL,
  conversation_id   UUID,
  scheduled_job_id  UUID REFERENCES scheduled_jobs(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_tasks_job ON agent_tasks (scheduled_job_id);
```

- [ ] **Step 2: Run the migration against the local database**

Run: `cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler && npx node-pg-migrate up`
Expected: Migration 008 applies successfully.

- [ ] **Step 3: Verify tables exist**

Run: `psql "$DATABASE_URL" -c "\dt scheduled_jobs" -c "\dt agent_tasks"`
Expected: Both tables listed.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/008_create_scheduler.sql
git commit -m "feat: add scheduler migration (scheduled_jobs + agent_tasks)"
```

---

### Task 2: Bus Events & Permissions

**Files:**
- Modify: `src/bus/events.ts`
- Modify: `src/bus/permissions.ts`

- [ ] **Step 1: Write the failing test for new event types**

Create: `tests/unit/bus/schedule-events.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  createScheduleCreated,
  createScheduleFired,
  createScheduleSuspended,
} from '../../../src/bus/events.js';

describe('schedule event factories', () => {
  it('createScheduleCreated produces a valid event', () => {
    const event = createScheduleCreated({
      jobId: 'job-1',
      agentId: 'coordinator',
      cronExpr: '0 9 * * 1',
      runAt: null,
      taskPayload: { task: 'weekly report' },
      createdBy: 'system',
      parentEventId: 'parent-1',
    });

    expect(event.type).toBe('schedule.created');
    expect(event.sourceLayer).toBe('system');
    expect(event.payload.jobId).toBe('job-1');
    expect(event.payload.cronExpr).toBe('0 9 * * 1');
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.parentEventId).toBe('parent-1');
  });

  it('createScheduleFired produces a valid event', () => {
    const event = createScheduleFired({
      jobId: 'job-1',
      agentId: 'coordinator',
      agentTaskId: 'task-1',
      parentEventId: 'parent-1',
    });

    expect(event.type).toBe('schedule.fired');
    expect(event.sourceLayer).toBe('system');
    expect(event.payload.agentTaskId).toBe('task-1');
  });

  it('createScheduleSuspended produces a valid event', () => {
    const event = createScheduleSuspended({
      jobId: 'job-1',
      agentId: 'coordinator',
      lastError: 'timeout',
      consecutiveFailures: 3,
      parentEventId: 'parent-1',
    });

    expect(event.type).toBe('schedule.suspended');
    expect(event.sourceLayer).toBe('system');
    expect(event.payload.consecutiveFailures).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bus/schedule-events.test.ts`
Expected: FAIL — `createScheduleCreated` does not exist.

- [ ] **Step 3: Add event types and factory functions to events.ts**

Add the following payload interfaces after the existing `MemoryQueryPayload` interface (around line 138):

```typescript
// Schedule event payloads — emitted by the scheduler (system layer) for audit trail.

interface ScheduleCreatedPayload {
  jobId: string;
  agentId: string;
  cronExpr: string | null;
  runAt: string | null;
  taskPayload: Record<string, unknown>;
  createdBy: string;
}

interface ScheduleFiredPayload {
  jobId: string;
  agentId: string;
  agentTaskId: string | null;
}

interface ScheduleSuspendedPayload {
  jobId: string;
  agentId: string;
  lastError: string;
  consecutiveFailures: number;
}
```

Add the following event interfaces after the existing `MemoryQueryEvent` (around line 230):

```typescript
// Schedule events — emitted by the scheduler (system layer) for audit logging.

export interface ScheduleCreatedEvent extends BaseEvent {
  type: 'schedule.created';
  sourceLayer: 'system';
  payload: ScheduleCreatedPayload;
}

export interface ScheduleFiredEvent extends BaseEvent {
  type: 'schedule.fired';
  sourceLayer: 'system';
  payload: ScheduleFiredPayload;
}

export interface ScheduleSuspendedEvent extends BaseEvent {
  type: 'schedule.suspended';
  sourceLayer: 'system';
  payload: ScheduleSuspendedPayload;
}
```

Add the three new types to the `BusEvent` union:

```typescript
export type BusEvent =
  | InboundMessageEvent
  | AgentTaskEvent
  | AgentResponseEvent
  | OutboundMessageEvent
  | SkillInvokeEvent
  | SkillResultEvent
  | AgentErrorEvent
  | MemoryStoreEvent
  | MemoryQueryEvent
  | ContactResolvedEvent
  | ContactUnknownEvent
  | MessageHeldEvent
  | OutboundBlockedEvent
  | ScheduleCreatedEvent   // Scheduler: job created
  | ScheduleFiredEvent     // Scheduler: job fired
  | ScheduleSuspendedEvent; // Scheduler: job auto-suspended
```

Add factory functions at the end of the file:

```typescript
export function createScheduleCreated(
  payload: ScheduleCreatedPayload & { parentEventId?: string },
): ScheduleCreatedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'schedule.created',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}

export function createScheduleFired(
  payload: ScheduleFiredPayload & { parentEventId?: string },
): ScheduleFiredEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'schedule.fired',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}

export function createScheduleSuspended(
  payload: ScheduleSuspendedPayload & { parentEventId?: string },
): ScheduleSuspendedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'schedule.suspended',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}
```

- [ ] **Step 4: Update permissions.ts**

Add the three new event types to both `system` allowlists in `src/bus/permissions.ts`.

In `publishAllowlist.system`, add `'schedule.created'`, `'schedule.fired'`, `'schedule.suspended'` to the Set.

In `subscribeAllowlist.system`, add `'schedule.created'`, `'schedule.fired'`, `'schedule.suspended'` to the Set.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/bus/schedule-events.test.ts`
Expected: PASS — all three factory functions produce valid events.

- [ ] **Step 6: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/bus/events.ts src/bus/permissions.ts tests/unit/bus/schedule-events.test.ts
git commit -m "feat: add schedule.created/fired/suspended bus events and permissions"
```

---

### Task 3: SchedulerService — Core Job CRUD

**Files:**
- Create: `src/scheduler/scheduler-service.ts`
- Create: `tests/unit/scheduler/scheduler-service.test.ts`

This is the shared service that skills, HTTP routes, and the scheduler loop all call. This task covers create, get, list, cancel, unsuspend, and update. The `completeJobRun` and `upsertDeclarativeJob` methods are added in later tasks.

- [ ] **Step 1: Install cron-parser**

Run: `cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler && pnpm add cron-parser`

- [ ] **Step 2: Write failing tests for SchedulerService**

Create: `tests/unit/scheduler/scheduler-service.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchedulerService } from '../../../src/scheduler/scheduler-service.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

// Minimal mock for Pool — SchedulerService uses pool.query() with parameterized SQL
function mockPool(rows: Record<string, unknown>[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  };
}

// Minimal mock for EventBus — SchedulerService publishes schedule.* events
function mockBus() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SchedulerService', () => {
  describe('createJob', () => {
    it('creates a cron job and returns the job ID', async () => {
      const jobId = '11111111-1111-1111-1111-111111111111';
      const pool = mockPool([{ id: jobId }]);
      const bus = mockBus();
      const service = new SchedulerService(pool as any, bus as any, logger);

      const result = await service.createJob({
        agentId: 'coordinator',
        cronExpr: '0 9 * * 1',
        taskPayload: { task: 'weekly report' },
        createdBy: 'system',
      });

      expect(result.jobId).toBe(jobId);
      expect(result.agentTaskId).toBeUndefined();
      expect(pool.query).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalled();
    });

    it('creates a one-shot job with run_at', async () => {
      const jobId = '22222222-2222-2222-2222-222222222222';
      const pool = mockPool([{ id: jobId }]);
      const bus = mockBus();
      const service = new SchedulerService(pool as any, bus as any, logger);

      const result = await service.createJob({
        agentId: 'coordinator',
        runAt: '2026-04-01T09:00:00Z',
        taskPayload: { task: 'send reminder' },
        createdBy: 'api',
      });

      expect(result.jobId).toBe(jobId);
    });

    it('creates a persistent task when intentAnchor is provided', async () => {
      const jobId = '33333333-3333-3333-3333-333333333333';
      const taskId = '44444444-4444-4444-4444-444444444444';
      const pool = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [{ id: jobId }], rowCount: 1 })
          .mockResolvedValueOnce({ rows: [{ id: taskId }], rowCount: 1 }),
      };
      const bus = mockBus();
      const service = new SchedulerService(pool as any, bus as any, logger);

      const result = await service.createJob({
        agentId: 'research-analyst',
        cronExpr: '0 */4 * * *',
        taskPayload: { task: 'check for press releases' },
        createdBy: 'research-analyst',
        intentAnchor: 'Monitor competitor press releases daily',
        errorBudget: { maxTurns: 50, maxConsecutiveErrors: 10 },
      });

      expect(result.jobId).toBe(jobId);
      expect(result.agentTaskId).toBe(taskId);
      // Two queries: one for scheduled_jobs, one for agent_tasks
      expect(pool.query).toHaveBeenCalledTimes(2);
    });

    it('rejects when neither cronExpr nor runAt is provided', async () => {
      const pool = mockPool();
      const bus = mockBus();
      const service = new SchedulerService(pool as any, bus as any, logger);

      await expect(service.createJob({
        agentId: 'coordinator',
        taskPayload: { task: 'no schedule' },
        createdBy: 'api',
      })).rejects.toThrow('Either cronExpr or runAt must be provided');
    });
  });

  describe('cancelJob', () => {
    it('sets job status to cancelled', async () => {
      const pool = mockPool([{ id: 'job-1', status: 'pending' }]);
      const bus = mockBus();
      const service = new SchedulerService(pool as any, bus as any, logger);

      await service.cancelJob('job-1');

      // First call: update scheduled_jobs, second call: update agent_tasks
      expect(pool.query).toHaveBeenCalled();
      const firstCall = pool.query.mock.calls[0];
      expect(firstCall[0]).toContain('cancelled');
    });
  });

  describe('unsuspendJob', () => {
    it('resets status to pending and clears consecutive_failures', async () => {
      const pool = mockPool([{
        id: 'job-1',
        status: 'suspended',
        cron_expr: '0 9 * * 1',
        run_at: null,
      }]);
      const bus = mockBus();
      const service = new SchedulerService(pool as any, bus as any, logger);

      await service.unsuspendJob('job-1');

      expect(pool.query).toHaveBeenCalled();
    });
  });

  describe('listJobs', () => {
    it('returns all jobs when no filters', async () => {
      const pool = mockPool([
        { id: 'job-1', agent_id: 'coordinator', status: 'pending', cron_expr: '0 9 * * 1', run_at: null, task_payload: {}, next_run_at: new Date(), last_run_at: null, last_error: null, consecutive_failures: 0, created_by: 'system', created_at: new Date(), task_id: null, intent_anchor: null, progress: null },
      ]);
      const bus = mockBus();
      const service = new SchedulerService(pool as any, bus as any, logger);

      const jobs = await service.listJobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe('job-1');
    });

    it('filters by status', async () => {
      const pool = mockPool([]);
      const bus = mockBus();
      const service = new SchedulerService(pool as any, bus as any, logger);

      await service.listJobs({ status: 'suspended' });

      const query = pool.query.mock.calls[0][0] as string;
      expect(query).toContain('status');
    });
  });

  describe('getJob', () => {
    it('returns null for nonexistent job', async () => {
      const pool = mockPool([]);
      const bus = mockBus();
      const service = new SchedulerService(pool as any, bus as any, logger);

      const result = await service.getJob('nonexistent');

      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/scheduler/scheduler-service.test.ts`
Expected: FAIL — `SchedulerService` does not exist.

- [ ] **Step 4: Implement SchedulerService**

Create: `src/scheduler/scheduler-service.ts`

```typescript
// scheduler-service.ts — shared job management logic for the scheduler.
//
// This is the single source of truth for all job CRUD operations.
// Consumed by: scheduler loop, scheduler skills, HTTP API routes.
// All methods use parameterized queries (never string interpolation).

import { parseExpression } from 'cron-parser';
import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import { createScheduleCreated } from '../bus/events.js';

export interface CreateJobParams {
  agentId: string;
  cronExpr?: string;
  runAt?: string;
  taskPayload: Record<string, unknown>;
  createdBy: string;
  intentAnchor?: string;
  errorBudget?: { maxTurns: number; maxConsecutiveErrors: number };
}

export interface CreateJobResult {
  jobId: string;
  agentTaskId?: string;
}

export interface JobRow {
  id: string;
  agentId: string;
  cronExpr: string | null;
  runAt: string | null;
  taskPayload: Record<string, unknown>;
  status: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdBy: string;
  createdAt: string;
  // Joined from agent_tasks (null if no linked task)
  agentTaskId: string | null;
  intentAnchor: string | null;
  progress: Record<string, unknown> | null;
}

export interface ListJobsFilters {
  status?: string;
  agentId?: string;
}

export class SchedulerService {
  private pool: Pool;
  private bus: EventBus;
  private logger: Logger;

  constructor(pool: Pool, bus: EventBus, logger: Logger) {
    this.pool = pool;
    this.bus = bus;
    this.logger = logger;
  }

  /**
   * Calculate the next run time from a cron expression.
   * Returns an ISO 8601 date string.
   */
  nextRunFromCron(cronExpr: string): Date {
    const interval = parseExpression(cronExpr);
    return interval.next().toDate();
  }

  /**
   * Create a scheduled job. If intentAnchor is provided, also creates a
   * linked agent_task for persistent multi-burst work.
   */
  async createJob(params: CreateJobParams): Promise<CreateJobResult> {
    const { agentId, cronExpr, runAt, taskPayload, createdBy, intentAnchor, errorBudget } = params;

    if (!cronExpr && !runAt) {
      throw new Error('Either cronExpr or runAt must be provided');
    }

    // Calculate next_run_at: from cron expression or from the one-shot run_at
    let nextRunAt: Date;
    if (cronExpr) {
      nextRunAt = this.nextRunFromCron(cronExpr);
    } else {
      nextRunAt = new Date(runAt!);
    }

    // Insert the scheduled job
    const jobResult = await this.pool.query(
      `INSERT INTO scheduled_jobs (agent_id, cron_expr, run_at, task_payload, next_run_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [agentId, cronExpr ?? null, runAt ? new Date(runAt) : null, JSON.stringify(taskPayload), nextRunAt, createdBy],
    );
    const jobId = jobResult.rows[0].id as string;

    // If intentAnchor is provided, create a linked agent_task
    let agentTaskId: string | undefined;
    if (intentAnchor) {
      const budget = errorBudget ?? { maxTurns: 100, maxConsecutiveErrors: 5 };
      const taskResult = await this.pool.query(
        `INSERT INTO agent_tasks (agent_id, intent_anchor, error_budget, scheduled_job_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [agentId, intentAnchor, JSON.stringify(budget), jobId],
      );
      agentTaskId = taskResult.rows[0].id as string;
    }

    // Publish schedule.created event for audit trail
    const event = createScheduleCreated({
      jobId,
      agentId,
      cronExpr: cronExpr ?? null,
      runAt: runAt ?? null,
      taskPayload,
      createdBy,
    });
    await this.bus.publish('system', event);

    this.logger.info({ jobId, agentId, cronExpr, runAt, createdBy }, 'Scheduled job created');

    return { jobId, agentTaskId };
  }

  /**
   * Get a single job by ID, with linked agent_task if any.
   * Returns null if job not found.
   */
  async getJob(jobId: string): Promise<JobRow | null> {
    const result = await this.pool.query(
      `SELECT sj.id, sj.agent_id, sj.cron_expr, sj.run_at, sj.task_payload,
              sj.status, sj.last_run_at, sj.next_run_at, sj.last_error,
              sj.consecutive_failures, sj.created_by, sj.created_at,
              at.id AS task_id, at.intent_anchor, at.progress
       FROM scheduled_jobs sj
       LEFT JOIN agent_tasks at ON at.scheduled_job_id = sj.id
       WHERE sj.id = $1`,
      [jobId],
    );

    if (result.rows.length === 0) return null;

    return this.mapJobRow(result.rows[0]);
  }

  /**
   * List jobs with optional filters.
   */
  async listJobs(filters?: ListJobsFilters): Promise<JobRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters?.status) {
      conditions.push(`sj.status = $${paramIndex++}`);
      params.push(filters.status);
    }
    if (filters?.agentId) {
      conditions.push(`sj.agent_id = $${paramIndex++}`);
      params.push(filters.agentId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await this.pool.query(
      `SELECT sj.id, sj.agent_id, sj.cron_expr, sj.run_at, sj.task_payload,
              sj.status, sj.last_run_at, sj.next_run_at, sj.last_error,
              sj.consecutive_failures, sj.created_by, sj.created_at,
              at.id AS task_id, at.intent_anchor, at.progress
       FROM scheduled_jobs sj
       LEFT JOIN agent_tasks at ON at.scheduled_job_id = sj.id
       ${where}
       ORDER BY sj.created_at DESC`,
      params,
    );

    return result.rows.map((row: Record<string, unknown>) => this.mapJobRow(row));
  }

  /**
   * Soft-cancel a job. Sets status to 'cancelled' and cancels linked agent_task.
   */
  async cancelJob(jobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_jobs SET status = 'cancelled' WHERE id = $1`,
      [jobId],
    );
    // Also cancel linked agent_task if any
    await this.pool.query(
      `UPDATE agent_tasks SET status = 'cancelled', updated_at = now() WHERE scheduled_job_id = $1`,
      [jobId],
    );
    this.logger.info({ jobId }, 'Scheduled job cancelled');
  }

  /**
   * Unsuspend a job: reset status to pending, clear consecutive_failures,
   * recalculate next_run_at.
   */
  async unsuspendJob(jobId: string): Promise<void> {
    // Fetch the job to get cron_expr or run_at for recalculating next_run_at
    const result = await this.pool.query(
      `SELECT cron_expr, run_at FROM scheduled_jobs WHERE id = $1 AND status = 'suspended'`,
      [jobId],
    );
    if (result.rows.length === 0) {
      throw new Error(`Job ${jobId} not found or not suspended`);
    }

    const { cron_expr, run_at } = result.rows[0];
    let nextRunAt: Date;
    if (cron_expr) {
      nextRunAt = this.nextRunFromCron(cron_expr);
    } else {
      // One-shot job: re-use the original run_at (may be in the past — will fire immediately)
      nextRunAt = new Date(run_at);
    }

    await this.pool.query(
      `UPDATE scheduled_jobs
       SET status = 'pending', consecutive_failures = 0, next_run_at = $2, last_error = NULL
       WHERE id = $1`,
      [jobId, nextRunAt],
    );
    this.logger.info({ jobId }, 'Scheduled job unsuspended');
  }

  /**
   * Partial update of a job (cron_expr, run_at, task_payload).
   * Cannot change agent_id or created_by.
   */
  async updateJob(jobId: string, updates: { cronExpr?: string; runAt?: string; taskPayload?: Record<string, unknown> }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.cronExpr !== undefined) {
      sets.push(`cron_expr = $${paramIndex++}`);
      params.push(updates.cronExpr);
      // Recalculate next_run_at when cron changes
      const nextRunAt = this.nextRunFromCron(updates.cronExpr);
      sets.push(`next_run_at = $${paramIndex++}`);
      params.push(nextRunAt);
    }
    if (updates.runAt !== undefined) {
      sets.push(`run_at = $${paramIndex++}`);
      params.push(new Date(updates.runAt));
      sets.push(`next_run_at = $${paramIndex++}`);
      params.push(new Date(updates.runAt));
    }
    if (updates.taskPayload !== undefined) {
      sets.push(`task_payload = $${paramIndex++}`);
      params.push(JSON.stringify(updates.taskPayload));
    }

    if (sets.length === 0) return;

    params.push(jobId);
    await this.pool.query(
      `UPDATE scheduled_jobs SET ${sets.join(', ')} WHERE id = $${paramIndex}`,
      params,
    );
    this.logger.info({ jobId, updates: Object.keys(updates) }, 'Scheduled job updated');
  }

  /**
   * Upsert a declarative job from agent YAML config.
   * Matches on agent_id + cron_expr + task_payload to avoid duplicates on restart.
   */
  async upsertDeclarativeJob(agentId: string, schedule: { cron: string; task: string }): Promise<string> {
    const taskPayload = { task: schedule.task };
    const nextRunAt = this.nextRunFromCron(schedule.cron);

    const result = await this.pool.query(
      `INSERT INTO scheduled_jobs (agent_id, cron_expr, task_payload, next_run_at, created_by)
       VALUES ($1, $2, $3, $4, 'system')
       ON CONFLICT ON CONSTRAINT scheduled_jobs_declarative_uq
       DO UPDATE SET next_run_at = EXCLUDED.next_run_at
       RETURNING id`,
      [agentId, schedule.cron, JSON.stringify(taskPayload), nextRunAt],
    );

    return result.rows[0].id as string;
  }

  /**
   * Called by the scheduler loop after tracking an agent response or error.
   * Updates job status, last_run_at, next_run_at, and consecutive_failures.
   */
  async completeJobRun(jobId: string, success: boolean, error?: string): Promise<{ suspended: boolean }> {
    if (success) {
      // Fetch cron_expr to decide if this is recurring or one-shot
      const jobResult = await this.pool.query(
        `SELECT cron_expr FROM scheduled_jobs WHERE id = $1`,
        [jobId],
      );
      if (jobResult.rows.length === 0) return { suspended: false };

      const { cron_expr } = jobResult.rows[0];

      if (cron_expr) {
        // Recurring: calculate next run, reset to pending
        const nextRunAt = this.nextRunFromCron(cron_expr);
        await this.pool.query(
          `UPDATE scheduled_jobs
           SET status = 'pending', last_run_at = now(), next_run_at = $2, consecutive_failures = 0, last_error = NULL
           WHERE id = $1`,
          [jobId, nextRunAt],
        );
      } else {
        // One-shot: mark completed
        await this.pool.query(
          `UPDATE scheduled_jobs
           SET status = 'completed', last_run_at = now(), consecutive_failures = 0, last_error = NULL
           WHERE id = $1`,
          [jobId],
        );
      }
      return { suspended: false };
    }

    // Failure path
    const result = await this.pool.query(
      `UPDATE scheduled_jobs
       SET status = CASE WHEN consecutive_failures + 1 >= 3 THEN 'suspended' ELSE 'failed' END,
           last_run_at = now(),
           last_error = $2,
           consecutive_failures = consecutive_failures + 1,
           next_run_at = CASE
             WHEN cron_expr IS NOT NULL AND consecutive_failures + 1 < 3
             THEN $3::timestamptz
             ELSE next_run_at
           END
       WHERE id = $1
       RETURNING consecutive_failures, status, cron_expr`,
      [jobId, error ?? 'Unknown error', new Date()],
    );

    if (result.rows.length === 0) return { suspended: false };

    const suspended = result.rows[0].status === 'suspended';

    // Recalculate next_run_at for non-suspended cron jobs
    if (!suspended && result.rows[0].cron_expr) {
      const nextRunAt = this.nextRunFromCron(result.rows[0].cron_expr);
      await this.pool.query(
        `UPDATE scheduled_jobs SET next_run_at = $2 WHERE id = $1`,
        [jobId, nextRunAt],
      );
    }

    return { suspended };
  }

  /** Map a raw database row to a typed JobRow. */
  private mapJobRow(row: Record<string, unknown>): JobRow {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      cronExpr: row.cron_expr as string | null,
      runAt: row.run_at ? (row.run_at as Date).toISOString() : null,
      taskPayload: row.task_payload as Record<string, unknown>,
      status: row.status as string,
      lastRunAt: row.last_run_at ? (row.last_run_at as Date).toISOString() : null,
      nextRunAt: row.next_run_at ? (row.next_run_at as Date).toISOString() : null,
      lastError: row.last_error as string | null,
      consecutiveFailures: row.consecutive_failures as number,
      createdBy: row.created_by as string,
      createdAt: (row.created_at as Date).toISOString(),
      agentTaskId: (row.task_id as string) ?? null,
      intentAnchor: (row.intent_anchor as string) ?? null,
      progress: (row.progress as Record<string, unknown>) ?? null,
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/scheduler/scheduler-service.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 6: Add unique constraint for declarative job upsert**

The `upsertDeclarativeJob` method uses `ON CONFLICT ON CONSTRAINT scheduled_jobs_declarative_uq`. Add this to the migration file `008_create_scheduler.sql`, after the `agent_tasks` index:

```sql
-- Unique constraint for declarative job upsert (prevents duplicates on restart).
-- task_payload is cast to text for equality comparison.
CREATE UNIQUE INDEX scheduled_jobs_declarative_uq
  ON scheduled_jobs (agent_id, cron_expr, (task_payload::text))
  WHERE created_by = 'system';
```

Re-run the migration: `npx node-pg-migrate up` (or drop and recreate if needed during dev).

- [ ] **Step 7: Commit**

```bash
git add src/scheduler/scheduler-service.ts tests/unit/scheduler/scheduler-service.test.ts src/db/migrations/008_create_scheduler.sql pnpm-lock.yaml package.json
git commit -m "feat: add SchedulerService with job CRUD, cron parsing, and upsert"
```

---

### Task 4: Scheduler Loop

**Files:**
- Create: `src/scheduler/scheduler.ts`
- Create: `tests/unit/scheduler/scheduler.test.ts`

- [ ] **Step 1: Write failing tests for the scheduler loop**

Create: `tests/unit/scheduler/scheduler.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../../src/scheduler/scheduler.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function mockPool(rows: Record<string, unknown>[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  };
}

function mockBus() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
  };
}

function mockSchedulerService() {
  return {
    completeJobRun: vi.fn().mockResolvedValue({ suspended: false }),
    upsertDeclarativeJob: vi.fn().mockResolvedValue('job-1'),
  };
}

describe('Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts and stops the poll loop', () => {
    const pool = mockPool();
    const bus = mockBus();
    const service = mockSchedulerService();
    const scheduler = new Scheduler({ pool: pool as any, bus: bus as any, logger, schedulerService: service as any });

    scheduler.start();
    // The loop should be running (setInterval)
    scheduler.stop();
    // Should not throw
  });

  it('pollDueJobs claims and fires due jobs', async () => {
    const dueJob = {
      id: 'job-1',
      agent_id: 'coordinator',
      task_payload: { task: 'weekly report' },
      cron_expr: '0 9 * * 1',
      run_at: null,
      scheduled_job_id: null,
    };
    const pool = mockPool([dueJob]);
    const bus = mockBus();
    const service = mockSchedulerService();
    const scheduler = new Scheduler({ pool: pool as any, bus: bus as any, logger, schedulerService: service as any });

    await scheduler.pollDueJobs();

    // Should have published schedule.fired and agent.task
    expect(bus.publish).toHaveBeenCalledTimes(2);

    // First call: schedule.fired
    const firedEvent = bus.publish.mock.calls[0][1];
    expect(firedEvent.type).toBe('schedule.fired');

    // Second call: agent.task
    const taskEvent = bus.publish.mock.calls[1][1];
    expect(taskEvent.type).toBe('agent.task');
    expect(taskEvent.payload.agentId).toBe('coordinator');
  });

  it('loads persistent task context when agent_task is linked', async () => {
    const dueJob = {
      id: 'job-1',
      agent_id: 'research-analyst',
      task_payload: { task: 'continue research' },
      cron_expr: '0 */4 * * *',
      run_at: null,
    };
    // First query: due jobs. Second query: agent_task lookup.
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [dueJob], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SET running
        .mockResolvedValueOnce({
          rows: [{ id: 'task-1', intent_anchor: 'Monitor competitors', progress: { done: 3, total: 10 } }],
          rowCount: 1,
        }),
    };
    const bus = mockBus();
    const service = mockSchedulerService();
    const scheduler = new Scheduler({ pool: pool as any, bus: bus as any, logger, schedulerService: service as any });

    await scheduler.pollDueJobs();

    // The agent.task payload should include persistent task context
    const taskEvent = bus.publish.mock.calls.find(
      (call: unknown[]) => (call[1] as { type: string }).type === 'agent.task',
    );
    expect(taskEvent).toBeTruthy();
  });

  it('loadDeclarativeJobs upserts jobs from agent configs', async () => {
    const pool = mockPool();
    const bus = mockBus();
    const service = mockSchedulerService();
    const scheduler = new Scheduler({ pool: pool as any, bus: bus as any, logger, schedulerService: service as any });

    await scheduler.loadDeclarativeJobs([
      {
        name: 'coordinator',
        model: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
        system_prompt: 'test',
        schedule: [
          { cron: '0 9 * * 1', task: 'weekly report' },
        ],
      },
      {
        name: 'research-analyst',
        model: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
        system_prompt: 'test',
        // No schedule block — should be skipped
      },
    ]);

    expect(service.upsertDeclarativeJob).toHaveBeenCalledTimes(1);
    expect(service.upsertDeclarativeJob).toHaveBeenCalledWith('coordinator', { cron: '0 9 * * 1', task: 'weekly report' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/scheduler/scheduler.test.ts`
Expected: FAIL — `Scheduler` does not exist.

- [ ] **Step 3: Implement the Scheduler**

Create: `src/scheduler/scheduler.ts`

```typescript
// scheduler.ts — the scheduler loop.
//
// Polls Postgres every 30s for due jobs, claims them with FOR UPDATE SKIP LOCKED,
// and publishes agent.task events to the bus. Subscribes to agent.response and
// agent.error to track completion and update job status.
//
// Registers as 'system' layer — same as the audit logger.

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { SchedulerService } from './scheduler-service.js';
import type { AgentYamlConfig } from '../agents/loader.js';
import {
  createScheduleFired,
  createScheduleSuspended,
  createAgentTask,
} from '../bus/events.js';
import type { AgentResponseEvent, AgentErrorEvent } from '../bus/events.js';

const POLL_INTERVAL_MS = 30_000;

export interface SchedulerConfig {
  pool: Pool;
  bus: EventBus;
  logger: Logger;
  schedulerService: SchedulerService;
}

export class Scheduler {
  private pool: Pool;
  private bus: EventBus;
  private logger: Logger;
  private schedulerService: SchedulerService;
  private timer: NodeJS.Timeout | null = null;

  // Maps agent.task event ID → job ID for completion tracking
  private pendingJobs = new Map<string, string>();

  constructor(config: SchedulerConfig) {
    this.pool = config.pool;
    this.bus = config.bus;
    this.logger = config.logger;
    this.schedulerService = config.schedulerService;
  }

  /**
   * Start the scheduler loop and set up completion tracking subscribers.
   */
  start(): void {
    // Subscribe to agent.response and agent.error for completion tracking.
    // Uses 'system' layer which has broad subscribe access.
    this.bus.subscribe('agent.response', 'system', async (event) => {
      const responseEvent = event as AgentResponseEvent;
      await this.handleCompletion(responseEvent.parentEventId, true);
    });

    this.bus.subscribe('agent.error', 'system', async (event) => {
      const errorEvent = event as AgentErrorEvent;
      await this.handleCompletion(errorEvent.parentEventId, false, errorEvent.payload.message);
    });

    this.timer = setInterval(() => {
      this.pollDueJobs().catch((err) => {
        this.logger.error({ err }, 'Scheduler poll failed');
      });
    }, POLL_INTERVAL_MS);

    this.logger.info({ intervalMs: POLL_INTERVAL_MS }, 'Scheduler started');
  }

  /**
   * Stop the scheduler loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('Scheduler stopped');
  }

  /**
   * Poll for due jobs and fire them.
   * Exposed as public for testing — normally called by the interval.
   */
  async pollDueJobs(): Promise<void> {
    // Claim due jobs atomically with FOR UPDATE SKIP LOCKED.
    // This prevents the same job from being claimed twice if the poll overlaps.
    const dueResult = await this.pool.query(
      `SELECT id, agent_id, task_payload, cron_expr, run_at
       FROM scheduled_jobs
       WHERE next_run_at <= now() AND status IN ('pending', 'failed')
       FOR UPDATE SKIP LOCKED`,
    );

    for (const job of dueResult.rows) {
      try {
        await this.fireJob(job);
      } catch (err) {
        this.logger.error({ err, jobId: job.id }, 'Failed to fire scheduled job');
      }
    }
  }

  /**
   * Fire a single due job: set running, publish events, track for completion.
   */
  private async fireJob(job: Record<string, unknown>): Promise<void> {
    const jobId = job.id as string;
    const agentId = job.agent_id as string;
    const taskPayload = job.task_payload as Record<string, unknown>;

    // Set status to 'running' atomically
    await this.pool.query(
      `UPDATE scheduled_jobs SET status = 'running' WHERE id = $1`,
      [jobId],
    );

    // Check for linked agent_task to inject persistent context
    let agentTaskId: string | null = null;
    let content = taskPayload.task as string ?? JSON.stringify(taskPayload);

    const taskResult = await this.pool.query(
      `SELECT id, intent_anchor, progress FROM agent_tasks WHERE scheduled_job_id = $1 AND status = 'active'`,
      [jobId],
    );

    if (taskResult.rows.length > 0) {
      const task = taskResult.rows[0];
      agentTaskId = task.id as string;
      // Inject persistent task context into the content
      const progress = JSON.stringify(task.progress);
      content = `[Persistent Task]\nIntent: ${task.intent_anchor}\nProgress: ${progress}\n\nCurrent burst: ${content}`;
    }

    // Publish schedule.fired for audit
    const firedEvent = createScheduleFired({
      jobId,
      agentId,
      agentTaskId,
    });
    await this.bus.publish('system', firedEvent);

    // Publish agent.task to trigger the agent
    // The scheduler acts as the dispatch layer for scheduled work —
    // it publishes agent.task with a synthetic conversation/channel context.
    const taskEvent = createAgentTask({
      agentId,
      conversationId: `scheduler:${jobId}`,
      channelId: 'scheduler',
      senderId: 'scheduler',
      content,
      metadata: { scheduledJobId: jobId, agentTaskId },
      parentEventId: firedEvent.id,
    });
    await this.bus.publish('system', taskEvent);

    // Track for completion
    this.pendingJobs.set(taskEvent.id, jobId);

    this.logger.info({ jobId, agentId, agentTaskId }, 'Scheduled job fired');
  }

  /**
   * Handle completion of a scheduler-triggered agent task.
   */
  private async handleCompletion(parentEventId: string | undefined, success: boolean, error?: string): Promise<void> {
    if (!parentEventId) return;

    const jobId = this.pendingJobs.get(parentEventId);
    if (!jobId) return; // Not a scheduler-triggered task

    this.pendingJobs.delete(parentEventId);

    const { suspended } = await this.schedulerService.completeJobRun(jobId, success, error);

    if (suspended) {
      // Publish schedule.suspended event
      const suspendedEvent = createScheduleSuspended({
        jobId,
        agentId: 'unknown', // will be filled from DB in a real implementation
        lastError: error ?? 'Unknown error',
        consecutiveFailures: 3,
      });
      await this.bus.publish('system', suspendedEvent);

      // Notify the CEO via a synthetic agent.task to the coordinator
      const notifyEvent = createAgentTask({
        agentId: 'coordinator',
        conversationId: `scheduler:notify:${jobId}`,
        channelId: 'scheduler',
        senderId: 'scheduler',
        content: `A scheduled job has been suspended after 3 consecutive failures. Job ID: ${jobId}. Last error: ${error ?? 'Unknown'}. The job will not run again until manually unsuspended.`,
        parentEventId: suspendedEvent.id,
      });
      await this.bus.publish('system', notifyEvent);

      this.logger.warn({ jobId, error }, 'Scheduled job suspended after consecutive failures');
    }
  }

  /**
   * Load declarative jobs from agent YAML configs.
   * Called during bootstrap to upsert YAML-declared schedules.
   */
  async loadDeclarativeJobs(agentConfigs: AgentYamlConfig[]): Promise<void> {
    for (const config of agentConfigs) {
      if (!config.schedule || config.schedule.length === 0) continue;

      for (const schedule of config.schedule) {
        try {
          const jobId = await this.schedulerService.upsertDeclarativeJob(config.name, schedule);
          this.logger.info({ agentId: config.name, cron: schedule.cron, jobId }, 'Declarative job upserted');
        } catch (err) {
          this.logger.error({ err, agentId: config.name, cron: schedule.cron }, 'Failed to upsert declarative job');
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/scheduler/scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/scheduler.ts tests/unit/scheduler/scheduler.test.ts
git commit -m "feat: add scheduler loop with job polling, completion tracking, and declarative bootstrap"
```

---

### Task 5: Scheduler Skills

**Files:**
- Create: `skills/scheduler-create/skill.json`
- Create: `skills/scheduler-create/handler.ts`
- Create: `skills/scheduler-list/skill.json`
- Create: `skills/scheduler-list/handler.ts`
- Create: `skills/scheduler-cancel/skill.json`
- Create: `skills/scheduler-cancel/handler.ts`
- Create: `tests/unit/skills/scheduler-create.test.ts`
- Create: `tests/unit/skills/scheduler-list.test.ts`
- Create: `tests/unit/skills/scheduler-cancel.test.ts`

- [ ] **Step 1: Write failing tests for scheduler-create**

Create: `tests/unit/skills/scheduler-create.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SchedulerCreateHandler } from '../../../skills/scheduler-create/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

describe('SchedulerCreateHandler', () => {
  const handler = new SchedulerCreateHandler();

  it('returns failure when schedulerService is not available', async () => {
    const result = await handler.execute(makeCtx({ task: 'test', cron_expr: '0 9 * * 1' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('schedulerService');
    }
  });

  it('returns failure when neither cron_expr nor run_at is provided', async () => {
    const mockService = { createJob: vi.fn() };
    const result = await handler.execute(makeCtx(
      { task: 'test' },
      { schedulerService: mockService as any },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('cron_expr or run_at');
    }
  });

  it('creates a cron job successfully', async () => {
    const mockService = {
      createJob: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
    };
    const result = await handler.execute(makeCtx(
      { task: 'weekly report', cron_expr: '0 9 * * 1' },
      { schedulerService: mockService as any },
    ));
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).jobId).toBe('job-1');
    }
  });

  it('creates a persistent task when intent_anchor is provided', async () => {
    const mockService = {
      createJob: vi.fn().mockResolvedValue({ jobId: 'job-1', agentTaskId: 'task-1' }),
    };
    const result = await handler.execute(makeCtx(
      { task: 'research', cron_expr: '0 */4 * * *', intent_anchor: 'Monitor competitors' },
      { schedulerService: mockService as any },
    ));
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).agentTaskId).toBe('task-1');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/skills/scheduler-create.test.ts`
Expected: FAIL — `SchedulerCreateHandler` does not exist.

- [ ] **Step 3: Create scheduler-create skill manifest**

Create: `skills/scheduler-create/skill.json`

```json
{
  "name": "scheduler-create",
  "description": "Create a scheduled job. Supports cron expressions for recurring jobs and ISO 8601 timestamps for one-shot jobs. Provide intent_anchor to create a persistent multi-burst task.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "task": "string",
    "cron_expr": "string?",
    "run_at": "string?",
    "agent_id": "string?",
    "intent_anchor": "string?",
    "error_budget": "object?"
  },
  "outputs": {
    "jobId": "string",
    "agentTaskId": "string?"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000
}
```

- [ ] **Step 4: Create scheduler-create handler**

Create: `skills/scheduler-create/handler.ts`

```typescript
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class SchedulerCreateHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.schedulerService) {
      return { success: false, error: 'schedulerService not available — scheduler skills require infrastructure access' };
    }

    const task = ctx.input.task as string | undefined;
    const cronExpr = ctx.input.cron_expr as string | undefined;
    const runAt = ctx.input.run_at as string | undefined;
    const agentId = ctx.input.agent_id as string | undefined;
    const intentAnchor = ctx.input.intent_anchor as string | undefined;
    const errorBudget = ctx.input.error_budget as { maxTurns: number; maxConsecutiveErrors: number } | undefined;

    if (!task) {
      return { success: false, error: 'Missing required field: task' };
    }
    if (!cronExpr && !runAt) {
      return { success: false, error: 'Either cron_expr or run_at must be provided' };
    }

    try {
      const result = await ctx.schedulerService.createJob({
        agentId: agentId ?? 'coordinator',
        cronExpr,
        runAt,
        taskPayload: { task },
        createdBy: agentId ?? 'coordinator',
        intentAnchor,
        errorBudget,
      });

      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to create scheduled job');
      return { success: false, error: message };
    }
  }
}
```

- [ ] **Step 5: Run scheduler-create test**

Run: `npx vitest run tests/unit/skills/scheduler-create.test.ts`
Expected: PASS

- [ ] **Step 6: Write failing tests for scheduler-list**

Create: `tests/unit/skills/scheduler-list.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SchedulerListHandler } from '../../../skills/scheduler-list/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

describe('SchedulerListHandler', () => {
  const handler = new SchedulerListHandler();

  it('returns failure when schedulerService is not available', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
  });

  it('returns jobs with no filters', async () => {
    const mockService = {
      listJobs: vi.fn().mockResolvedValue([
        { id: 'job-1', agentId: 'coordinator', status: 'pending' },
      ]),
    };
    const result = await handler.execute(makeCtx({}, { schedulerService: mockService as any }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).jobs).toHaveLength(1);
    }
  });

  it('passes filters to listJobs', async () => {
    const mockService = {
      listJobs: vi.fn().mockResolvedValue([]),
    };
    await handler.execute(makeCtx(
      { status: 'suspended', agent_id: 'coordinator' },
      { schedulerService: mockService as any },
    ));
    expect(mockService.listJobs).toHaveBeenCalledWith({ status: 'suspended', agentId: 'coordinator' });
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run tests/unit/skills/scheduler-list.test.ts`
Expected: FAIL — `SchedulerListHandler` does not exist.

- [ ] **Step 8: Create scheduler-list skill**

Create: `skills/scheduler-list/skill.json`

```json
{
  "name": "scheduler-list",
  "description": "List scheduled jobs. Optionally filter by status (pending, running, completed, failed, suspended, cancelled) or agent_id.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "status": "string?",
    "agent_id": "string?"
  },
  "outputs": {
    "jobs": "array"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000
}
```

Create: `skills/scheduler-list/handler.ts`

```typescript
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class SchedulerListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.schedulerService) {
      return { success: false, error: 'schedulerService not available — scheduler skills require infrastructure access' };
    }

    const status = ctx.input.status as string | undefined;
    const agentId = ctx.input.agent_id as string | undefined;

    try {
      const jobs = await ctx.schedulerService.listJobs({
        status,
        agentId,
      });

      return { success: true, data: { jobs } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to list scheduled jobs');
      return { success: false, error: message };
    }
  }
}
```

- [ ] **Step 9: Run scheduler-list test**

Run: `npx vitest run tests/unit/skills/scheduler-list.test.ts`
Expected: PASS

- [ ] **Step 10: Write failing tests for scheduler-cancel**

Create: `tests/unit/skills/scheduler-cancel.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SchedulerCancelHandler } from '../../../skills/scheduler-cancel/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

describe('SchedulerCancelHandler', () => {
  const handler = new SchedulerCancelHandler();

  it('returns failure when schedulerService is not available', async () => {
    const result = await handler.execute(makeCtx({ job_id: 'job-1' }));
    expect(result.success).toBe(false);
  });

  it('returns failure when job_id is missing', async () => {
    const mockService = { cancelJob: vi.fn() };
    const result = await handler.execute(makeCtx({}, { schedulerService: mockService as any }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('job_id');
    }
  });

  it('cancels a job successfully', async () => {
    const mockService = {
      cancelJob: vi.fn().mockResolvedValue(undefined),
    };
    const result = await handler.execute(makeCtx(
      { job_id: 'job-1' },
      { schedulerService: mockService as any },
    ));
    expect(result.success).toBe(true);
    expect(mockService.cancelJob).toHaveBeenCalledWith('job-1');
  });
});
```

- [ ] **Step 11: Run test to verify it fails**

Run: `npx vitest run tests/unit/skills/scheduler-cancel.test.ts`
Expected: FAIL — `SchedulerCancelHandler` does not exist.

- [ ] **Step 12: Create scheduler-cancel skill**

Create: `skills/scheduler-cancel/skill.json`

```json
{
  "name": "scheduler-cancel",
  "description": "Cancel a scheduled job by its ID. The job is soft-deleted (status set to cancelled) and preserved for audit history.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "job_id": "string"
  },
  "outputs": {
    "cancelled": "boolean"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000
}
```

Create: `skills/scheduler-cancel/handler.ts`

```typescript
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class SchedulerCancelHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.schedulerService) {
      return { success: false, error: 'schedulerService not available — scheduler skills require infrastructure access' };
    }

    const jobId = ctx.input.job_id as string | undefined;
    if (!jobId) {
      return { success: false, error: 'Missing required field: job_id' };
    }

    try {
      await ctx.schedulerService.cancelJob(jobId);
      return { success: true, data: { cancelled: true, jobId } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to cancel scheduled job');
      return { success: false, error: message };
    }
  }
}
```

- [ ] **Step 13: Run all scheduler skill tests**

Run: `npx vitest run tests/unit/skills/scheduler-create.test.ts tests/unit/skills/scheduler-list.test.ts tests/unit/skills/scheduler-cancel.test.ts`
Expected: PASS — all three handlers work.

- [ ] **Step 14: Add schedulerService to SkillContext type**

In `src/skills/types.ts`, add to the `SkillContext` interface:

```typescript
  /** Scheduler service — only available to infrastructure skills */
  schedulerService?: import('../scheduler/scheduler-service.js').SchedulerService;
```

- [ ] **Step 15: Wire schedulerService into ExecutionLayer**

In `src/skills/execution.ts`:

1. Add `SchedulerService` import:
```typescript
import type { SchedulerService } from '../scheduler/scheduler-service.js';
```

2. Add to class fields:
```typescript
private schedulerService?: SchedulerService;
```

3. Add to constructor options type and assignment:
```typescript
constructor(registry: SkillRegistry, logger: Logger, options?: { bus?: EventBus; agentRegistry?: AgentRegistry; contactService?: ContactService; outboundGateway?: OutboundGateway; heldMessages?: HeldMessageService; schedulerService?: SchedulerService }) {
  // ... existing assignments ...
  this.schedulerService = options?.schedulerService;
}
```

4. In the infrastructure skill context section (after `heldMessages`), add:
```typescript
if (this.schedulerService) {
  ctx.schedulerService = this.schedulerService;
}
```

- [ ] **Step 16: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (including existing execution layer tests).

- [ ] **Step 17: Commit**

```bash
git add skills/scheduler-create/ skills/scheduler-list/ skills/scheduler-cancel/ tests/unit/skills/scheduler-create.test.ts tests/unit/skills/scheduler-list.test.ts tests/unit/skills/scheduler-cancel.test.ts src/skills/types.ts src/skills/execution.ts
git commit -m "feat: add scheduler-create, scheduler-list, scheduler-cancel skills"
```

---

### Task 6: HTTP API Routes

**Files:**
- Create: `src/channels/http/routes/jobs.ts`
- Modify: `src/channels/http/http-adapter.ts`

- [ ] **Step 1: Write failing tests for job routes**

Create: `tests/unit/http/jobs-routes.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { jobRoutes } from '../../../src/channels/http/routes/jobs.js';

function mockSchedulerService() {
  return {
    listJobs: vi.fn().mockResolvedValue([]),
    getJob: vi.fn().mockResolvedValue(null),
    createJob: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    unsuspendJob: vi.fn().mockResolvedValue(undefined),
    updateJob: vi.fn().mockResolvedValue(undefined),
  };
}

describe('job routes', () => {
  it('GET /api/jobs returns empty list', async () => {
    const app = Fastify();
    const service = mockSchedulerService();
    await app.register(jobRoutes, { schedulerService: service as any });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/jobs' });

    expect(response.statusCode).toBe(200);
    expect(response.json().jobs).toEqual([]);
  });

  it('GET /api/jobs/:id returns 404 for unknown job', async () => {
    const app = Fastify();
    const service = mockSchedulerService();
    await app.register(jobRoutes, { schedulerService: service as any });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/jobs/nonexistent' });

    expect(response.statusCode).toBe(404);
  });

  it('POST /api/jobs creates a job', async () => {
    const app = Fastify();
    const service = mockSchedulerService();
    await app.register(jobRoutes, { schedulerService: service as any });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { agent_id: 'coordinator', cron_expr: '0 9 * * 1', task_payload: { task: 'test' } },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().jobId).toBe('job-1');
  });

  it('POST /api/jobs returns 400 when agent_id is missing', async () => {
    const app = Fastify();
    const service = mockSchedulerService();
    await app.register(jobRoutes, { schedulerService: service as any });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: { cron_expr: '0 9 * * 1', task_payload: { task: 'test' } },
    });

    expect(response.statusCode).toBe(400);
  });

  it('DELETE /api/jobs/:id cancels a job', async () => {
    const app = Fastify();
    const service = mockSchedulerService();
    await app.register(jobRoutes, { schedulerService: service as any });
    await app.ready();

    const response = await app.inject({ method: 'DELETE', url: '/api/jobs/job-1' });

    expect(response.statusCode).toBe(200);
    expect(service.cancelJob).toHaveBeenCalledWith('job-1');
  });

  it('PATCH /api/jobs/:id unsuspends a suspended job', async () => {
    const app = Fastify();
    const service = mockSchedulerService();
    service.getJob.mockResolvedValue({ id: 'job-1', status: 'suspended' });
    await app.register(jobRoutes, { schedulerService: service as any });
    await app.ready();

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/jobs/job-1',
      payload: { status: 'pending' },
    });

    expect(response.statusCode).toBe(200);
    expect(service.unsuspendJob).toHaveBeenCalledWith('job-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/http/jobs-routes.test.ts`
Expected: FAIL — `jobRoutes` does not exist.

- [ ] **Step 3: Implement job routes**

Create: `src/channels/http/routes/jobs.ts`

```typescript
// jobs.ts — CRUD endpoints for scheduled jobs.
//
// All endpoints require bearer token auth (handled by the adapter's onRequest hook).
// Uses SchedulerService for all operations — no direct DB access.

import type { FastifyInstance } from 'fastify';
import type { SchedulerService } from '../../../scheduler/scheduler-service.js';

export interface JobRouteOptions {
  schedulerService: SchedulerService;
}

export async function jobRoutes(
  app: FastifyInstance,
  options: JobRouteOptions,
): Promise<void> {
  const { schedulerService } = options;

  // GET /api/jobs — list all jobs with optional filters
  app.get('/api/jobs', async (request, reply) => {
    const { status, agent_id } = request.query as { status?: string; agent_id?: string };
    const jobs = await schedulerService.listJobs({
      status,
      agentId: agent_id,
    });
    return reply.send({ jobs });
  });

  // GET /api/jobs/:id — get a single job
  app.get('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await schedulerService.getJob(id);
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }
    return reply.send({ job });
  });

  // POST /api/jobs — create a new job
  app.post('/api/jobs', async (request, reply) => {
    const body = request.body as {
      agent_id?: string;
      cron_expr?: string;
      run_at?: string;
      task_payload?: Record<string, unknown>;
      intent_anchor?: string;
      error_budget?: { maxTurns: number; maxConsecutiveErrors: number };
    };

    if (!body.agent_id) {
      return reply.status(400).send({ error: 'agent_id is required' });
    }
    if (!body.task_payload) {
      return reply.status(400).send({ error: 'task_payload is required' });
    }
    if (!body.cron_expr && !body.run_at) {
      return reply.status(400).send({ error: 'Either cron_expr or run_at is required' });
    }

    try {
      const result = await schedulerService.createJob({
        agentId: body.agent_id,
        cronExpr: body.cron_expr,
        runAt: body.run_at,
        taskPayload: body.task_payload,
        createdBy: 'api',
        intentAnchor: body.intent_anchor,
        errorBudget: body.error_budget,
      });
      return reply.status(201).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  // PATCH /api/jobs/:id — update a job
  app.patch('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      status?: string;
      cron_expr?: string;
      run_at?: string;
      task_payload?: Record<string, unknown>;
    };

    try {
      // Unsuspend flow: if status is being set to 'pending' and job is suspended
      if (body.status === 'pending') {
        const job = await schedulerService.getJob(id);
        if (job?.status === 'suspended') {
          await schedulerService.unsuspendJob(id);
          return reply.send({ unsuspended: true, jobId: id });
        }
      }

      // General update
      await schedulerService.updateJob(id, {
        cronExpr: body.cron_expr,
        runAt: body.run_at,
        taskPayload: body.task_payload,
      });
      return reply.send({ updated: true, jobId: id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  // DELETE /api/jobs/:id — soft delete (cancel) a job
  app.delete('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await schedulerService.cancelJob(id);
    return reply.send({ cancelled: true, jobId: id });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/http/jobs-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Wire job routes into HttpAdapter**

In `src/channels/http/http-adapter.ts`:

1. Add import:
```typescript
import { jobRoutes } from './routes/jobs.js';
import type { SchedulerService } from '../../scheduler/scheduler-service.js';
```

2. Add `schedulerService` to `HttpAdapterConfig`:
```typescript
export interface HttpAdapterConfig {
  bus: EventBus;
  logger: Logger;
  pool: Pool;
  agentRegistry: AgentRegistry;
  port: number;
  apiToken: string | undefined;
  agentNames: string[];
  skillNames: string[];
  schedulerService?: SchedulerService;
}
```

3. In `start()`, after the existing route registrations, add:
```typescript
    if (this.config.schedulerService) {
      await this.app.register(jobRoutes, { schedulerService: this.config.schedulerService });
    }
```

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/channels/http/routes/jobs.ts tests/unit/http/jobs-routes.test.ts src/channels/http/http-adapter.ts
git commit -m "feat: add /api/jobs HTTP routes for scheduler management"
```

---

### Task 7: Bootstrap & Shutdown Integration

**Files:**
- Modify: `src/index.ts`
- Modify: `agents/coordinator.yaml`
- Modify: `agents/research-analyst.yaml`

- [ ] **Step 1: Add scheduler imports to index.ts**

Add at the top of `src/index.ts`:

```typescript
import { SchedulerService } from './scheduler/scheduler-service.js';
import { Scheduler } from './scheduler/scheduler.js';
```

- [ ] **Step 2: Wire scheduler into bootstrap sequence**

In `src/index.ts`, after the execution layer construction and before the two-pass agent registration, add:

```typescript
  // Scheduler — Postgres-backed job scheduler for cron and one-shot tasks.
  // SchedulerService is the shared service; Scheduler is the polling loop.
  // Constructed early so it can be passed to ExecutionLayer and HttpAdapter.
  const schedulerService = new SchedulerService(pool, bus, logger);
  const scheduler = new Scheduler({ pool, bus, logger, schedulerService });
```

Update the `ExecutionLayer` constructor call to include `schedulerService`:

```typescript
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry, contactService, outboundGateway, heldMessages, schedulerService });
```

After agent registration (after "Verify we have a coordinator"), add:

```typescript
  // Load declarative schedules from agent YAML configs and start the scheduler loop.
  // Runs after agent registration so all agents are known when jobs are upserted.
  await scheduler.loadDeclarativeJobs(agentConfigs);
  scheduler.start();
  logger.info('Scheduler started');
```

Update the `HttpAdapter` constructor to include `schedulerService`:

```typescript
  const httpAdapter = new HttpAdapter({
    bus,
    logger,
    pool,
    agentRegistry,
    port: config.httpPort,
    apiToken: config.apiToken,
    agentNames: agentConfigs.map(c => c.name),
    skillNames: skillRegistry.list().map(s => s.manifest.name),
    schedulerService,
  });
```

- [ ] **Step 3: Add scheduler to graceful shutdown**

In the `shutdown` function, add before `pool.end()`:

```typescript
    try {
      scheduler.stop();
    } catch (err) {
      logger.error({ err }, 'Error stopping scheduler during shutdown');
    }
```

- [ ] **Step 4: Add scheduler skills to agent YAML configs**

In `agents/coordinator.yaml`, add to `pinned_skills`:

```yaml
  - scheduler-create
  - scheduler-list
  - scheduler-cancel
```

In `agents/research-analyst.yaml`, add to `pinned_skills`:

```yaml
  - scheduler-create
  - scheduler-list
  - scheduler-cancel
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts agents/coordinator.yaml agents/research-analyst.yaml
git commit -m "feat: wire scheduler into bootstrap, shutdown, and agent configs"
```

---

### Task 8: Documentation Updates

**Files:**
- Modify: `docs/specs/00-overview.md`
- Modify: `docs/specs/07-scheduler.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update 00-overview.md to document the system layer**

In `docs/specs/00-overview.md`:

Update the ASCII architecture diagram to show the system layer explicitly. Replace the existing "Cross-cutting subscribers" note with a proper section:

```
Cross-cutting (System Layer — full pub/sub access):
  - Audit Logger → appends every event to audit_log table
  - Memory Engine → handles memory.store/query events
  - Scheduler → handles schedule.create/trigger events, fires agent.task on cron
```

Update the "Bus Security Enforcement" section to mention the system layer:

> The bus validates publisher authorization at registration time. A module registered as `layer: "channel"` can only publish event types in the channel allowlist. The `system` layer is the exception — it has full publish and subscribe access to all event types, used by trusted infrastructure components (audit logger, scheduler) that need to observe or participate across all layers.

Update "Architecture: Message Bus Pattern" header text from "four hard-separated layers" to:

> Five layers connected by a central in-process message bus: four domain layers (Channel, Dispatch, Agent, Execution) with hard security boundaries, plus a System layer for trusted cross-cutting infrastructure.

- [ ] **Step 2: Update 07-scheduler.md with implementation details**

Add to the top of `docs/specs/07-scheduler.md`, after the overview:

```markdown
**Layer:** System (same as audit logger — full pub/sub access)

**Bus events:** `schedule.created`, `schedule.fired`, `schedule.suspended`

**Shared service:** `SchedulerService` handles all job CRUD — consumed by scheduler loop, agent skills, and HTTP API routes.

**Suspension notifications:** Routed through the coordinator as synthetic `agent.task` events — no dedicated notification subsystem.
```

- [ ] **Step 3: Update CLAUDE.md architecture section**

In `CLAUDE.md`, update the Architecture section:

```markdown
## Architecture

Five layers connected by a message bus. Four domain layers have hard security boundaries; the fifth (System) is for trusted cross-cutting infrastructure.

- **Channel Layer** — translates platform messages (Telegram, Email, etc.) into normalized bus events
- **Dispatch Layer** — routes messages to agents, enforces policy, translates responses back
- **Agent Layer** — LLM-powered agents with isolated memory scopes
- **Execution Layer** — runs skills (local or MCP), validates permissions, sanitizes outputs
- **System Layer** — trusted infrastructure with full pub/sub access (audit logger, scheduler)

Cross-cutting: Audit Logger, Memory Engine, Scheduler.
```

- [ ] **Step 4: Commit**

```bash
git add docs/specs/00-overview.md docs/specs/07-scheduler.md CLAUDE.md
git commit -m "docs: update specs and CLAUDE.md to document system layer and scheduler"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Run linter**

Run: `npx eslint . --ext .ts`
Expected: No lint errors.

- [ ] **Step 4: Verify migration applies cleanly**

Run: `npx node-pg-migrate up`
Expected: Migration 008 applies (or is already applied).

- [ ] **Step 5: Review all changes on the branch**

Run: `git diff main --stat`
Verify the file list matches expectations: migration, events, permissions, scheduler service, scheduler loop, 3 skills (6 files), job routes, http adapter, execution layer, types, index.ts, agent YAMLs, 3 spec/doc files, and all test files.

- [ ] **Step 6: Final commit if any fixups needed**

Address any issues found in steps 1-5, commit fixes.
