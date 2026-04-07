# Scheduler Resilience: Stuck Job Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Run all commands from the repository root.

**Goal:** Prevent scheduled jobs from getting permanently stuck in `running` state by adding per-job timeout tracking, a startup cleanup sweep, and a continuous watchdog loop.

**Architecture:** Add two new DB columns (`run_started_at`, `expected_duration_seconds`) via migration; set `run_started_at` when a job is claimed and clear it on completion; on startup and every 5 minutes detect jobs that have exceeded their timeout threshold and reset them to `pending` (or `suspended` on the third consecutive failure).

**Tech Stack:** PostgreSQL (parameterized SQL, `make_interval`), TypeScript/ESM, Vitest, pino, node-pg pool.

---

### Task 1: DB migration — add `run_started_at` and `expected_duration_seconds`

**Files:**
- Create: `src/db/migrations/015_scheduler_resilience.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Up Migration
-- Add run_started_at so the scheduler can detect jobs stuck in 'running' state.
-- Set when status transitions to 'running'; cleared on completeJobRun().
-- NULL for existing jobs (treated as "stuck since forever" by recoverStuckJobs()).
--
-- Add expected_duration_seconds for per-job timeout thresholds.
-- NULL falls back to the DEFAULT_EXPECTED_DURATION_SECONDS constant (600s / 10min).
-- Set from YAML for declarative jobs, or explicitly at job creation via skill/API.

ALTER TABLE scheduled_jobs
  ADD COLUMN run_started_at          TIMESTAMPTZ,
  ADD COLUMN expected_duration_seconds INTEGER;

-- Down Migration
-- ALTER TABLE scheduled_jobs
--   DROP COLUMN run_started_at,
--   DROP COLUMN expected_duration_seconds;
```

- [ ] **Step 2: Run typecheck to confirm baseline is clean before any code changes**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/015_scheduler_resilience.sql
git commit -m "chore: add run_started_at and expected_duration_seconds to scheduled_jobs"
```

---

### Task 2: Add `schedule.recovered` event type to `events.ts`

**Files:**
- Modify: `src/bus/events.ts`

- [ ] **Step 1: Add payload interface after `ScheduleSuspendedPayload` (around line 193)**

```typescript
interface ScheduleRecoveredPayload {
  jobId: string;
  agentId: string;
  /** ISO timestamp when the job entered 'running' state. Null if pre-migration. */
  runStartedAt: string | null;
  /** Computed timeout threshold that was exceeded, in seconds. */
  timeoutSeconds: number;
  /** Value of consecutive_failures after incrementing for this recovery. */
  consecutiveFailures: number;
  /** True if the job was suspended rather than reset to pending. */
  suspended: boolean;
}
```

- [ ] **Step 2: Add event interface after `ScheduleSuspendedEvent` (around line 333)**

```typescript
export interface ScheduleRecoveredEvent extends BaseEvent {
  type: 'schedule.recovered';
  sourceLayer: 'system';
  payload: ScheduleRecoveredPayload;
}
```

- [ ] **Step 3: Add `ScheduleRecoveredEvent` to the `BusEvent` union (around line 360)**

Replace:
```typescript
  | ScheduleSuspendedEvent  // Scheduler: job auto-suspended
```
With:
```typescript
  | ScheduleSuspendedEvent   // Scheduler: job auto-suspended
  | ScheduleRecoveredEvent   // Scheduler: stuck job auto-recovered
```

- [ ] **Step 4: Add factory function after `createScheduleSuspended`**

```typescript
export function createScheduleRecovered(
  payload: ScheduleRecoveredPayload & { parentEventId?: string },
): ScheduleRecoveredEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'schedule.recovered',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}
```

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/bus/events.ts
git commit -m "feat: add schedule.recovered event type and factory"
```

---

### Task 3: Update DB row types and YAML config type

**Files:**
- Modify: `src/scheduler/scheduler-service.ts` (interfaces + `mapJobRow`)
- Modify: `src/agents/loader.ts` (`AgentYamlConfig` schedule entry type)

- [ ] **Step 1: Add new fields to `DbJobRow` in `scheduler-service.ts` (around line 54)**

```typescript
interface DbJobRow {
  id: string;
  agent_id: string;
  cron_expr: string | null;
  run_at: string | null;
  task_payload: Record<string, unknown>;
  status: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  created_by: string;
  created_at: string;
  timezone: string;
  agent_task_id: string | null;
  intent_anchor: string | null;
  progress: Record<string, unknown> | null;
  run_started_at: string | null;          // ← new
  expected_duration_seconds: number | null; // ← new
}
```

- [ ] **Step 2: Add new fields to `JobRow` (around line 27)**

