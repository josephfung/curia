# Scheduler Implementation Design

**Date:** 2026-03-29
**Spec:** [07-scheduler.md](../../specs/07-scheduler.md)
**Status:** Approved

---

## Overview

Implements the scheduler described in spec 07: a Postgres-backed job scheduler built into the main process. Supports cron and one-shot jobs, persistent multi-burst agent tasks, declarative schedules from agent YAML, runtime job creation via skills, and HTTP API management.

The scheduler registers as a `system` layer component — the same cross-cutting layer used by the audit logger. This is also the first feature to formally document the system layer, which has existed in the codebase since early phases but was missing from the architecture specs.

---

## Database Schema

Single migration: `008_create_scheduler.sql`

### `scheduled_jobs`

```sql
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

CREATE INDEX idx_scheduled_jobs_due
  ON scheduled_jobs (next_run_at)
  WHERE status IN ('pending', 'failed');
```

**Status values:** `pending`, `running`, `completed`, `failed`, `suspended`, `cancelled`

- `pending` — waiting for `next_run_at`
- `running` — currently executing (set atomically when claimed)
- `completed` — one-shot job finished successfully
- `failed` — last run failed (recurring jobs stay here temporarily, then reset to pending for next run)
- `suspended` — paused after 3 consecutive failures, requires manual resume
- `cancelled` — soft-deleted via API or skill (row preserved for audit)

**`created_by` values:** agent ID for runtime-created, `'system'` for YAML-declarative, `'api'` for HTTP-created.

The partial index on `next_run_at` ensures the scheduler loop query only scans eligible rows.

### `agent_tasks`

