# Scheduler Prior Run Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the production incident where scheduled jobs replay stale conversation history across runs, and add structured prior-run context so agents can start each run with the right information.

**Architecture:** Two interlinked fixes. (1) Change the `conversationId` in `fireJob()` to be unique per run so working memory never loads turns from a prior run. (2) Add three new DB columns (`last_run_outcome`, `last_run_summary`, `last_run_context`) so prior-run facts can be distilled and re-injected cleanly. A new `scheduler-report` skill lets agents write their summary and context at the end of each run.

**Tech Stack:** PostgreSQL (node-postgres), TypeScript/ESM, Vitest, existing `SchedulerService` + `Scheduler` pattern

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context`

---

## File Map

| Action | File | What changes |
|---|---|---|
| Create | `src/db/migrations/019_scheduler_prior_run_context.sql` | 3 new columns on `scheduled_jobs` |
| Modify | `src/scheduler/scheduler-service.ts` | `DbJobRow`, `JobRow`, `mapJobRow`, `completeJobRun`, `recoverStuckJob` |
| Modify | `src/scheduler/scheduler.ts` | `fireJob` — unique per-run conversationId + prior-run context injection |
| Create | `skills/scheduler-report/skill.json` | New skill manifest |
| Create | `skills/scheduler-report/handler.ts` | New skill handler |
| Modify | `tests/unit/scheduler/scheduler-service.test.ts` | Tests for new `last_run_outcome` writes |
| Modify | `tests/unit/scheduler/scheduler.test.ts` | Tests for prior-run injection + unique conversationId |
| Create | `tests/unit/skills/scheduler-report.test.ts` | Full skill handler test suite |

---

## Task 1: Migration

**Files:**
- Create: `src/db/migrations/019_scheduler_prior_run_context.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 019_scheduler_prior_run_context.sql
--
-- Adds three columns to support structured prior-run context for scheduled jobs.
-- last_run_outcome: written by the scheduler on completion/timeout (queryable).
-- last_run_summary: agent-written human-readable summary of what the job did.
-- last_run_context: agent-written opaque JSONB for job-specific continuity state.
--
-- All three default to NULL — no backfill needed. The no-history-replay fix
-- (unique per-run conversationId) is a code-only change; no schema change required.

ALTER TABLE scheduled_jobs
  ADD COLUMN last_run_outcome TEXT
    CHECK (last_run_outcome IN ('completed', 'failed', 'timed_out')),
  ADD COLUMN last_run_summary TEXT,
  ADD COLUMN last_run_context JSONB;
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  add src/db/migrations/019_scheduler_prior_run_context.sql
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  commit -m "chore: add migration 019 — scheduler prior run context columns"
```

---

## Task 2: Types — `DbJobRow`, `JobRow`, `mapJobRow`

**Files:**
- Modify: `src/scheduler/scheduler-service.ts`

- [ ] **Step 1: Add new fields to `DbJobRow` (internal snake_case)**

In `scheduler-service.ts`, find the `DbJobRow` interface (around line 58). Add three fields after `expected_duration_seconds`:

```typescript
  last_run_outcome: string | null;   // 'completed' | 'failed' | 'timed_out' | null
  last_run_summary: string | null;   // agent-written summary; null until first scheduler-report call
  last_run_context: Record<string, unknown> | null; // opaque agent context; null until first scheduler-report call
```

- [ ] **Step 2: Add new fields to `JobRow` (public camelCase)**

Find the `JobRow` interface (around line 28). Add after `expectedDurationSeconds`:

```typescript
  lastRunOutcome: string | null;
  lastRunSummary: string | null;
  lastRunContext: Record<string, unknown> | null;
```

- [ ] **Step 3: Update `mapJobRow` to include new fields**

Find the `mapJobRow` function at the bottom of the file. Add after `expectedDurationSeconds`:

```typescript
    lastRunOutcome: row.last_run_outcome,
    lastRunSummary: row.last_run_summary,
    lastRunContext: row.last_run_context,
```

- [ ] **Step 4: Run the tests to verify no regressions**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  test -- tests/unit/scheduler/scheduler-service.test.ts
```

