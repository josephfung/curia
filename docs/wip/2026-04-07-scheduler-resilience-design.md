# Scheduler Resilience: Stuck Job Recovery

**Date:** 2026-04-07
**Status:** Approved
**Issues:** josephfung/curia#206, josephfung/curia#207

## Problem

The Curia scheduler has no recovery mechanism for jobs stuck in `status = 'running'`. Two failure modes produce this state:

1. **Crash between claim and dispatch** — the scheduler sets `status = 'running'` then crashes before publishing the `agent.task` event. On restart, the job is invisible to the poll query (`WHERE status IN ('pending', 'failed')`) and never fires again.
2. **Agent task never completes** — the `agent.task` event is published but the agent crashes or hangs before publishing a response. The in-memory `pendingJobs` map is lost on restart; the job remains `running` forever.

In both cases the failure is silent: no error is logged, no notification is sent, and `last_run_at` is never written (it is only set on completion), so there is no way to determine how long the job has been stuck without a dedicated timestamp.

This was observed in production on 2026-04-07: the morning calendar job was stuck since 2026-04-05 and required a manual DB update to recover.

## Design

### Approach: Startup sweep + continuous watchdog

A single `recoverStuckJobs()` method is called in two places:

- **On startup** — awaited synchronously after `loadDeclarativeJobs()` and before `scheduler.start()`, so no jobs fire until orphaned state from a prior crash is cleaned up.
- **Watchdog loop** — a separate `setInterval` running every 5 minutes inside `scheduler.start()`, stopped in `scheduler.stop()`. Catches jobs that become stuck during a running session (e.g. agent hangs mid-task).

### Data model changes

New migration adds two columns to `scheduled_jobs`:

```sql
ALTER TABLE scheduled_jobs
  ADD COLUMN run_started_at     TIMESTAMPTZ,
  ADD COLUMN expected_duration_seconds INTEGER;
```

**`run_started_at`** — set to `now()` when `status` transitions to `'running'`, cleared to `NULL` on `completeJobRun()` (success or failure). This is the anchor for timeout calculation. Previously there was no way to know when a job entered the running state.

**`expected_duration_seconds`** — nullable. The expected wall-clock time for this job to complete. If `NULL`, the system-wide default of 600 seconds (10 minutes) applies via `COALESCE`. Set from YAML for declarative jobs (re-applied on each restart), set explicitly at creation time for dynamic jobs. Existing rows default to `NULL` (i.e. the 10-minute default) without requiring backfill.

### Timeout formula

```
timeout = min(expected_duration_seconds × 7.5, expected_duration_seconds + 3600)
```

This gives proportionally large headroom for short jobs while capping the maximum extension at +60 minutes for long jobs:

| Expected | Timeout |
|----------|---------|
| 1 min    | 7.5 min |
| 2 min    | 15 min  |
| 10 min   | 70 min  |
| 30 min   | 90 min  |
| 60 min   | 120 min |
| 120 min  | 180 min |

Both constants (7.5 multiplier, 3600s cap) are named module-level values in `scheduler.ts`, easy to tune.

### YAML format

Declarative jobs gain an optional `expectedDurationSeconds` field. The upsert path writes it to the DB column; missing field leaves the column at its current value (so manually-set durations are preserved across restarts).

```yaml
scheduler:
  jobs:
    - id: morning-calendar
      cron: "30 7 * * *"
      timezone: "America/Toronto"
      expectedDurationSeconds: 60
      task: "Send Joseph a daily email with his schedule..."
```

### Recovery logic (`recoverStuckJobs()`)

For each job where `status = 'running'` and `run_started_at < now() - timeout`:

1. **Increment `consecutive_failures`** — a stuck job is a failure. If this reaches the suspend threshold (3), the job is set to `'suspended'` instead of `'pending'`, and a `schedule.suspended` event is published. This prevents an unstable job from infinitely retrying.
2. **Reset `status`** — to `'pending'` (or `'suspended'` per above).
3. **Clear `run_started_at`** — set to `NULL`.
4. **Advance `next_run_at`** — for recurring jobs (has `cron_expr`): if the stored value is in the past, advance to the next valid cron fire time so the job doesn't attempt to catch up on missed slots. For one-shot jobs (no `cron_expr`): set `next_run_at = now()` so the job re-fires on the next poll immediately.
5. **Write `last_error`** — `'Job timed out after Xm (expected Ym) — auto-recovered'`.
6. **Publish `schedule.recovered`** — new discriminated union event, carries `jobId`, `agentId`, `runStartedAt`, `timeoutSeconds`. Written to audit log.
7. **Log `warn`** — one line per recovered job with structured fields.

All DB writes for a single job are wrapped in a transaction. If the transaction fails, the job is left in `'running'` state (safe — it will be retried on the next watchdog tick).

### Coordinator notification

Deferred. Notifying Nathan when a job is auto-recovered requires the `outbound.notification` event type (josephfung/curia#206), which is a prerequisite for any new direct-send paths. Tracked in josephfung/curia#207.

### `schedule.recovered` event shape

```typescript
{
  type: 'schedule.recovered';
  jobId: string;
  agentId: string;
  runStartedAt: string;       // ISO timestamp when job entered 'running'
  timeoutSeconds: number;     // computed threshold that was exceeded
  consecutiveFailures: number; // value after increment
  suspended: boolean;         // true if job was suspended rather than reset
}
```

## Testing

**Unit: `recoverStuckJobs()`**
- Jobs within threshold are not touched
- Jobs past threshold are reset: `status = 'pending'`, `run_started_at = NULL`, `consecutive_failures` incremented, `last_error` set
- Third consecutive failure suspends the job instead of resetting
- `schedule.recovered` event published for each recovered job
- `schedule.suspended` published when job reaches suspend threshold via recovery

**Unit: `fireJob()` changes**
- `run_started_at` is written when status transitions to `'running'`
- `run_started_at` is cleared by `completeJobRun()` on both success and failure paths

**Unit: YAML loading**
- `expectedDurationSeconds` from YAML is written to `expected_duration_seconds` column on upsert
- Missing field leaves column unchanged (not overwritten with NULL)
- Timeout formula produces correct values at boundary inputs

## Out of scope

- Coordinator notification on recovery (blocked by josephfung/curia#206)
- Persisting `pendingJobs` map to DB (would allow more precise "task was published but never responded" detection — deferred as a separate improvement)
- Per-job `recoveryTimeoutMultiplier` override (the formula constants are sufficient for now)
