# 07 — Scheduler

## Overview

Built into the main process, backed by Postgres. Handles both user-defined recurring jobs (cron) and agent-created one-shot or recurring tasks.

**Layer:** System (same as audit logger — full pub/sub access)

**Bus events:** `schedule.created`, `schedule.fired`, `schedule.suspended`

**Shared service:** `SchedulerService` handles all job CRUD — consumed by scheduler loop, agent skills, and HTTP API routes.

**Suspension notifications:** Routed through the coordinator as synthetic `agent.task` events — no dedicated notification subsystem.

---

## Job Model

```sql
CREATE TABLE scheduled_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      TEXT NOT NULL,
  cron_expr     TEXT,
  run_at        TIMESTAMPTZ,
  task_payload  JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ,
  last_error    TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  timezone      TEXT NOT NULL DEFAULT 'UTC',

  -- Prior run context (see Prior Run Context section below)
  last_run_outcome  TEXT CHECK (last_run_outcome IN ('completed', 'failed', 'timed_out')),
  last_run_summary  TEXT,
  last_run_context  JSONB
);

CHECK (cron_expr IS NOT NULL OR run_at IS NOT NULL)
```

---

## Timezone Handling

Curia's Docker container runs with no `TZ` environment variable, so the Node process always executes in UTC. Cron expressions must be interpreted in Curia's configured timezone (`config.timezone`, default `America/Toronto`) or a per-job override — not in UTC — so that `"0 8 * * *"` fires at 8am local time, not 8am UTC.

### How it works

- **System default**: `SchedulerService` is constructed with `config.timezone`. All `nextRunFromCron()` calls pass this as the `{ tz }` option to `cron-parser` unless overridden at the job level.
- **Per-job override**: Each job stores its own timezone in the `scheduled_jobs.timezone` column (migration 012). The `scheduler-create` skill accepts an optional `timezone` input; if omitted, the service default is used.
- **One-shot jobs (`run_at`)**: The `run_at` value is always stored as a UTC timestamp. The execution layer normalizes any offset-less ISO string submitted by the LLM to UTC before the handler sees it, so `run_at` is already correct regardless of timezone.
- **Recurring jobs on completion**: When `completeJobRun()` advances `next_run_at` for a recurring job, it reads the job's own `timezone` column and passes it to `nextRunFromCron()`. This ensures DST transitions are handled correctly (e.g., a job scheduled for 8am stays at 8am local time after clocks change).

### Per-job timezone via the skill

```
scheduler.create({
  cron_expr: "0 8 * * *",
  task: "Send daily briefing",
  timezone: "America/Vancouver"   // overrides Curia's default (America/Toronto)
})
```

If `timezone` is omitted, the job inherits Curia's configured system timezone.

### Why not rely on the host TZ env var?

The Docker container does not set `TZ`. Even if it did, relying on a host-level environment variable makes per-job timezone overrides impossible and couples the scheduler behaviour to deployment configuration. Explicit `{ tz }` options in `cron-parser` are more predictable and testable.

---

**Status values:** `pending`, `running`, `completed`, `failed`, `suspended`

- `pending` — waiting for next_run_at
- `running` — currently executing (set atomically when claimed)
- `completed` — one-shot job finished successfully
- `failed` — last run failed (recurring jobs stay in this state temporarily, then reset to pending for next run)
- `suspended` — paused after 3 consecutive failures, requires manual resume

---

## Scheduler Loop

The scheduler runs inside the main process and checks for due jobs every 30 seconds:

1. Query: `SELECT * FROM scheduled_jobs WHERE next_run_at <= now() AND status IN ('pending', 'failed') FOR UPDATE SKIP LOCKED`
2. For each due job:
   - Set `status = 'running'` (atomically via the FOR UPDATE lock)
   - Publish `agent.task` to the bus with the job's `task_payload`
   - On success: update `last_run_at`, calculate `next_run_at` from cron_expr (or set `status = 'completed'` for one-shot), reset `consecutive_failures = 0`
   - On failure: increment `consecutive_failures`, set `last_error`, if >= 3 set `status = 'suspended'` and notify user