Expected: all existing tests pass (the new fields are nullable and existing test data doesn't include them).

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  add src/scheduler/scheduler-service.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  commit -m "feat: add lastRunOutcome/Summary/Context fields to JobRow types"
```

---

## Task 3: `completeJobRun()` — write `last_run_outcome`

**Files:**
- Modify: `src/scheduler/scheduler-service.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/scheduler/scheduler-service.test.ts`, find the `completeJobRun` describe block and add:

```typescript
it('writes last_run_outcome = completed on success (recurring)', async () => {
  const jobId = 'job-complete-success';
  // First query: fetchSql — returns a recurring job
  pool.query.mockResolvedValueOnce({
    rows: [{ id: jobId, cron_expr: '0 9 * * *', status: 'running', consecutive_failures: 0, timezone: 'UTC' }],
  });
  // Second query: updateSql
  pool.query.mockResolvedValueOnce({ rows: [] });

  await svc.completeJobRun(jobId, true);

  const updateCall = pool.query.mock.calls[1];
  const sql: string = updateCall[0];
  const params: unknown[] = updateCall[1];
  expect(sql).toContain('last_run_outcome');
  expect(params).toContain('completed');
});

it('writes last_run_outcome = completed on success (one-shot)', async () => {
  const jobId = 'job-complete-oneshot';
  pool.query.mockResolvedValueOnce({
    rows: [{ id: jobId, cron_expr: null, status: 'running', consecutive_failures: 0, timezone: 'UTC' }],
  });
  pool.query.mockResolvedValueOnce({ rows: [] });

  await svc.completeJobRun(jobId, true);

  const updateCall = pool.query.mock.calls[1];
  const sql: string = updateCall[0];
  const params: unknown[] = updateCall[1];
  expect(sql).toContain('last_run_outcome');
  expect(params).toContain('completed');
});

it('writes last_run_outcome = failed on failure', async () => {
  const jobId = 'job-complete-fail';
  pool.query.mockResolvedValueOnce({
    rows: [{ id: jobId, cron_expr: '0 9 * * *', status: 'running', consecutive_failures: 0, timezone: 'UTC' }],
  });
  pool.query.mockResolvedValueOnce({ rows: [] });

  await svc.completeJobRun(jobId, false, 'something went wrong');

  const updateCall = pool.query.mock.calls[1];
  const sql: string = updateCall[0];
  const params: unknown[] = updateCall[1];
  expect(sql).toContain('last_run_outcome');
  expect(params).toContain('failed');
});

it('does not overwrite last_run_summary or last_run_context in completeJobRun', async () => {
  const jobId = 'job-no-overwrite';
  pool.query.mockResolvedValueOnce({
    rows: [{ id: jobId, cron_expr: null, status: 'running', consecutive_failures: 0, timezone: 'UTC' }],
  });
  pool.query.mockResolvedValueOnce({ rows: [] });

  await svc.completeJobRun(jobId, true);

  const updateCall = pool.query.mock.calls[1];
  const sql: string = updateCall[0];
  expect(sql).not.toContain('last_run_summary');
  expect(sql).not.toContain('last_run_context');
});
```

- [ ] **Step 2: Run to verify failures**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  test -- tests/unit/scheduler/scheduler-service.test.ts
```

Expected: the 4 new tests FAIL.

- [ ] **Step 3: Update `completeJobRun` success path (recurring)**

In the recurring job success branch (around line 445), change the SQL to include `last_run_outcome`:

```typescript
const updateSql = `
  UPDATE scheduled_jobs
     SET last_run_at = now(),
         next_run_at = $1,
         consecutive_failures = 0,
         last_error = NULL,
         run_started_at = NULL,
         status = $2,
         last_run_outcome = $4
   WHERE id = $3
`;
await this.pool.query(updateSql, [nextRunAt, 'pending', jobId, 'completed']);
```

- [ ] **Step 4: Update `completeJobRun` success path (one-shot)**

In the one-shot success branch, change:

```typescript
const updateSql = `
  UPDATE scheduled_jobs
     SET last_run_at = now(),
         status = $1,
         consecutive_failures = 0,
         last_error = NULL,
         run_started_at = NULL,
         last_run_outcome = $3
   WHERE id = $2
`;
await this.pool.query(updateSql, ['completed', jobId, 'completed']);
```

- [ ] **Step 5: Update `completeJobRun` failure path**

In the failure branch (around line 482), change:

```typescript
const updateSql = `
  UPDATE scheduled_jobs
     SET last_run_at = now(),
         consecutive_failures = $1,
         last_error = $2,
         run_started_at = NULL,
         status = $3,
         last_run_outcome = $5
   WHERE id = $4
`;
await this.pool.query(updateSql, [newFailures, error ?? null, newStatus, jobId, 'failed']);
```

- [ ] **Step 6: Run tests — should pass now**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  test -- tests/unit/scheduler/scheduler-service.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  add src/scheduler/scheduler-service.ts tests/unit/scheduler/scheduler-service.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  commit -m "feat: write last_run_outcome in completeJobRun"
```

---

## Task 4: `recoverStuckJob()` — write `last_run_outcome = 'timed_out'`

**Files:**
- Modify: `src/scheduler/scheduler-service.ts`

- [ ] **Step 1: Write the failing test**

In `tests/unit/scheduler/scheduler-service.test.ts`, find the `recoverStuckJob` describe block and add:

```typescript
it('writes last_run_outcome = timed_out on recovery', async () => {
  const jobId = 'job-stuck';
  pool.query
    .mockResolvedValueOnce({
      rows: [{ id: jobId, cron_expr: null, run_at: null, consecutive_failures: 0, timezone: 'UTC' }],
    })
    .mockResolvedValueOnce({ rowCount: 1, rows: [] });

  await svc.recoverStuckJob(jobId, 600);

  const updateCall = pool.query.mock.calls[1];
  const sql: string = updateCall[0];
  const params: unknown[] = updateCall[1];
  expect(sql).toContain('last_run_outcome');
  expect(params).toContain('timed_out');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  test -- tests/unit/scheduler/scheduler-service.test.ts
```

Expected: new test FAILS.

- [ ] **Step 3: Update `recoverStuckJob` SQL**

In `recoverStuckJob` (around line 545), change the UPDATE to include `last_run_outcome`:

```typescript
const result = await this.pool.query(
  `UPDATE scheduled_jobs
      SET status = $1,
          consecutive_failures = $2,
          last_error = $3,
          run_started_at = NULL,
          next_run_at = $4,
          last_run_outcome = $6
    WHERE id = $5
      AND status = 'running'`,
  [newStatus, newFailures, lastError, nextRunAt, jobId, 'timed_out'],
);
```

- [ ] **Step 4: Run tests — should pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  test -- tests/unit/scheduler/scheduler-service.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  add src/scheduler/scheduler-service.ts tests/unit/scheduler/scheduler-service.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  commit -m "feat: write last_run_outcome = timed_out in recoverStuckJob"
```

---

## Task 5: `fireJob()` — unique per-run conversationId + prior-run context injection

**Files:**
- Modify: `src/scheduler/scheduler.ts`

The root cause of the production incident: `fireJob()` always uses `conversationId: \`scheduler:${job.id}\``. Working memory loads history keyed on that ID, so stale turns from prior runs are replayed into the new run.

Fix: use `scheduler:<job-id>:<taskEventId>`. Each run gets a unique conversation ID, so working memory returns no history.

Additionally: when the job has `lastRunOutcome` set, prepend a prior-run context block to the `content` so the agent has structured facts about the last run without raw history.

**Note:** `JobRow` needs `lastRunOutcome`, `lastRunSummary`, `lastRunContext` available in `fireJob()`. The `pollDueJobs` query already does `SELECT sj.*` so new columns are included automatically — but the `JobRow` mapping in `pollDueJobs` (around line 152) must be updated to include the new fields.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/scheduler/scheduler.test.ts`, find the `fireJob` / `pollDueJobs` tests and add:

```typescript
it('uses a unique conversationId per run (not job ID)', async () => {
  const jobId = 'job-unique-conv';
  const firedEvent = { id: 'fired-evt-1' };
  const taskEvent = { id: 'task-evt-1' };

  pool.query
    .mockResolvedValueOnce({
      rows: [{
        id: jobId, agent_id: 'coordinator', cron_expr: '0 9 * * *',
        run_at: null, task_payload: { task: 'do work' }, status: 'pending',
        last_run_at: null, next_run_at: new Date(), last_error: null,
        consecutive_failures: 0, created_by: 'system', created_at: new Date(),
        timezone: 'UTC', agent_task_id: null, intent_anchor: null, progress: null,
        run_started_at: null, expected_duration_seconds: null,
        last_run_outcome: null, last_run_summary: null, last_run_context: null,
      }],
    })
    .mockResolvedValueOnce({ rowCount: 1 }); // claim update

  bus.publish.mockResolvedValue(undefined);
  bus.publish.mockImplementation((_layer: unknown, event: { id: string; type: string }) => {
    if (event.type === 'schedule.fired') Object.assign(firedEvent, event);
    if (event.type === 'agent.task') Object.assign(taskEvent, event);
    return Promise.resolve();
  });

  await scheduler.pollDueJobs();

  // The conversationId must NOT be just `scheduler:<jobId>`
  const taskPayload = (taskEvent as { payload?: { conversationId?: string } }).payload;
  expect(taskPayload?.conversationId).not.toBe(`scheduler:${jobId}`);
  expect(taskPayload?.conversationId).toMatch(new RegExp(`^scheduler:${jobId}:`));
});

it('injects prior-run context block when last_run_outcome is set', async () => {
  const jobId = 'job-prior-run';
  const taskEvent = { payload: { content: '' } };

  pool.query
    .mockResolvedValueOnce({
      rows: [{
        id: jobId, agent_id: 'coordinator', cron_expr: '0 9 * * *',
        run_at: null, task_payload: { task: 'do work' }, status: 'pending',
        last_run_at: new Date('2026-04-08T11:30:00Z'), next_run_at: new Date(),
        last_error: null, consecutive_failures: 0, created_by: 'system',
        created_at: new Date(), timezone: 'America/Toronto',
        agent_task_id: null, intent_anchor: null, progress: null,
        run_started_at: null, expected_duration_seconds: null,
        last_run_outcome: 'completed',
        last_run_summary: 'Sent schedule for 6 events to joseph@josephfung.ca',
        last_run_context: { events_sent: 6 },
      }],
    })
    .mockResolvedValueOnce({ rowCount: 1 });

  bus.publish.mockImplementation((_layer: unknown, event: { type: string; payload?: unknown }) => {
    if (event.type === 'agent.task') Object.assign(taskEvent, event);
    return Promise.resolve();
  });

  await scheduler.pollDueJobs();

  const content: string = (taskEvent as { payload: { content: string } }).payload.content;
  expect(content).toContain('[Prior run context');
  expect(content).toContain('completed');
  expect(content).toContain('Sent schedule for 6 events');
  expect(content).toContain('"events_sent": 6');
});

it('does not inject prior-run block when last_run_outcome is null (first run)', async () => {
  const jobId = 'job-first-run';
  const taskEvent = { payload: { content: '' } };

  pool.query
    .mockResolvedValueOnce({
      rows: [{
        id: jobId, agent_id: 'coordinator', cron_expr: '0 9 * * *',
        run_at: null, task_payload: { task: 'do work' }, status: 'pending',
        last_run_at: null, next_run_at: new Date(), last_error: null,
        consecutive_failures: 0, created_by: 'system', created_at: new Date(),
        timezone: 'UTC', agent_task_id: null, intent_anchor: null, progress: null,
        run_started_at: null, expected_duration_seconds: null,
        last_run_outcome: null, last_run_summary: null, last_run_context: null,
      }],
    })
    .mockResolvedValueOnce({ rowCount: 1 });

  bus.publish.mockImplementation((_layer: unknown, event: { type: string; payload?: unknown }) => {
    if (event.type === 'agent.task') Object.assign(taskEvent, event);
    return Promise.resolve();
  });

  await scheduler.pollDueJobs();

  const content: string = (taskEvent as { payload: { content: string } }).payload.content;
  expect(content).not.toContain('[Prior run context');
});
```

- [ ] **Step 2: Run to verify failures**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  test -- tests/unit/scheduler/scheduler.test.ts
```

Expected: the 3 new tests FAIL.

- [ ] **Step 3: Update `pollDueJobs` row mapping to include new fields**

In `pollDueJobs` (around line 152), add new fields to the `JobRow` mapping:

```typescript
const job: JobRow = {
  // ... existing fields ...
  runStartedAt: row.run_started_at ?? null,
  expectedDurationSeconds: row.expected_duration_seconds ?? null,
  // New prior-run context fields
  lastRunOutcome: row.last_run_outcome ?? null,
  lastRunSummary: row.last_run_summary ?? null,
  lastRunContext: row.last_run_context ?? null,
};
```

- [ ] **Step 4: Update `fireJob()` — unique conversationId**

In `fireJob()`, find the `createAgentTask` call (around line 237). Change the `conversationId` to include the task event ID for uniqueness:

```typescript
// Build the task event first so we can use its ID in the conversationId.
// Using a per-run conversationId (not just job ID) prevents working memory from
// loading turns from prior runs — each run starts with zero history.
const taskEvent = createAgentTask({
  agentId: job.agentId,
  // Include a unique suffix so working memory never loads history from a prior run.
  // Format: scheduler:<jobId>:<taskEventId>
  conversationId: `scheduler:${job.id}:${/* taskEvent.id not available yet — use randomUUID */}`,
  // ...
});
```

Wait — `createAgentTask` generates the event ID internally, so we can't reference it before calling the function. Use `randomUUID()` for the run suffix instead:

```typescript
import { randomUUID } from 'crypto';

// In fireJob():

// Unique per-run conversationId prevents working memory from replaying
// turns from prior runs. Format: scheduler:<jobId>:<runId>
const runId = randomUUID();
const conversationId = `scheduler:${job.id}:${runId}`;
```

Then use `conversationId` in the `createAgentTask` call.

- [ ] **Step 5: Update `fireJob()` — prior-run context injection**

Add a helper to build the prior-run block, then prepend it to `content`:

```typescript
/**
 * Build a structured prior-run context block from the job's last-run fields.
 * Returns null if the job has never run (lastRunOutcome is null).
 * Injected as a prefix to the task content so the agent sees it before the task.
 */
function buildPriorRunBlock(job: JobRow): string | null {
  if (!job.lastRunOutcome) return null;

  const lastRunAt = job.lastRunAt
    ? new Date(job.lastRunAt).toLocaleString('en-CA', { timeZone: job.timezone, dateStyle: 'short', timeStyle: 'short' })
    : 'unknown';

  const lines = [
    `[Prior run context — ${lastRunAt}]`,
    `Outcome: ${job.lastRunOutcome}`,
  ];

  if (job.lastRunSummary) {
    lines.push(`Summary: ${job.lastRunSummary}`);
  }

  if (job.lastRunContext) {
    lines.push(`Agent context: ${JSON.stringify(job.lastRunContext, null, 2)}`);
  }

  return lines.join('\n');
}
```

Then in `fireJob()`, prepend the block to `content`:

```typescript
// Inject prior-run context block before task content if the job has run before.
// This gives the agent stable facts about the last run without replaying raw history.
const priorRunBlock = buildPriorRunBlock(job);
if (priorRunBlock) {
  content = priorRunBlock + '\n\n---\n\n' + content;
}
```

- [ ] **Step 6: Run tests — should pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  test -- tests/unit/scheduler/scheduler.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  add src/scheduler/scheduler.ts tests/unit/scheduler/scheduler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  commit -m "feat: unique per-run conversationId and prior-run context injection in fireJob"
```

---

## Task 6: New `scheduler-report` skill

**Files:**
- Create: `skills/scheduler-report/skill.json`
- Create: `skills/scheduler-report/handler.ts`
- Create: `tests/unit/skills/scheduler-report.test.ts`

This skill lets agents write `last_run_summary` and `last_run_context` on the job row at the end of a run. The scheduler always writes `last_run_outcome` itself; this skill handles the agent-owned fields.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/skills/scheduler-report.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SchedulerReportHandler } from '../../../skills/scheduler-report/handler.js';
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

describe('SchedulerReportHandler', () => {
  const handler = new SchedulerReportHandler();

  it('returns failure when schedulerService is not available', async () => {
    const result = await handler.execute(makeCtx({ job_id: 'job-1', summary: 'done' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('schedulerService');
  });

  it('returns failure when job_id is missing', async () => {
    const schedulerService = { reportJobRun: vi.fn() };
    const result = await handler.execute(makeCtx(
      { summary: 'done' },
      { schedulerService: schedulerService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('job_id');
  });

  it('returns failure when summary is missing', async () => {
    const schedulerService = { reportJobRun: vi.fn() };
    const result = await handler.execute(makeCtx(
      { job_id: 'job-1' },
      { schedulerService: schedulerService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('summary');
  });

  it('calls reportJobRun with summary and no context when context is omitted', async () => {
    const schedulerService = { reportJobRun: vi.fn().mockResolvedValue(undefined) };
    const result = await handler.execute(makeCtx(
      { job_id: 'job-1', summary: 'Sent 6 events' },
      { schedulerService: schedulerService as never },
    ));
    expect(result.success).toBe(true);
    expect(schedulerService.reportJobRun).toHaveBeenCalledWith('job-1', 'Sent 6 events', undefined);
  });

  it('calls reportJobRun with summary and context', async () => {
    const schedulerService = { reportJobRun: vi.fn().mockResolvedValue(undefined) };
    const ctx = { events_sent: 6 };
    const result = await handler.execute(makeCtx(
      { job_id: 'job-1', summary: 'Sent 6 events', context: ctx },
      { schedulerService: schedulerService as never },
    ));
    expect(result.success).toBe(true);
    expect(schedulerService.reportJobRun).toHaveBeenCalledWith('job-1', 'Sent 6 events', ctx);
  });

  it('returns failure when reportJobRun throws', async () => {
    const schedulerService = {
      reportJobRun: vi.fn().mockRejectedValue(new Error('job not found')),
    };
    const result = await handler.execute(makeCtx(
      { job_id: 'job-1', summary: 'Sent 6 events' },
      { schedulerService: schedulerService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('job not found');
  });
});
```

- [ ] **Step 2: Run to verify failures (file doesn't exist yet)**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  test -- tests/unit/skills/scheduler-report.test.ts
```

Expected: import errors / test failures.

- [ ] **Step 3: Create `skills/scheduler-report/skill.json`**

```json
{
  "name": "scheduler-report",
  "description": "Write a summary and optional context for the current scheduled job run. Call this at the end of a successful scheduled task to record what was done and carry forward any state the next run needs.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "infrastructure": true,
  "inputs": {
    "job_id": "string",
    "summary": "string (one sentence describing what was done this run)",
    "context": "object? (optional — job-specific state for the next run, e.g. cursors, counts)"
  },
  "outputs": { "success": "boolean" },
  "permissions": [],
  "secrets": [],
  "timeout": 10000
}
```

- [ ] **Step 4: Create `skills/scheduler-report/handler.ts`**

```typescript
// handler.ts — scheduler-report skill implementation.
//
// Writes last_run_summary and last_run_context on the scheduled_jobs row at the
// end of a run. The scheduler writes last_run_outcome itself; this skill handles
// the agent-owned fields so agents can carry forward job-specific continuity state.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class SchedulerReportHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.schedulerService) {
      return {
        success: false,
        error: 'scheduler-report requires schedulerService in context. Is infrastructure: true set in the manifest?',
      };
    }

    const { job_id, summary, context } = ctx.input as {
      job_id?: string;
      summary?: string;
      context?: Record<string, unknown>;
    };

    if (!job_id || typeof job_id !== 'string') {
      return { success: false, error: 'Missing required input: job_id (string)' };
    }
    if (!summary || typeof summary !== 'string') {
      return { success: false, error: 'Missing required input: summary (string)' };
    }

    try {
      await ctx.schedulerService.reportJobRun(job_id, summary, context);
      ctx.log.info({ jobId: job_id }, 'scheduler-report written');
      return { success: true, data: { success: true } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'scheduler-report failed');
      return { success: false, error: message };
    }
  }
}
```

- [ ] **Step 5: Add `reportJobRun` to `SchedulerService`**

In `src/scheduler/scheduler-service.ts`, add this method after `completeJobRun`:

```typescript
/**
 * Write agent-owned prior-run context fields on the job row.
 * Called by the scheduler-report skill at the end of a successful run.
 * last_run_outcome is written by the scheduler itself — this only touches
 * the agent-controlled fields (summary and opaque context blob).
 */
async reportJobRun(
  jobId: string,
  summary: string,
  context?: Record<string, unknown>,
): Promise<void> {
  if (context !== undefined) {
    await this.pool.query(
      `UPDATE scheduled_jobs
          SET last_run_summary = $1,
              last_run_context = $2
        WHERE id = $3`,
      [summary, JSON.stringify(context), jobId],
    );
  } else {
    await this.pool.query(
      `UPDATE scheduled_jobs
          SET last_run_summary = $1
        WHERE id = $2`,
      [summary, jobId],
    );
  }
  this.logger.info({ jobId }, 'scheduler-report written');
}
```

- [ ] **Step 6: Run tests — should pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  test -- tests/unit/skills/scheduler-report.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  add skills/scheduler-report/ src/scheduler/scheduler-service.ts tests/unit/skills/scheduler-report.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  commit -m "feat: add scheduler-report skill and reportJobRun service method"
```

---

## Task 7: Full test run + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context test
```

Expected: all tests PASS with no failures.

- [ ] **Step 2: Update CHANGELOG.md**

Add under `## [Unreleased]`:

```markdown
### Added
- **Scheduler prior run context** — three new DB columns (`last_run_outcome`, `last_run_summary`, `last_run_context`) on `scheduled_jobs` give agents structured facts about prior runs without replaying raw conversation history (spec 07)
- **`scheduler-report` skill** — agents call this at the end of a scheduled run to write a summary and optional continuity context for the next run
- **Migration 019** — `last_run_outcome`, `last_run_summary`, `last_run_context` columns on `scheduled_jobs`

### Fixed
- **Scheduler history poisoning** — scheduled job runs now use a unique per-run `conversationId`, preventing working memory from loading turns from prior runs (root cause of 2026-04-09 production incident where the daily schedule job called `scheduler-create` instead of executing its task)

### Changed
- **`completeJobRun`** — now writes `last_run_outcome = 'completed'` or `'failed'` on completion
- **`recoverStuckJob`** — now writes `last_run_outcome = 'timed_out'` on recovery
```

- [ ] **Step 3: Bump version in `package.json`**

This is infrastructure adding new DB columns, a new skill, and a spec fix — patch bump per CLAUDE.md versioning table (completing a partially-shipped spec feature).

Read `package.json` to find current version, increment the patch digit by 1.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  add CHANGELOG.md package.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-scheduler-prior-run-context \
  commit -m "chore: changelog and version bump for scheduler prior run context"
```

---

## Self-Review

**Spec coverage check:**

| Design requirement | Covered by |
|---|---|
| `last_run_outcome` column, written by scheduler | Task 1 (migration), Task 3 (completeJobRun), Task 4 (recoverStuckJob) |
| `last_run_summary` column, written by agent | Task 1 (migration), Task 6 (reportJobRun + skill) |
| `last_run_context` column, written by agent | Task 1 (migration), Task 6 (reportJobRun + skill) |
| No conversation history on scheduled runs | Task 5 (unique conversationId) |
| Prior-run block injected when `last_run_outcome` set | Task 5 (buildPriorRunBlock) |
| No prior-run block on first run | Task 5 (null check) |
| `scheduler-report` skill with `action_risk: none` | Task 6 |
| `context` optional — omitting does not clear existing context | Task 6 (two-branch SQL in `reportJobRun`) |
| Spec 07 updated | Already done in design phase |
| UI issue filed | josephfung/curia#241 (already done) |

**Placeholder scan:** No TBD, TODO, or "similar to" references. All SQL and code is explicit.

**Type consistency:** `reportJobRun` is called from the handler with `(job_id, summary, context?)` and defined in `SchedulerService` with the same signature. `JobRow.lastRunOutcome/Summary/Context` match `DbJobRow.last_run_outcome/summary/context` via `mapJobRow`.
