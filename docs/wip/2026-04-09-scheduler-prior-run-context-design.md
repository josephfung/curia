# Scheduler: Prior Run Context

**Date:** 2026-04-09  
**Status:** Draft  
**Related spec:** [07-scheduler.md](../../specs/07-scheduler.md)  
**Motivated by:** Production incident where the daily schedule summary job failed because stale conversation history from a prior run caused the agent to attempt `scheduler-create` instead of executing the task.

---

## Problem

When the scheduler fires a job, it currently passes raw conversation history from prior runs into the new agent execution context. This means the agent doesn't start fresh — it starts mid-loop, continuing whatever reasoning chain was in progress during the last run.

This is wrong for two reasons:

1. **Raw history carries execution state, not just knowledge.** A prior run that died while attempting a self-registration loop will cause the next run to continue that loop, not execute the scheduled task.
2. **The agent has no way to distinguish "history from a prior run" from "current context."** It reads the turns as if it is already mid-task.

The correct mental model: scheduled jobs should receive **memory** (stable facts the next run genuinely needs), not **history** (the raw turn sequence from a previous execution).

This is complementary to intent anchoring. Intent anchoring prevents drift *within* a run. Prior run context prevents corrupt starting conditions *across* runs. Without both, an agent can know what it's supposed to do but still go wrong because it started from a bad state.

---

## Design

### New columns on `scheduled_jobs`

Three new columns, added via a single migration:

```sql
ALTER TABLE scheduled_jobs
  ADD COLUMN last_run_outcome     TEXT,
  ADD COLUMN last_run_summary     TEXT,
  ADD COLUMN last_run_context     JSONB;
```

**`last_run_outcome`** — enum-like text: `completed`, `failed`, `timed_out`. Written by the scheduler on job completion (success or failure) and by the stuck-job recovery sweep (writes `timed_out`). Queryable — the scheduler can filter or alert on outcome patterns. `NULL` means the job has never completed a run.

**`last_run_summary`** — free-text written by the *agent* at the end of its run. A human-readable one-sentence description of what it did: "Sent schedule for 6 events to joseph@josephfung.ca" or "No events found for today — nothing sent." This is what a human would want to see in an audit log or job status display.

**`last_run_context`** — JSONB blob written by the *agent* and read only by the *agent*. Opaque to the scheduler. Used for job-specific continuity state: cursors, watermarks, last-processed IDs, preferences learned from prior runs. The scheduler does not interpret this field — it just passes it through. The field is **overwritten** each run; it does not accumulate.

### The rule: columns vs. JSON

> If the scheduler needs to act on it → column.  
> If only the agent needs to read it → JSON blob.

`last_run_outcome` is a column because the scheduler may eventually alert, suppress, or vary retry behaviour based on it. `last_run_summary` is a column because it is surfaced in the health endpoint and API responses. `last_run_context` is JSONB because each job type needs different fields and the scheduler never queries inside it.

---

## How agents write prior-run context

Agents emit structured completion metadata via a new `scheduler-report` skill.

```typescript
// skill input
interface SchedulerReportInput {
  job_id: string;
  summary: string;                      // one sentence, human-readable
  context?: Record<string, unknown>;    // opaque — only the agent reads this next run
}
```

The skill writes `last_run_summary` and `last_run_context` on the `scheduled_jobs` row. `last_run_outcome` is always written by the scheduler itself — the agent doesn't set it.

Agents are not required to call this skill. If they don't:
- `last_run_summary` stays `NULL` — the job ran but left no summary
- `last_run_context` stays `NULL` — the next run starts with no agent-level context (fine for stateless jobs like the daily schedule email)

---

## How context is injected at the start of the next run

When the scheduler fires a job and the job has prior-run data, it injects a structured system message as the **first content** of the new execution context — before the task payload, before any conversation history.

```
[Prior run context — 2026-04-08 07:30 ET]
Outcome: completed
Summary: Sent schedule for 6 events to joseph@josephfung.ca
Agent context: {"events_sent": 6}
```

