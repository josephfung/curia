# Intent Drift Detection — Design Spec

**Issue:** josephfung/curia#199  
**Branch:** `feat/intent-drift`  
**Date:** 2026-04-10  
**Status:** Approved for implementation

---

## Problem

For persistent scheduled tasks, the job description (`task_payload`) can evolve over time — either because the CEO edits it, or because the agent itself schedules follow-on one-shot jobs with progressively different instructions. Left unchecked, this can silently move the agent far from the original mandate (`intent_anchor`). In unattended mode there is no human reviewing each burst, so a drifted task can run for many cycles before anyone notices.

---

## Goal

After each burst of a persistent task, compare the current `task_payload` (and `last_run_summary` when available) against the `intent_anchor` using an LLM-as-judge call. If the LLM determines the task has drifted with sufficient confidence, pause the job and notify the CEO.

**This is a hard pause, not advisory.** A drifted task does not run again until the CEO reviews and resumes it.

---

## What We're Comparing

| Side | Source | Notes |
|---|---|---|
| **Anchor** | `agent_tasks.intent_anchor` | Frozen at task creation. Never mutated. |
| **Current state** | `scheduled_jobs.task_payload` | May have evolved since creation. Primary drift signal. |
| **Supplemental** | `scheduled_jobs.last_run_summary` | Agent-written summary of last burst (via scheduler-report skill). Included when present; omitted silently when null. |

`task_payload` is the right primary comparison target — it represents what the task is currently being asked to do, which is what drifts. `last_run_summary` adds evidence about what the agent actually did vs. what it was supposed to do, which can catch drift that a payload change alone wouldn't surface (e.g. a sequence of one-shot jobs where each fires the next with a slightly modified payload).

Response content (`AgentResponseEvent.payload.content`) is **not** used — it reflects the agent's output (e.g. a list of links), not the task's intent or the agent's reasoning, and would produce false positives.

---

## Similarity Method: LLM-as-Judge

Embedding cosine similarity is not used. Semantic vector distance cannot reliably distinguish aligned-but-differently-worded tasks from genuinely drifted ones. An LLM-as-judge call provides the contextual reasoning required.

The judge prompt asks the LLM to return a structured JSON verdict:

```json
{
  "drifted": boolean,
  "reason": string,       // one sentence explaining why
  "confidence": "high" | "medium" | "low"
}
```

**LLM provider:** Same provider instance used by the coordinator (passed in at construction). This avoids a second API credential and keeps model costs predictable.

> **TODO:** When multi-model support is added to the codebase, the drift judge should be configurable to use a cheaper/faster model independently of the coordinator. Track in a future issue.

---

## Configuration

Added to `config/default.yaml` under `intentDrift:`:

```yaml
intentDrift:
  enabled: true
  checkEveryNBursts: 1        # how often to check (1 = every burst)
  minConfidenceToPause: high  # "high" | "medium" | "low"
```

`minConfidenceToPause` controls the pause gate:

| Value | Effect |
|---|---|
| `high` | Only pause on egregious, unambiguous deviations (recommended default) |
| `medium` | Pause on probable deviations; some false positives expected |
| `low` | Pause whenever any drift is detected regardless of LLM confidence |

Pause logic: `drifted === true AND confidence >= minConfidenceToPause`

where `low < medium < high`.

---

## Config Schema Update

`src/config.ts` must be updated to validate and expose the `intentDrift` block. The shape:

```typescript
interface IntentDriftConfig {
  enabled: boolean;
  checkEveryNBursts: number;       // must be >= 1
  minConfidenceToPause: 'high' | 'medium' | 'low';
}
```

---

## Architecture

### New file: `src/scheduler/drift-detector.ts`

```typescript
export type DriftConfidence = 'high' | 'medium' | 'low';

export interface DriftVerdict {
  drifted: boolean;
  reason: string;
  confidence: DriftConfidence;
}

export interface DriftCheckParams {
  intentAnchor: string;
  taskPayload: Record<string, unknown>;
  lastRunSummary?: string | null;
}

export class DriftDetector {
  constructor(
    private provider: LLMProvider,
    private config: IntentDriftConfig,
    private logger: Logger,
  ) {}

  /**
   * Ask the LLM whether the current task description has drifted from the original intent.
   * Returns null if the check should be skipped (disabled in config, or no meaningful input).
   */
  async check(params: DriftCheckParams): Promise<DriftVerdict | null>

  /** Returns true if the verdict meets the configured confidence threshold for pausing. */
  shouldPause(verdict: DriftVerdict): boolean
}
```

