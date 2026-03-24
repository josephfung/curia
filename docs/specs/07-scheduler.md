# 07 — Scheduler

## Overview

Built into the main process, backed by Postgres. Handles both user-defined recurring jobs (cron) and agent-created one-shot or recurring tasks.

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
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CHECK (cron_expr IS NOT NULL OR run_at IS NOT NULL)
```

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

## Job Observability

- All job executions are audit-logged (start, success, failure, suspension)
- The health endpoint includes: number of active jobs, number of suspended jobs, next due job time
- Suspended jobs generate a user notification via the configured alert channel