```sql
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

- `intent_anchor` — the original goal the agent re-reads every burst to stay on track
- `progress` — free-form JSONB updated each burst (e.g., `{"subtasks_completed": 7, "subtasks_total": 10}`)
- `error_budget` — lifetime budget for the task, separate from per-burst agent runtime budget
- `ON DELETE SET NULL` on FK so cancelling a job preserves the task record for audit history

---

## Bus Events & Permissions

Three new event types in the `schedule.*` namespace, all published by the `system` layer:

### `schedule.created`

Emitted when a job is created via any path (skill, YAML bootstrap, HTTP API).

```typescript
interface ScheduleCreatedPayload {
  jobId: string;
  agentId: string;
  cronExpr: string | null;
  runAt: string | null;         // ISO 8601
  taskPayload: Record<string, unknown>;
  createdBy: string;
}
```

### `schedule.fired`

Emitted when the scheduler loop claims and fires a due job.

```typescript
interface ScheduleFiredPayload {
  jobId: string;
  agentId: string;
  agentTaskId: string | null;   // set if this job has a linked agent_task
}
```

### `schedule.suspended`

Emitted when a job hits 3 consecutive failures and is auto-suspended.

```typescript
interface ScheduleSuspendedPayload {
  jobId: string;
  agentId: string;
  lastError: string;
  consecutiveFailures: number;
}
```

### Permissions update

In `src/bus/permissions.ts`:

- **system publish**: add `schedule.created`, `schedule.fired`, `schedule.suspended`
- **system subscribe**: add same (audit logger observes all schedule events)
- No other layer needs pub/sub for these — they are internal infrastructure events for the audit trail

The scheduler also publishes `agent.task` when firing a job, which the `system` layer already has permission to do.

---

## Scheduler Core

New module: `src/scheduler/scheduler.ts`

### Dependencies

- `pool` (Postgres) — job queries
- `bus` (EventBus) — publish `agent.task` and `schedule.*` events
- `logger` (pino)
- `schedulerService` (SchedulerService) — shared job management logic

### The Loop

- `start()` kicks off a `setInterval` at 30s
- Each tick calls `pollDueJobs()`:
  1. Query: `SELECT * FROM scheduled_jobs WHERE next_run_at <= now() AND status IN ('pending', 'failed') FOR UPDATE SKIP LOCKED`
  2. For each claimed job:
     - Set `status = 'running'` atomically (via the `FOR UPDATE` lock)
     - Publish `schedule.fired` event
     - If the job has a linked `agent_task`, load its `progress` and `intent_anchor` and inject them into the task payload
     - Publish `agent.task` to the bus with the job's `task_payload` (plus persistent task context if applicable)
     - Fire and move on — don't block waiting for the agent to finish
  3. If `consecutive_failures >= 3` after a failure: publish `schedule.suspended` event and publish a synthetic `agent.task` to the coordinator for user notification

### Job Completion Tracking

- The scheduler subscribes to `agent.response` and `agent.error` events
- Matches responses back to jobs via `parentEventId` chain (the `agent.task` carries the job ID in its metadata)
- On success: update `last_run_at`, calculate `next_run_at` from cron (or set `completed` for one-shot), reset `consecutive_failures`
- On error: increment `consecutive_failures`, set `last_error`
- If the job has a linked `agent_task`: update `progress` and `updated_at`

### Cron Parsing

Use the `cron-parser` library to calculate `next_run_at` from `cron_expr`. No cron daemon — just next-occurrence math.

### Startup Bootstrap

`loadDeclarativeJobs(agentConfigs)` reads the `schedule:` block from each agent YAML config and upserts into `scheduled_jobs` with `created_by = 'system'`. Upsert matches on `agent_id + cron_expr + task_payload` to avoid duplicates on process restart.

### Shutdown

`stop()` clears the interval. Called during graceful shutdown before the pool is closed.

---

## SchedulerService

New module: `src/scheduler/scheduler-service.ts`

Shared service class that encapsulates all job management logic. Used by:
- Scheduler skills (via `SkillContext`)
- HTTP API routes
- The scheduler loop itself

### Methods

- `createJob(params)` — insert `scheduled_jobs` row, optionally create linked `agent_tasks` row if `intentAnchor` is provided. Publishes `schedule.created`. Returns job ID (and task ID if applicable).
- `listJobs(filters?)` — query jobs with optional status/agent_id filters. Joins `agent_tasks` for progress info.
- `getJob(jobId)` — single job with full detail including linked task.
- `cancelJob(jobId)` — sets job `status = 'cancelled'`, linked task status to `cancelled`. Preserves rows for audit.
- `unsuspendJob(jobId)` — sets `status = 'pending'`, resets `consecutive_failures`, recalculates `next_run_at`.
- `updateJob(jobId, updates)` — partial update (cron_expr, run_at, task_payload). Cannot change agent_id or created_by.
- `upsertDeclarativeJob(agentId, schedule)` — for YAML bootstrap, matched on agent_id + cron_expr + task_payload.
- `completeJobRun(jobId, success, error?)` — called by the scheduler loop after tracking agent response/error.

---

## Skills

Three skills following the existing pattern (`skills/<name>/skill.json` + `handler.ts`):

### `scheduler-create`

- **Input:** `{ agent_id?, cron_expr?, run_at?, task, intent_anchor?, error_budget? }`
- `agent_id` defaults to the calling agent's own ID
- If `intent_anchor` is provided, creates both a `scheduled_jobs` row and a linked `agent_tasks` row (persistent task)
- If only `task` + `cron_expr` or `run_at`, creates just the job (simple cron/one-shot)
- Calls `SchedulerService.createJob()`
- Returns the job ID (and task ID if applicable)

### `scheduler-list`

- **Input:** `{ status?, agent_id? }` — both optional filters
- Returns array of jobs with status, next run time, last error, and linked task progress
- Calls `SchedulerService.listJobs()`

### `scheduler-cancel`

- **Input:** `{ job_id }`
- Calls `SchedulerService.cancelJob()`
- Returns confirmation

All three are available to any agent via `pinned_skills` in their YAML config.

---

## HTTP API Endpoints

Added to the existing `HttpAdapter`, following established REST patterns. All require bearer token auth.

### `GET /api/jobs`

- Query params: `?status=pending&agent_id=coordinator`
- Returns paginated job list with linked task info
- Calls `SchedulerService.listJobs()`

### `GET /api/jobs/:id`

- Returns single job with full detail including linked `agent_task`
- Calls `SchedulerService.getJob()`

### `POST /api/jobs`

- Body: `{ agent_id, cron_expr?, run_at?, task_payload, intent_anchor?, error_budget? }`
- Sets `created_by = 'api'`
- Calls `SchedulerService.createJob()`

### `PATCH /api/jobs/:id`

- Body: subset of `{ status, cron_expr, run_at, task_payload }`
- If `status` is `'pending'` and the job is currently `suspended`: routes to `SchedulerService.unsuspendJob()` (resets `consecutive_failures`, recalculates `next_run_at`)
- All other field updates route to `SchedulerService.updateJob()`
- Cannot change `agent_id` or `created_by` (immutable fields)

### `DELETE /api/jobs/:id`

- Soft delete via `SchedulerService.cancelJob()`
- Row stays for audit history

---

## Bootstrap & Shutdown Integration

Changes to `src/index.ts`:

### Startup sequence

The scheduler slots in after the agent registry is populated but before the CLI starts:

1. Construct `SchedulerService` (needs `pool`, `bus`, `logger`)
2. Construct `Scheduler` (needs `schedulerService`, `bus`, `pool`, `logger`)
3. Call `scheduler.loadDeclarativeJobs(agentConfigs)` — upserts YAML-declared schedules
4. Call `scheduler.start()` — begins the 30s poll loop
5. Pass `SchedulerService` into `ExecutionLayer` (so scheduler skills access it via `SkillContext`)
6. Pass `SchedulerService` into `HttpAdapter` (for `/api/jobs` routes)

### Shutdown

Added to the existing `shutdown()` function:
- `scheduler.stop()` before `pool.end()` — stops the interval so no new jobs are claimed while draining

### Agent YAML extension

The `AgentYamlConfig` type in the loader is extended to support the optional `schedule:` block:

```yaml
schedule:
  - cron: "0 9 * * 1"
    task: "Generate weekly expense summary"