```typescript
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
  timezone: string;
  agentTaskId: string | null;
  intentAnchor: string | null;
  progress: Record<string, unknown> | null;
  runStartedAt: string | null;              // ← new
  expectedDurationSeconds: number | null;   // ← new
}
```

- [ ] **Step 3: Update `mapJobRow` to include the new fields (around line 482)**

```typescript
function mapJobRow(row: DbJobRow): JobRow {
  return {
    id: row.id,
    agentId: row.agent_id,
    cronExpr: row.cron_expr,
    runAt: row.run_at,
    taskPayload: row.task_payload,
    status: row.status,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    createdBy: row.created_by,
    createdAt: row.created_at,
    timezone: row.timezone,
    agentTaskId: row.agent_task_id,
    intentAnchor: row.intent_anchor,
    progress: row.progress,
    runStartedAt: row.run_started_at,
    expectedDurationSeconds: row.expected_duration_seconds,
  };
}
```

- [ ] **Step 4: Update `AgentYamlConfig` schedule entry type in `loader.ts` (around line 39)**

```typescript
  schedule?: Array<{
    cron: string;
    task: string;
    /** Expected wall-clock duration in seconds. Drives stuck-job recovery timeout. */
    expectedDurationSeconds?: number;
  }>;
```

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/scheduler-service.ts src/agents/loader.ts
git commit -m "feat: add run_started_at and expectedDurationSeconds to job row types"
```

---

### Task 4: `fireJob` sets `run_started_at` when claiming a job

**Files:**
- Modify: `src/scheduler/scheduler.ts` (line 168 — the claim UPDATE)
- Modify: `tests/unit/scheduler/scheduler.test.ts`

- [ ] **Step 1: Write the failing test — add to the `pollDueJobs` describe block**

```typescript
it('sets run_started_at when claiming a job', async () => {
  const row = fakeDbRow();
  pool.query.mockResolvedValueOnce({ rows: [row] });       // SELECT due jobs
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // UPDATE claim

  await scheduler.pollDueJobs();

  const [claimSql, claimParams] = pool.query.mock.calls[1] as [string, unknown[]];
  expect(claimSql).toContain('run_started_at');
  expect(claimSql).toContain('now()');
  expect(claimParams).toContain('job-1');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -- tests/unit/scheduler/scheduler.test.ts
```
Expected: FAIL — the current claim UPDATE does not include `run_started_at`.

- [ ] **Step 3: Update the claim UPDATE in `fireJob` in `scheduler.ts` (around line 167)**

Replace:
```typescript
    const claimResult = await this.pool.query(
      `UPDATE scheduled_jobs SET status = $1 WHERE id = $2 AND status IN ('pending', 'failed')`,
      ['running', job.id],
    );
```
With:
```typescript
    const claimResult = await this.pool.query(
      `UPDATE scheduled_jobs SET status = $1, run_started_at = now() WHERE id = $2 AND status IN ('pending', 'failed')`,
      ['running', job.id],
    );
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -- tests/unit/scheduler/scheduler.test.ts
```
Expected: PASS (all existing tests plus the new one).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scheduler.ts tests/unit/scheduler/scheduler.test.ts
git commit -m "feat: set run_started_at when claiming a scheduled job"
```

---

### Task 5: `completeJobRun` clears `run_started_at`

**Files:**
- Modify: `src/scheduler/scheduler-service.ts` (success and failure UPDATE queries)
- Modify: `tests/unit/scheduler/scheduler-service.test.ts`

- [ ] **Step 1: Write the failing tests — add to the `completeJobRun` describe block**

```typescript
it('clears run_started_at on success for a recurring job', async () => {
  pool.query
    .mockResolvedValueOnce({
      rows: [{ id: 'job-1', cron_expr: '0 9 * * *', status: 'running', consecutive_failures: 0, timezone: 'UTC' }],
    })
    .mockResolvedValueOnce({ rows: [] }); // UPDATE

  await svc.completeJobRun('job-1', true);

  const [updateSql] = pool.query.mock.calls[1] as [string, unknown[]];
  expect(updateSql).toContain('run_started_at = NULL');
});

it('clears run_started_at on failure', async () => {
  pool.query
    .mockResolvedValueOnce({
      rows: [{ id: 'job-1', cron_expr: '0 9 * * *', status: 'running', consecutive_failures: 0, timezone: 'UTC' }],
    })
    .mockResolvedValueOnce({ rows: [] }); // UPDATE

  await svc.completeJobRun('job-1', false, 'some error');

  const [updateSql] = pool.query.mock.calls[1] as [string, unknown[]];
  expect(updateSql).toContain('run_started_at = NULL');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test -- tests/unit/scheduler/scheduler-service.test.ts
```
Expected: FAIL — current UPDATEs don't clear `run_started_at`.

- [ ] **Step 3: Add `run_started_at = NULL` to the success recurring-job UPDATE (around line 427)**

Replace:
```typescript
        const updateSql = `
          UPDATE scheduled_jobs
             SET last_run_at = now(),
                 next_run_at = $1,
                 consecutive_failures = 0,
                 last_error = NULL,
                 status = $2
           WHERE id = $3
        `;
        await this.pool.query(updateSql, [nextRunAt, 'pending', jobId]);
```
With:
```typescript
        const updateSql = `
          UPDATE scheduled_jobs
             SET last_run_at = now(),
                 next_run_at = $1,
                 consecutive_failures = 0,
                 last_error = NULL,
                 run_started_at = NULL,
                 status = $2
           WHERE id = $3
        `;
        await this.pool.query(updateSql, [nextRunAt, 'pending', jobId]);
```

- [ ] **Step 4: Add `run_started_at = NULL` to the success one-shot UPDATE (around line 439)**

Replace:
```typescript
        const updateSql = `
          UPDATE scheduled_jobs
             SET last_run_at = now(),
                 status = $1,
                 consecutive_failures = 0,
                 last_error = NULL
           WHERE id = $2
        `;
        await this.pool.query(updateSql, ['completed', jobId]);
```
With:
```typescript
        const updateSql = `
          UPDATE scheduled_jobs
             SET last_run_at = now(),
                 status = $1,
                 consecutive_failures = 0,
                 last_error = NULL,
                 run_started_at = NULL
           WHERE id = $2
        `;
        await this.pool.query(updateSql, ['completed', jobId]);
```

- [ ] **Step 5: Add `run_started_at = NULL` to the failure UPDATE (around line 459)**

Replace:
```typescript
    const updateSql = `
      UPDATE scheduled_jobs
         SET last_run_at = now(),
             consecutive_failures = $1,
             last_error = $2,
             status = $3
       WHERE id = $4
    `;
    await this.pool.query(updateSql, [newFailures, error ?? null, newStatus, jobId]);
```
With:
```typescript
    const updateSql = `
      UPDATE scheduled_jobs
         SET last_run_at = now(),
             consecutive_failures = $1,
             last_error = $2,
             run_started_at = NULL,
             status = $3
       WHERE id = $4
    `;
    await this.pool.query(updateSql, [newFailures, error ?? null, newStatus, jobId]);
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test -- tests/unit/scheduler/scheduler-service.test.ts
```
Expected: PASS (all existing tests plus the two new ones).

- [ ] **Step 7: Commit**

```bash
git add src/scheduler/scheduler-service.ts tests/unit/scheduler/scheduler-service.test.ts
git commit -m "feat: clear run_started_at on completeJobRun"
```

---

### Task 6: `SchedulerService.recoverStuckJob()` — per-job DB recovery

**Files:**
- Modify: `src/scheduler/scheduler-service.ts`
- Modify: `tests/unit/scheduler/scheduler-service.test.ts`

- [ ] **Step 1: Write failing tests — add a new `recoverStuckJob` describe block**

```typescript
describe('recoverStuckJob', () => {
  it('resets a stuck cron job to pending and increments failures', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          cron_expr: '30 7 * * *',
          run_at: null,
          consecutive_failures: 0,
          timezone: 'America/Toronto',
        }],
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    const result = await svc.recoverStuckJob('job-1', 900);

    expect(result.suspended).toBe(false);
    expect(result.consecutiveFailures).toBe(1);

    const [updateSql, updateParams] = pool.query.mock.calls[1] as [string, unknown[]];
    expect(updateSql).toContain('run_started_at = NULL');
    expect(updateSql).toContain('consecutive_failures');
    expect(updateParams).toContain('pending');
    expect(updateParams).toContain('job-1');
    // Error message should mention timeout
    const lastError = updateParams.find(p => typeof p === 'string' && (p as string).includes('timed out'));
    expect(lastError).toBeTruthy();
  });

  it('resets a one-shot stuck job to pending with next_run_at = now', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-2',
          cron_expr: null,
          run_at: new Date(Date.now() - 3600_000).toISOString(),
          consecutive_failures: 0,
          timezone: 'UTC',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await svc.recoverStuckJob('job-2', 600);

    expect(result.suspended).toBe(false);
    const [updateSql, updateParams] = pool.query.mock.calls[1] as [string, unknown[]];
    // For one-shot: next_run_at should be approximately now (within 5 seconds)
    const nextRunAt = updateParams[3] as Date;
    expect(nextRunAt).toBeInstanceOf(Date);
    expect(Math.abs(nextRunAt.getTime() - Date.now())).toBeLessThan(5000);
    expect(updateParams).toContain('pending');
  });

  it('suspends the job when consecutive_failures reaches SUSPEND_THRESHOLD', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-3',
          cron_expr: '0 * * * *',
          run_at: null,
          consecutive_failures: 2, // one more failure = 3 = SUSPEND_THRESHOLD
          timezone: 'UTC',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await svc.recoverStuckJob('job-3', 600);

    expect(result.suspended).toBe(true);
    expect(result.consecutiveFailures).toBe(3);

    const [, updateParams] = pool.query.mock.calls[1] as [string, unknown[]];
    expect(updateParams).toContain('suspended');
  });

  it('throws when job not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await expect(svc.recoverStuckJob('missing-job', 600)).rejects.toThrow('Job not found');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test -- tests/unit/scheduler/scheduler-service.test.ts
```
Expected: FAIL — `recoverStuckJob` does not exist yet.

- [ ] **Step 3: Add `recoverStuckJob` to `SchedulerService` in `scheduler-service.ts` — add after `completeJobRun`**

```typescript
  /**
   * Recover a single stuck job: increment failures, reset status to pending (or suspend),
   * clear run_started_at, advance next_run_at, and write a descriptive last_error.
   *
   * Called by Scheduler.recoverStuckJobs() for each job that has exceeded its timeout.
   */
  async recoverStuckJob(
    jobId: string,
    timeoutSeconds: number,
  ): Promise<{ suspended: boolean; consecutiveFailures: number }> {
    const { rows } = await this.pool.query(
      `SELECT id, cron_expr, run_at, consecutive_failures, timezone
         FROM scheduled_jobs WHERE id = $1`,
      [jobId],
    );
    const job = rows[0] as {
      id: string;
      cron_expr: string | null;
      run_at: string | null;
      consecutive_failures: number;
      timezone: string;
    } | undefined;

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const newFailures = job.consecutive_failures + 1;
    const shouldSuspend = newFailures >= SUSPEND_THRESHOLD;
    const newStatus = shouldSuspend ? 'suspended' : 'pending';

    // For recurring jobs: advance to the next valid fire time so the job doesn't
    // attempt to catch up on missed slots. For one-shot jobs: re-fire immediately.
    const nextRunAt = job.cron_expr
      ? this.nextRunFromCron(job.cron_expr, job.timezone)
      : new Date();

    const timeoutMinutes = Math.round(timeoutSeconds / 60);
    const lastError = `Job timed out after ${timeoutMinutes}m — auto-recovered`;

    await this.pool.query(
      `UPDATE scheduled_jobs
          SET status               = $1,
              consecutive_failures = $2,
              last_error           = $3,
              run_started_at       = NULL,
              next_run_at          = $4
        WHERE id = $5`,
      [newStatus, newFailures, lastError, nextRunAt, jobId],
    );

    if (shouldSuspend) {
      this.logger.warn({ jobId, consecutiveFailures: newFailures }, 'Stuck job suspended after consecutive recovery failures');
    } else {
      this.logger.warn({ jobId, consecutiveFailures: newFailures, timeoutMinutes }, 'Stuck job recovered — reset to pending');
    }

    return { suspended: shouldSuspend, consecutiveFailures: newFailures };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test -- tests/unit/scheduler/scheduler-service.test.ts
```
Expected: PASS (all tests including the new block).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scheduler-service.ts tests/unit/scheduler/scheduler-service.test.ts
git commit -m "feat: add SchedulerService.recoverStuckJob()"
```

---

### Task 7: `Scheduler.recoverStuckJobs()` — query + publish events

**Files:**
- Modify: `src/scheduler/scheduler.ts`
- Modify: `tests/unit/scheduler/scheduler.test.ts`

- [ ] **Step 1: Add new constants and a pure helper at the top of `scheduler.ts` (after line 15)**

```typescript
// Watchdog runs every 5 minutes to detect jobs stuck mid-run.
export const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

// Default assumed duration for a job with no explicit expectedDurationSeconds.
const DEFAULT_EXPECTED_DURATION_SECONDS = 600; // 10 minutes

// Timeout = min(expected × MULTIPLIER, expected + CAP). Gives larger headroom for
// short jobs while capping the maximum extension at +60 minutes for long ones.
//   2m expected → 15m timeout;  30m expected → 90m timeout.
const RECOVERY_TIMEOUT_MULTIPLIER = 7.5;
const RECOVERY_TIMEOUT_CAP_SECONDS = 3600;

/**
 * Compute the recovery timeout for a job given its expected duration.
 * Exported for unit testing; the SQL query in recoverStuckJobs() mirrors this formula.
 */
export function computeRecoveryTimeout(expectedDurationSeconds: number): number {
  return Math.min(
    expectedDurationSeconds * RECOVERY_TIMEOUT_MULTIPLIER,
    expectedDurationSeconds + RECOVERY_TIMEOUT_CAP_SECONDS,
  );
}
```

- [ ] **Step 2: Add formula boundary tests to `scheduler.test.ts` — add a new top-level describe block**

Also add `computeRecoveryTimeout` to the import at the top of the test file:
```typescript
import { Scheduler, POLL_INTERVAL_MS, WATCHDOG_INTERVAL_MS, computeRecoveryTimeout } from '../../../src/scheduler/scheduler.js';
```

Test block:
```typescript
describe('computeRecoveryTimeout', () => {
  it('gives 7.5× timeout for short jobs', () => {
    expect(computeRecoveryTimeout(60)).toBe(450);    // 1m → 7.5m
    expect(computeRecoveryTimeout(120)).toBe(900);   // 2m → 15m
  });

  it('caps the extension at +60 minutes for long jobs', () => {
    expect(computeRecoveryTimeout(1800)).toBe(5400);  // 30m → 90m (min(13500, 5400) = 5400)
    expect(computeRecoveryTimeout(3600)).toBe(7200);  // 60m → 120m (min(27000, 7200) = 7200)
    expect(computeRecoveryTimeout(7200)).toBe(10800); // 120m → 180m (min(54000, 10800) = 10800)
  });

  it('switches from multiplier to cap at the crossover point (800s)', () => {
    // At 800s: 800 * 7.5 = 6000, 800 + 3600 = 4400. min = 4400 (cap wins)
    expect(computeRecoveryTimeout(800)).toBe(4400);
    // At 600s: 600 * 7.5 = 4500, 600 + 3600 = 4200. min = 4200 (cap wins)
    expect(computeRecoveryTimeout(600)).toBe(4200);
    // At 480s: 480 * 7.5 = 3600, 480 + 3600 = 4080. min = 3600 (multiplier wins)
    expect(computeRecoveryTimeout(480)).toBe(3600);
  });
});
```

- [ ] **Step 3: Add import for `createScheduleRecovered` and `createScheduleSuspended` in `scheduler.ts` (already imports `createScheduleSuspended` — just add the new one)**

The import at the top (around line 7) currently reads:
```typescript
import {
  createScheduleFired,
  createScheduleSuspended,
  createAgentTask,
} from '../bus/events.js';
```

Update to:
```typescript
import {
  createScheduleFired,
  createScheduleSuspended,
  createScheduleRecovered,
  createAgentTask,
} from '../bus/events.js';
```

- [ ] **Step 3: Write failing tests — add a `recoverStuckJobs` describe block to `scheduler.test.ts`**

First update `fakeDbRow` to include the new fields and `timezone`:

```typescript
function fakeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    agent_id: 'agent-1',
    cron_expr: '0 9 * * *',
    run_at: null,
    task_payload: { skill: 'morning-brief' },
    status: 'pending',
    last_run_at: null,
    next_run_at: new Date().toISOString(),
    last_error: null,
    consecutive_failures: 0,
    created_by: 'system',
    created_at: new Date().toISOString(),
    timezone: 'UTC',
    agent_task_id: null,
    intent_anchor: null,
    progress: null,
    run_started_at: null,
    expected_duration_seconds: null,
    ...overrides,
  };
}
```

Then add the test block:

```typescript
describe('recoverStuckJobs', () => {
  it('does nothing when no jobs are stuck', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await scheduler.recoverStuckJobs();

    expect(pool.query).toHaveBeenCalledOnce();
    expect(schedulerService.recoverStuckJob).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('recovers a stuck job: calls recoverStuckJob, publishes schedule.recovered', async () => {
    const stuckRow = {
      id: 'job-stuck',
      agent_id: 'agent-1',
      run_started_at: new Date(Date.now() - 3600_000).toISOString(),
      timeout_seconds: 900,
    };
    pool.query.mockResolvedValueOnce({ rows: [stuckRow] });
    schedulerService.recoverStuckJob.mockResolvedValueOnce({
      suspended: false,
      consecutiveFailures: 1,
    });

    await scheduler.recoverStuckJobs();

    expect(schedulerService.recoverStuckJob).toHaveBeenCalledWith('job-stuck', 900);

    expect(bus.publish).toHaveBeenCalledOnce();
    const [layer, event] = bus.publish.mock.calls[0] as [string, { type: string }];
    expect(layer).toBe('system');
    expect(event.type).toBe('schedule.recovered');
  });

  it('publishes schedule.recovered with suspended:true when job is suspended', async () => {
    const stuckRow = {
      id: 'job-3fail',
      agent_id: 'agent-1',
      run_started_at: new Date(Date.now() - 7200_000).toISOString(),
      timeout_seconds: 600,
    };
    pool.query.mockResolvedValueOnce({ rows: [stuckRow] });
    schedulerService.recoverStuckJob.mockResolvedValueOnce({
      suspended: true,
      consecutiveFailures: 3,
    });

    await scheduler.recoverStuckJobs();

    // Always publishes schedule.recovered — suspended flag is carried in the payload.
    // schedule.suspended is reserved for the normal failure-path suspension via completeJobRun.
    expect(bus.publish).toHaveBeenCalledOnce();
    const [, event] = bus.publish.mock.calls[0] as [string, { type: string; payload: { suspended: boolean } }];
    expect(event.type).toBe('schedule.recovered');
    expect(event.payload.suspended).toBe(true);
  });

  it('continues recovering other jobs if one recovery fails', async () => {
    const rows = [
      { id: 'job-a', agent_id: 'agent-1', run_started_at: new Date().toISOString(), timeout_seconds: 600 },
      { id: 'job-b', agent_id: 'agent-2', run_started_at: new Date().toISOString(), timeout_seconds: 600 },
    ];
    pool.query.mockResolvedValueOnce({ rows });
    schedulerService.recoverStuckJob
      .mockRejectedValueOnce(new Error('db error on job-a'))
      .mockResolvedValueOnce({ suspended: false, consecutiveFailures: 1 });

    await scheduler.recoverStuckJobs();

    // job-a failed but job-b should still be processed
    expect(schedulerService.recoverStuckJob).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
    // schedule.recovered published for job-b only
    expect(bus.publish).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
npm run test -- tests/unit/scheduler/scheduler.test.ts
```
Expected: FAIL — `scheduler.recoverStuckJobs` is not a function.

- [ ] **Step 5: Update `mockSchedulerService()` in `scheduler.test.ts` to include `recoverStuckJob`, then add `recoverStuckJobs()` to `Scheduler` class in `scheduler.ts` — add after `loadDeclarativeJobs`**

Update the mock helper:
```typescript
function mockSchedulerService() {
  return {
    completeJobRun: vi.fn(),
    upsertDeclarativeJob: vi.fn(),
    getJob: vi.fn(),
    nextRunFromCron: vi.fn(),
    recoverStuckJob: vi.fn(),   // ← new
  };
}
```

Replace the `(schedulerService as any).recoverStuckJob = vi.fn()` lines in the tests above with `schedulerService.recoverStuckJob.mockResolvedValueOnce(...)` now that the mock helper includes the method.

Add to `Scheduler` class:
```typescript
  /**
   * Detect and recover jobs stuck in 'running' state beyond their timeout threshold.
   * Called at startup (before scheduler.start()) and by the watchdog loop every 5 minutes.
   *
   * Timeout formula: min(expected × 7.5, expected + 3600s)
   * This gives proportionally more headroom to short jobs while capping the max extension
   * at +60 minutes for long-running jobs.
   *
   * Jobs with NULL run_started_at (e.g., stuck before this migration ran) are always recovered.
   */
  async recoverStuckJobs(): Promise<void> {
    // Find all running jobs that have exceeded their timeout. The LEAST() formula mirrors
    // the JS constants above — keep them in sync if the formula ever changes.
    // run_started_at IS NULL handles jobs stuck before this migration added the column.
    const sql = `
      SELECT
        id,
        agent_id,
        run_started_at,
        LEAST(
          COALESCE(expected_duration_seconds, $1)::float8 * $2,
          (COALESCE(expected_duration_seconds, $1) + $3)::float8
        )::integer AS timeout_seconds
      FROM scheduled_jobs
      WHERE status = 'running'
        AND (
          run_started_at IS NULL
          OR run_started_at < now() - make_interval(secs =>
              LEAST(
                COALESCE(expected_duration_seconds, $1)::float8 * $2,
                (COALESCE(expected_duration_seconds, $1) + $3)::float8
              )
            )
        )
    `;
    const { rows } = await this.pool.query(sql, [
      DEFAULT_EXPECTED_DURATION_SECONDS,
      RECOVERY_TIMEOUT_MULTIPLIER,
      RECOVERY_TIMEOUT_CAP_SECONDS,
    ]);

    if (rows.length === 0) return;

    this.logger.warn({ count: rows.length }, 'Recovering stuck jobs');

    for (const row of rows as Array<{ id: string; agent_id: string; run_started_at: string | null; timeout_seconds: number }>) {
      try {
        const result = await this.schedulerService.recoverStuckJob(row.id, row.timeout_seconds);

        const recoveredEvent = createScheduleRecovered({
          jobId: row.id,
          agentId: row.agent_id,
          runStartedAt: row.run_started_at,
          timeoutSeconds: row.timeout_seconds,
          consecutiveFailures: result.consecutiveFailures,
          suspended: result.suspended,
        });
        await this.bus.publish('system', recoveredEvent);

        this.logger.warn(
          {
            jobId: row.id,
            agentId: row.agent_id,
            runStartedAt: row.run_started_at,
            timeoutSeconds: row.timeout_seconds,
            consecutiveFailures: result.consecutiveFailures,
            suspended: result.suspended,
          },
          'Stuck job recovered',
        );
      } catch (err) {
        this.logger.error({ err, jobId: row.id }, 'Failed to recover stuck job — will retry on next watchdog tick');
      }
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test -- tests/unit/scheduler/scheduler.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/scheduler/scheduler.ts tests/unit/scheduler/scheduler.test.ts
git commit -m "feat: add Scheduler.recoverStuckJobs()"
```

---

### Task 8: Watchdog loop in `start()` / `stop()`

**Files:**
- Modify: `src/scheduler/scheduler.ts`
- Modify: `tests/unit/scheduler/scheduler.test.ts`

- [ ] **Step 1: Write failing tests — add to the `start / stop` describe block**

```typescript
it('starts a watchdog interval that calls recoverStuckJobs', async () => {
  pool.query.mockResolvedValue({ rows: [] }); // both pollDueJobs and recoverStuckJobs queries

  // Spy on recoverStuckJobs
  const recoverSpy = vi.spyOn(scheduler, 'recoverStuckJobs').mockResolvedValue();

  scheduler.start();

  // Advance by one watchdog interval
  await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS);

  expect(recoverSpy).toHaveBeenCalled();
});

it('stop clears the watchdog interval', async () => {
  pool.query.mockResolvedValue({ rows: [] });

  const recoverSpy = vi.spyOn(scheduler, 'recoverStuckJobs').mockResolvedValue();

  scheduler.start();
  scheduler.stop();

  recoverSpy.mockClear();

  await vi.advanceTimersByTimeAsync(WATCHDOG_INTERVAL_MS * 3);

  expect(recoverSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test -- tests/unit/scheduler/scheduler.test.ts
```
Expected: FAIL — no watchdog interval exists yet.

- [ ] **Step 3: Add `watchdogHandle` field and update `start()` / `stop()` in `scheduler.ts`**

Add the field to the class (after `intervalHandle`):
```typescript
  private watchdogHandle: ReturnType<typeof setInterval> | null = null;
```

Update `start()` (add after the existing `setInterval` for `pollDueJobs`):
```typescript
    // Watchdog: periodically recover jobs that got stuck in 'running' state.
    this.watchdogHandle = setInterval(() => {
      this.recoverStuckJobs().catch((err) => {
        this.logger.error({ err }, 'Unhandled error in recoverStuckJobs watchdog');
      });
    }, WATCHDOG_INTERVAL_MS);
```

Update `stop()`:
```typescript
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.watchdogHandle) {
      clearInterval(this.watchdogHandle);
      this.watchdogHandle = null;
    }
    this.logger.info('Scheduler stopped');
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test -- tests/unit/scheduler/scheduler.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scheduler.ts tests/unit/scheduler/scheduler.test.ts
git commit -m "feat: add watchdog loop to scheduler start/stop"
```

---

### Task 9: `upsertDeclarativeJob` passes through `expectedDurationSeconds`

**Files:**
- Modify: `src/scheduler/scheduler-service.ts`
- Modify: `tests/unit/scheduler/scheduler-service.test.ts`

- [ ] **Step 1: Write failing tests — add to the `upsertDeclarativeJob` describe block**

```typescript
it('writes expectedDurationSeconds when provided', async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ id: 'job-decl-1' }] });

  await svc.upsertDeclarativeJob('coordinator', {
    cron: '30 7 * * *',
    task: 'Send morning brief',
    expectedDurationSeconds: 60,
  });

  const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
  expect(sql).toContain('expected_duration_seconds');
  expect(params).toContain(60);
});

it('omits expected_duration_seconds when not provided (preserves existing DB value)', async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ id: 'job-decl-2' }] });

  await svc.upsertDeclarativeJob('coordinator', {
    cron: '0 9 * * 1',
    task: 'Weekly standup',
    // no expectedDurationSeconds
  });

  const [sql] = pool.query.mock.calls[0] as [string];
  // The SQL should NOT set expected_duration_seconds so existing DB value is preserved
  expect(sql).not.toContain('expected_duration_seconds');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test -- tests/unit/scheduler/scheduler-service.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Update `upsertDeclarativeJob` signature and body in `scheduler-service.ts` (around line 366)**