The `check()` method builds a system + user prompt, calls the LLM with `max_tokens: 200` and `temperature: 0`, and parses the JSON response. It treats any parse failure as a non-drift verdict (fail-open) and logs a warning.

The judge prompt structure:

```text
[system]
You are a task integrity auditor. Your job is to determine whether a scheduled
task has drifted significantly from its original mandate.

Respond ONLY with a JSON object in this exact format, no other text:
{"drifted": boolean, "reason": "one sentence", "confidence": "high"|"medium"|"low"}

[user]
## Original intent
{intentAnchor}

## Current task description
{JSON.stringify(taskPayload, null, 2)}

[if lastRunSummary present:]
## What the agent did on its last run
{lastRunSummary}

Has this task drifted significantly from its original intent?
```

### Modified: `src/scheduler/scheduler-service.ts`

New method `pauseJobForDrift(jobId: string): Promise<void>`:
- Sets `scheduled_jobs.status = 'paused'` in a single transaction
- Sets `agent_tasks.status = 'paused'` (via the `scheduled_job_id` FK)
- Updates `agent_tasks.updated_at`

### Modified: `src/bus/events.ts`

New event type `schedule.drift_paused`:

```typescript
export interface ScheduleDriftPausedEvent extends BaseEvent {
  type: 'schedule.drift_paused';
  sourceLayer: 'system';
  payload: {
    jobId: string;
    agentId: string;
    agentTaskId: string;
    intentAnchor: string;
    taskPayload: Record<string, unknown>;
    lastRunSummary: string | null;
    verdict: DriftVerdict;
  };
}
```

This event is published to the bus and caught by the `AuditLogger` automatically (all bus events are audit-logged). No explicit audit write needed.

### Modified: `src/scheduler/scheduler.ts`

**`handleCompletion` signature change:**

```typescript
private async handleCompletion(
  parentEventId: string,
  success: boolean,
  error?: string,
): Promise<void>
```

The `agent.response` subscriber is updated to also pass `job.intentAnchor` and `job.taskPayload` — but these are on the job, not the event. Instead, the job is looked up by `jobId` before the drift check (we already have `jobId` from `pendingJobs`).

**Drift check flow in `handleCompletion` (success path only):**

```text
1. Look up the job via schedulerService.getJob(jobId)
2. If job has agentTaskId AND intentAnchor AND driftDetector is configured:
   a. Call driftDetector.check({ intentAnchor, taskPayload, lastRunSummary })
   b. If null (skipped): proceed to completeJobRun()
   c. If verdict.drifted AND driftDetector.shouldPause(verdict):
      - Call schedulerService.pauseJobForDrift(jobId)
      - Publish schedule.drift_paused event
      - Send coordinator notification (same pattern as schedule.suspended)
      - return (do NOT call completeJobRun)
   d. Otherwise (drifted but below confidence threshold, or not drifted):
      - Log the verdict at info level
      - Proceed to completeJobRun()
```

**Coordinator notification message:**

```text
Task "[job.agentId]" has been paused because its current instructions may have 
drifted from its original goal.

Original intent: [intentAnchor]

Current task: [JSON.stringify(taskPayload)]

Reason: [verdict.reason] (confidence: [verdict.confidence])

Please review the task and either resume it with corrected instructions or cancel it.
```

### Modified: `src/index.ts`

Wire the `DriftDetector` using the coordinator's LLM provider and the loaded `intentDrift` config. Pass into `Scheduler` constructor.

If `intentDrift.enabled` is false, pass `undefined` — `Scheduler` skips the check when `driftDetector` is absent.

### Modified: `Scheduler` constructor

```typescript
export interface SchedulerConfig {
  pool: Pool;
  bus: EventBus;
  logger: Logger;
  schedulerService: SchedulerService;
  driftDetector?: DriftDetector;   // optional; check skipped when absent
}
```