```

Parsed at load time, fed to `loadDeclarativeJobs()` during bootstrap.

---

## Documentation Updates

### `docs/specs/00-overview.md`

- Update "four hard-separated layers" to five
- Add `system` layer to the architecture diagram as the cross-cutting layer
- Describe its role: infrastructure components (audit logger, scheduler) that need broad pub/sub access
- Update the bus security enforcement section to mention system layer's full access

### `docs/specs/07-scheduler.md`

- Add note that the scheduler registers as `system` layer
- Add the `schedule.*` event types
- Document the `SchedulerService` shared service pattern
- Document the coordinator notification path for suspended jobs

### `CLAUDE.md`

- Update Architecture section to list five layers, adding system
- Add Scheduler to the cross-cutting list

### Agent YAML files

- Add `scheduler-create`, `scheduler-list`, `scheduler-cancel` to `pinned_skills` for both `coordinator.yaml` and `research-analyst.yaml`

---

## Testing Strategy

- **Unit tests** for `SchedulerService` methods (create, cancel, unsuspend, list, upsert)
- **Unit tests** for cron next-occurrence calculation
- **Integration tests** for the scheduler loop (real Postgres, verify job claiming with `FOR UPDATE SKIP LOCKED`, verify status transitions)
- **Integration tests** for job completion tracking (fire a job, simulate agent response, verify status update)
- **Integration tests** for auto-suspend (3 consecutive failures triggers suspension + coordinator notification)
- **Skill handler tests** for all three scheduler skills
- **HTTP route tests** for all five endpoints
- **Bootstrap test** verifying declarative job upsert from agent YAML

---

## Dependencies

- `cron-parser` — lightweight cron expression parsing for next-occurrence calculation
- No other new dependencies