```typescript
  async upsertDeclarativeJob(
    agentId: string,
    schedule: { cron: string; task: string; expectedDurationSeconds?: number },
  ): Promise<string> {
    const taskPayload = { task: schedule.task };
    const nextRunAt = this.nextRunFromCron(schedule.cron);

    // Validate expectedDurationSeconds before persisting: must be a finite positive integer.
    // Invalid values (0, negative, NaN, Infinity, non-integer) are treated as absent so the
    // column retains its current value and the system default (10 min) applies via COALESCE.
    const rawDuration = schedule.expectedDurationSeconds;
    const validatedDuration =
      typeof rawDuration === 'number' &&
      Number.isFinite(rawDuration) &&
      Number.isInteger(rawDuration) &&
      rawDuration > 0
        ? rawDuration
        : undefined;
    const hasExpectedDuration = validatedDuration !== undefined;

    const sql = `
      INSERT INTO scheduled_jobs (agent_id, cron_expr, task_payload, status, next_run_at, created_by, timezone${hasExpectedDuration ? ', expected_duration_seconds' : ''})
      VALUES ($1, $2, $3, $4, $5, $6, $7${hasExpectedDuration ? ', $8' : ''})
      ON CONFLICT ON CONSTRAINT scheduled_jobs_declarative_uq
      DO UPDATE SET next_run_at = $5,
                    timezone = $7${hasExpectedDuration ? ',\n                    expected_duration_seconds = $8' : ''}
      RETURNING id
    `;
    const params: unknown[] = [
      agentId,
      schedule.cron,
      JSON.stringify(taskPayload),
      'pending',
      nextRunAt,
      'system',
      this.timezone,
    ];
    if (hasExpectedDuration) {
      params.push(validatedDuration);
    }

    const { rows } = await this.pool.query(sql, params);
    return (rows[0] as { id: string }).id;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test -- tests/unit/scheduler/scheduler-service.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scheduler-service.ts tests/unit/scheduler/scheduler-service.test.ts
git commit -m "feat: upsertDeclarativeJob passes expectedDurationSeconds to DB"
```