---

## New DB Migration: `023_scheduler_drift_pause.sql`

Adds `paused` as a valid `last_run_outcome` to the existing CHECK constraint, and adds a partial index for the `paused` status so the API and watchdog can query paused jobs efficiently.

```sql
-- Partial index for paused jobs (API queries, watchdog exclusion)
CREATE INDEX idx_scheduled_jobs_paused
  ON scheduled_jobs (id)
  WHERE status = 'paused';
```

Note: `status` on `scheduled_jobs` and `agent_tasks` has no CHECK constraint, so adding `'paused'` requires no constraint change on those columns. `last_run_outcome` is **not** set to `'paused'` — on the drift-pause path, `completeJobRun()` is never called, so `last_run_outcome` retains its value from the previous run. The CHECK constraint extension is a forward-looking guard in case a future code path wants to record `'paused'` as an outcome.

---

## Failure Modes

| Scenario | Behavior |
|---|---|
| LLM call fails (timeout, API error) | Log warning, treat as no-drift, continue. Never abort a task due to a judge failure. |
| LLM returns malformed JSON | Log warning, treat as no-drift, continue. |
| `lastRunSummary` is null | Omit from prompt; proceed with `taskPayload` alone. |
| `intentDrift.enabled: false` | `DriftDetector` not constructed; no LLM calls made. |
| `checkEveryNBursts > 1` | Check only when `burstCount % checkEveryNBursts === 0`. `burstCount` is tracked in-memory on `Scheduler` per job (map `jobId → count`). Resets on process restart (acceptable — a missed check is not a security failure). |

---

## Test Plan

**Unit tests in `tests/unit/scheduler/drift-detector.test.ts`:**

- `check()` returns `null` when `enabled: false`
- `check()` with matching intent/payload → LLM returns `{ drifted: false }` → returns non-null non-drifted verdict
- `check()` with divergent intent/payload → LLM returns `{ drifted: true, confidence: "high" }` → returns drifted verdict
- `shouldPause()`: `{ drifted: true, confidence: "high" }` + `minConfidenceToPause: "high"` → `true`
- `shouldPause()`: `{ drifted: true, confidence: "medium" }` + `minConfidenceToPause: "high"` → `false`
- `shouldPause()`: `{ drifted: true, confidence: "low" }` + `minConfidenceToPause: "medium"` → `false`
- `shouldPause()`: `{ drifted: true, confidence: "medium" }` + `minConfidenceToPause: "low"` → `true`
- LLM returns malformed JSON → returns null (no-drift, fail-open)
- LLM call throws → returns null (no-drift, fail-open)

**Unit test additions in `tests/unit/scheduler/scheduler.test.ts`:**

- Successful burst on persistent task with matching intent → drift check runs, completeJobRun called
- Successful burst on persistent task with drifted payload (high confidence) → pauseJobForDrift called, schedule.drift_paused published, coordinator notified, completeJobRun NOT called
- Successful burst on persistent task with drifted payload (low confidence) + `minConfidenceToPause: high` → completeJobRun called (not paused)
- Drift check returns null (disabled) → completeJobRun called normally
- No `agentTaskId` on job → drift check skipped

---

## Acceptance Criteria (from issue)

- [x] Intent anchor stored with task on creation — already done
- [x] Intent anchor injected into agent system prompt on every burst — already done
- [ ] Drift check runs after each burst execution for persistent tasks
- [ ] `task_payload` (+ `last_run_summary` when available) compared against `intent_anchor` via LLM-as-judge
- [ ] Tasks with drift verdict at or above `minConfidenceToPause` are set to `status = 'paused'`
- [ ] CEO is notified via coordinator with task name, original intent, current task, and reason
- [ ] Drift event is audit-logged (via `schedule.drift_paused` bus event)
- [ ] In unattended mode, a paused task stays paused until human review
- [ ] Configuration in `config/default.yaml` for `enabled`, `checkEveryNBursts`, `minConfidenceToPause`
- [ ] Config schema validated in `src/config.ts`
- [ ] Unit tests: matching → continues; divergent → paused + notified; confidence gating works