If the job has never run (`last_run_outcome IS NULL`), no prior-run block is injected — the agent starts completely fresh.

This is **not** conversation history. It is injected as a system-level context block, the same way the agent's persona, date/timezone, and autonomy score are injected. The agent reads it as stable facts about the world ("here's what happened last time"), not as a continuation of a prior conversation.

For persistent multi-burst tasks (using `agent_tasks`), the agent receives all of:
1. Prior-run context block (from `scheduled_jobs`)
2. Intent anchor (from `agent_tasks.intent_anchor`)
3. Current progress (from `agent_tasks.progress`)
4. Task payload

---

## Stopping raw history replay

The root cause of the production incident was `historyLength: 6` being passed into a fresh job run. The scheduler must stop passing raw conversation history when constructing the `agent.task` event for a scheduled job.

**Scheduled job executions always start with zero conversation history.** No prior turns are replayed. The only prior-run data the agent receives is the structured prior-run context block described above.

This is a targeted change to how `agent.task` events are constructed inside the scheduler loop — not a change to how interactive agent tasks work.

---

## Data model changes summary

### Migration (new file: `0XX_scheduler_prior_run_context.sql`)

```sql
ALTER TABLE scheduled_jobs
  ADD COLUMN last_run_outcome     TEXT
    CHECK (last_run_outcome IN ('completed', 'failed', 'timed_out')),
  ADD COLUMN last_run_summary     TEXT,
  ADD COLUMN last_run_context     JSONB;
```

No backfill needed. All three columns default to `NULL` for existing rows.

### Updates to `SchedulerService.completeJobRun()`

- Success path writes `last_run_outcome = 'completed'`
- Failure path writes `last_run_outcome = 'failed'`

### Updates to stuck-job recovery (`recoverStuckJobs()`)

- Recovered jobs write `last_run_outcome = 'timed_out'` (alongside existing `last_error` write)

### New `scheduler-report` skill

- **Input:** `{ job_id, summary, context? }`
- **Action risk:** `none` (writes internal state only, no external effect)
- Validates that `job_id` belongs to a job associated with the calling agent
- Writes `last_run_summary` and `last_run_context` on the row
- Returns `{ success: true }`

---

## Spec updates required

`docs/specs/07-scheduler.md` needs:
1. New columns added to the Job Model schema block
2. A new section "Prior Run Context" describing the injection mechanism and the no-history-replay rule
3. The `scheduler-report` skill listed in the Skills section
4. Note that scheduled jobs fire with no conversation history

---

## Testing

**Unit: `completeJobRun()`**
- Success path writes `last_run_outcome = 'completed'`
- Failure path writes `last_run_outcome = 'failed'`
- Neither path touches `last_run_summary` or `last_run_context` (agent-only fields)

**Unit: `recoverStuckJobs()`**
- Recovered jobs write `last_run_outcome = 'timed_out'`

**Unit: `scheduler-report` skill**
- Writes `last_run_summary` and `last_run_context` on the correct row
- Rejects a `job_id` that doesn't belong to the calling agent
- `context` field is optional — omitting it does not clear existing context

**Unit: scheduler loop — context injection**
- Job with `last_run_outcome = NULL`: no prior-run block in emitted `agent.task`
- Job with prior-run data: structured prior-run context block injected as first system message
- Emitted `agent.task` always has empty conversation history for scheduled jobs

**Integration: end-to-end**
- Fire job → agent calls `scheduler-report` → verify columns written
- Fire same job again → verify prior-run context block appears in agent's first turn
- Verify no raw conversation history is present in the injected context

---

## Out of scope

- UI display of `last_run_summary` in the web app — tracked in josephfung/curia#241
- Expiry of `last_run_context` — the field is overwritten each run, not accumulated; if an agent writes an excessively large blob that becomes a concern, a size check in the skill handler is the right fix