The `FOR UPDATE SKIP LOCKED` pattern ensures that if the scheduler loop overlaps (e.g., a job takes longer than 30s), the same job isn't claimed twice.

---

## Persistent Tasks

Long-running agent work uses the scheduler for burst execution:

```sql
CREATE TABLE agent_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL,
  intent_anchor   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  progress        JSONB NOT NULL DEFAULT '{}',
  error_budget    JSONB NOT NULL,
  conversation_id UUID,
  scheduled_job_id UUID REFERENCES scheduled_jobs(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

When an agent creates a persistent task:
1. A `scheduled_jobs` row is created with the next_run_at time
2. An `agent_tasks` row links to it, carrying the intent anchor and progress state
3. On each burst: scheduler fires → agent loads task state from `agent_tasks` + working memory → does work → updates progress → sets next_run_at

The agent doesn't stay running between bursts. State lives entirely in Postgres.

---

## Prior Run Context

Scheduled jobs should receive **memory** (stable facts the next run needs), not **history** (the raw turn sequence from a prior execution). Raw history carries execution state — if a prior run died mid-loop, replaying those turns causes the next run to continue the bad loop rather than execute the task fresh.

### No conversation history on scheduled job runs

When the scheduler fires a job, the emitted `agent.task` event carries no conversation history. The agent always starts from zero turns. This is distinct from interactive agent tasks, which do carry conversation context.

### How prior-run context is injected

If the job has prior-run data (`last_run_outcome IS NOT NULL`), the scheduler injects a structured system message as the first content of the new execution — before the task payload, alongside the agent's persona and date/timezone context:

```
[Prior run context — 2026-04-08 07:30 ET]
Outcome: completed
Summary: Sent schedule for 6 events to joseph@josephfung.ca
Agent context: {"events_sent": 6}
```

If the job has never run, no prior-run block is injected.

### What gets written and by whom

| Field | Written by | When |
|---|---|---|
| `last_run_outcome` | Scheduler | On `completeJobRun()` success/failure; stuck-job recovery writes `timed_out` |
| `last_run_summary` | Agent (via `scheduler-report` skill) | At the end of a successful run |
| `last_run_context` | Agent (via `scheduler-report` skill) | At the end of a successful run |

Agents are not required to call `scheduler-report`. Stateless jobs (e.g. a daily email that simply reads the calendar and sends) can skip it — `last_run_context` stays `NULL` and the next run starts with only the outcome/summary from the scheduler.

---

## Creating Scheduled Jobs

### From Agent Config (declarative)

```yaml
schedule:
  - cron: "0 9 * * 1"
    task: "Generate weekly expense summary"
  - cron: "0 */4 * * *"
    task: "Check inbox for new receipts"
```

These are created at startup from the agent's YAML config.

### From Agents at Runtime (via skill)

Agents can create jobs dynamically using the built-in `scheduler` skill:

```
scheduler.create({
  agent_id: "research-analyst",
  cron_expr: "0 9 * * *",
  task: "Continue competitor research — check for new press releases"
})
```

### From CLI / HTTP API

Users can manage jobs directly:
- `POST /api/jobs` — create a job
- `GET /api/jobs` — list all jobs
- `PATCH /api/jobs/:id` — update (e.g., unsuspend)
- `DELETE /api/jobs/:id` — cancel

---

## Skills

Four skills available to agents:

- **`scheduler-create`** — create a cron or one-shot job, optionally with a linked persistent task (`intent_anchor`)
- **`scheduler-list`** — list jobs with optional status/agent_id filters
- **`scheduler-cancel`** — cancel a job by ID
- **`scheduler-report`** — write prior-run context at the end of a run. Input: `{ job_id, summary, context? }`. Action risk: `none`. The scheduler writes `last_run_outcome` itself; this skill writes `last_run_summary` and `last_run_context`.

---

## Job Observability

- All job executions are audit-logged (start, success, failure, suspension)
- The health endpoint includes: number of active jobs, number of suspended jobs, next due job time
- Suspended jobs generate a user notification via the configured alert channel