---

### Task 10: Startup sweep in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add `recoverStuckJobs()` call between `loadDeclarativeJobs` and `scheduler.start()` in `src/index.ts`**

Find this block (around line 564):
```typescript
  await scheduler.loadDeclarativeJobs(agentConfigs);
  scheduler.start();
  logger.info('Scheduler started');
```

Replace with:
```typescript
  await scheduler.loadDeclarativeJobs(agentConfigs);
  // Recover any jobs left stuck in 'running' from a prior crash before the
  // poll loop starts. This handles the "crash between claim and dispatch" failure mode.
  await scheduler.recoverStuckJobs();
  scheduler.start();
  logger.info('Scheduler started');
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 3: Run the full test suite**

```bash
npm run test
```
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: startup sweep for stuck jobs before scheduler start"
```

---

### Task 11: CHANGELOG and version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Add entry under `## [Unreleased]` → `### Added` in `CHANGELOG.md`**

```markdown
- **Scheduler stuck-job recovery** — startup sweep and 5-minute watchdog detect jobs stuck in `running` state beyond their timeout threshold and reset them to `pending`. Adds `run_started_at` (set on job claim, cleared on completion) and `expected_duration_seconds` (per-job timeout hint, sourced from YAML or job creation) columns to `scheduled_jobs`. Timeout formula: `min(expected × 7.5, expected + 60m)`. Recovery increments `consecutive_failures`; third consecutive recovery suspends the job. Emits `schedule.recovered` audit event per recovered job. Resolves silent failure mode observed 2026-04-07.
```

Also add under `### Changed`:
```markdown
- **Agent YAML `schedule` entries** — optional `expectedDurationSeconds` field added to the schedule entry type in `AgentYamlConfig`; used to set a per-job stuck-job recovery timeout.
```

- [ ] **Step 2: Bump version in `package.json` from `0.9.1` to `0.9.2` (patch — bug fix + small improvement)**

```json
"version": "0.9.2",
```

- [ ] **Step 3: Run the full test suite one final time**

```bash
npm run test
```
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md package.json
git commit -m "chore: changelog and version bump for scheduler resilience (0.9.2)"
```
