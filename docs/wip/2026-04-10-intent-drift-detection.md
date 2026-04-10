# Intent Drift Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After each successful burst of a persistent scheduled task, call an LLM judge to compare `task_payload` against `intent_anchor` and pause the job (notifying the CEO) if drift is detected with sufficient confidence.

**Architecture:** A new `DriftDetector` class handles the LLM-as-judge call and confidence gating. `SchedulerService` gets a `pauseJobForDrift()` method. `Scheduler.handleCompletion()` runs the check on the success path for persistent tasks (those with an `agentTaskId`) and either proceeds to `completeJobRun()` or pauses. The audit trail is automatic — the `schedule.drift_paused` bus event is caught by the existing `AuditLogger`.

**Tech Stack:** TypeScript ESM, Vitest, node-postgres (`pg`), existing `LLMProvider` interface (`src/agents/llm/provider.ts`).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/scheduler/drift-detector.ts` | **Create** | LLM judge call + confidence gating |
| `tests/unit/scheduler/drift-detector.test.ts` | **Create** | Unit tests for DriftDetector |
| `src/db/migrations/023_scheduler_drift_pause.sql` | **Create** | Partial index for `status = 'paused'` |
| `docs/adr/015-llm-as-judge-intent-drift.md` | **Create** | ADR for LLM-as-judge over embedding similarity |
| `docs/adr/README.md` | **Modify** | Add ADR 015 to index |
| `docs/wip/2026-04-10-intent-drift-detection-design.md` | **Create** | Move spec from wrong location |
| `src/bus/events.ts` | **Modify** | Add `ScheduleDriftPausedEvent` type + `createScheduleDriftPaused()` factory + union entry |
| `src/bus/permissions.ts` | **Modify** | Add `schedule.drift_paused` to `system` publish set |
| `src/scheduler/scheduler-service.ts` | **Modify** | Add `pauseJobForDrift()` method |
| `src/scheduler/scheduler.ts` | **Modify** | Add `driftDetector?` to config, burst counter map, drift check in `handleCompletion` |
| `src/config.ts` | **Modify** | Add `intentDrift?` to `YamlConfig`, add validation |
| `config/default.yaml` | **Modify** | Add `intentDrift:` block |
| `src/index.ts` | **Modify** | Wire `DriftDetector` into `Scheduler` |
| `tests/unit/scheduler/scheduler.test.ts` | **Modify** | Add drift detection `describe` block |
| `tests/unit/scheduler/scheduler-service.test.ts` | **Modify** | Add `pauseJobForDrift` tests |
| `CHANGELOG.md` | **Modify** | Add entry under `[Unreleased]` |
| `package.json` | **Modify** | Patch bump `0.16.2` → `0.16.3` |

---

## Task 1: DB Migration

**Files:**
- Create: `src/db/migrations/023_scheduler_drift_pause.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 023_scheduler_drift_pause.sql
--
-- Adds a partial index for the 'paused' status on scheduled_jobs.
-- This supports efficient API queries for paused jobs and watchdog exclusion.
--
-- No constraint changes are needed:
--   - scheduled_jobs.status is TEXT with no CHECK constraint
--   - agent_tasks.status is TEXT with no CHECK constraint
--   - last_run_outcome is NOT set to 'paused' on the drift path (completeJobRun
--     is skipped, so last_run_outcome retains its prior value)

-- Up Migration
CREATE INDEX idx_scheduled_jobs_paused
  ON scheduled_jobs (id)
  WHERE status = 'paused';

-- Down Migration
-- DROP INDEX IF EXISTS idx_scheduled_jobs_paused;
```

- [ ] **Step 2: Commit**

```bash
git add src/db/migrations/023_scheduler_drift_pause.sql
git commit -m "chore: add migration 023 for drift-paused partial index"
```

---

## Task 2: Bus Event Type

**Files:**
- Modify: `src/bus/events.ts`
- Modify: `src/bus/permissions.ts`

- [ ] **Step 1: Add the payload interface, event interface, and factory to `events.ts`**

After the `ScheduleRecoveredEvent` block (around line 448), add:

```typescript
interface ScheduleDriftPausedPayload {
  jobId: string;
  agentId: string;
  agentTaskId: string;
  intentAnchor: string;
  taskPayload: Record<string, unknown>;
  lastRunSummary: string | null;
  verdict: {
    drifted: boolean;
    reason: string;
    confidence: 'high' | 'medium' | 'low';
  };
}

export interface ScheduleDriftPausedEvent extends BaseEvent {
  type: 'schedule.drift_paused';
  sourceLayer: 'system';
  payload: ScheduleDriftPausedPayload;
}
```

Add to the `BusEvent` union (after `| ScheduleRecoveredEvent`):

```typescript
  | ScheduleDriftPausedEvent  // Scheduler: job paused due to intent drift detection
```

Add the factory function (after `createScheduleRecovered`):

```typescript
export function createScheduleDriftPaused(
  payload: ScheduleDriftPausedPayload & { parentEventId?: string },
): ScheduleDriftPausedEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'schedule.drift_paused',
    sourceLayer: 'system',
    payload: rest,
    parentEventId,
  };
}
```

- [ ] **Step 2: Add `schedule.drift_paused` to the `system` publish set in `permissions.ts`**

Find the line in `permissions.ts` that lists all `system`-publishable event types and append `'schedule.drift_paused'` to it. It looks like:

```typescript
system: new Set(['inbound.message', 'agent.task', ..., 'secret.accessed']),
```

Change to:

```typescript
system: new Set(['inbound.message', 'agent.task', ..., 'secret.accessed', 'schedule.drift_paused']),
```

There are two such sets (publish permissions and subscribe permissions) — add `'schedule.drift_paused'` to both.

Also update the hardcoded permission sets in test files. Search for the same `system: new Set([...` pattern across the test tree and add `'schedule.drift_paused'` there too:

```bash
grep -rn "schedule.recovered" /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift/tests/ --include="*.ts"
```

Add `'schedule.drift_paused'` to every matching line found.

- [ ] **Step 3: Run the TypeScript compiler to verify no type errors**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift run build 2>&1 | tail -20
```

Expected: no errors referencing `events.ts` or `permissions.ts`.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift add src/bus/events.ts src/bus/permissions.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift commit -m "feat: add schedule.drift_paused event type and bus permissions"
```

---

## Task 3: DriftDetector — Tests First

**Files:**
- Create: `tests/unit/scheduler/drift-detector.test.ts`
- Create: `src/scheduler/drift-detector.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/scheduler/drift-detector.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriftDetector } from '../../../src/scheduler/drift-detector.js';
import type { DriftConfig } from '../../../src/scheduler/drift-detector.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';

function mockProvider(): LLMProvider {
  return {
    id: 'mock',
    chat: vi.fn(),
  };
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

const defaultConfig: DriftConfig = {
  enabled: true,
  checkEveryNBursts: 1,
  minConfidenceToPause: 'high',
};

const params = {
  intentAnchor: 'Research articles about AI safety and summarise findings weekly.',
  taskPayload: { skill: 'web-search', query: 'AI safety research 2025' },
  lastRunSummary: null,
};

describe('DriftDetector', () => {
  let provider: ReturnType<typeof mockProvider>;
  let logger: ReturnType<typeof mockLogger>;

  beforeEach(() => {
    provider = mockProvider();
    logger = mockLogger();
  });

  describe('check()', () => {
    it('returns null when enabled is false', async () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, enabled: false }, logger);
      const result = await detector.check(params);
      expect(result).toBeNull();
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it('returns the verdict when LLM says no drift', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockResolvedValueOnce({
        type: 'text',
        content: '{"drifted":false,"reason":"Task is aligned with original intent.","confidence":"high"}',
        usage: { inputTokens: 100, outputTokens: 20 },
      });

      const result = await detector.check(params);

      expect(result).toEqual({ drifted: false, reason: 'Task is aligned with original intent.', confidence: 'high' });
    });

    it('returns the verdict when LLM says drift detected', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockResolvedValueOnce({
        type: 'text',
        content: '{"drifted":true,"reason":"Task shifted from research to writing marketing copy.","confidence":"high"}',
        usage: { inputTokens: 100, outputTokens: 20 },
      });

      const result = await detector.check(params);

      expect(result).toEqual({
        drifted: true,
        reason: 'Task shifted from writing research to writing marketing copy.',
        confidence: 'high',
      });
    });

    it('includes lastRunSummary in the prompt when provided', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockResolvedValueOnce({
        type: 'text',
        content: '{"drifted":false,"reason":"Aligned.","confidence":"high"}',
        usage: { inputTokens: 150, outputTokens: 20 },
      });

      await detector.check({ ...params, lastRunSummary: 'Searched for AI safety papers, found 5 results.' });

      const call = vi.mocked(provider.chat).mock.calls[0]![0];
      const userMessage = call.messages.find((m) => m.role === 'user')!;
      expect(userMessage.content).toContain('What the agent did on its last run');
      expect(userMessage.content).toContain('Searched for AI safety papers');
    });

    it('omits lastRunSummary section when null', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockResolvedValueOnce({
        type: 'text',
        content: '{"drifted":false,"reason":"Aligned.","confidence":"high"}',
        usage: { inputTokens: 100, outputTokens: 20 },
      });

      await detector.check({ ...params, lastRunSummary: null });

      const call = vi.mocked(provider.chat).mock.calls[0]![0];
      const userMessage = call.messages.find((m) => m.role === 'user')!;
      expect(userMessage.content).not.toContain('What the agent did on its last run');
    });

    it('returns null and logs warning when LLM returns malformed JSON', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockResolvedValueOnce({
        type: 'text',
        content: 'Sorry, I cannot evaluate this.',
        usage: { inputTokens: 100, outputTokens: 10 },
      });

      const result = await detector.check(params);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ raw: 'Sorry, I cannot evaluate this.' }),
        expect.stringContaining('malformed'),
      );
    });

    it('returns null and logs warning when LLM call throws', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockRejectedValueOnce(new Error('API timeout'));

      const result = await detector.check(params);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('drift check failed'),
      );
    });

    it('returns null and logs warning when LLM returns an error response', async () => {
      const detector = new DriftDetector(provider, defaultConfig, logger);
      vi.mocked(provider.chat).mockResolvedValueOnce({
        type: 'error',
        error: { type: 'provider_error', message: 'rate limited', retryable: true, source: 'llm', context: {} },
      });

      const result = await detector.check(params);

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('shouldPause()', () => {
    it('returns true when drifted=true and confidence matches minConfidenceToPause', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'high' }, logger);
      expect(detector.shouldPause({ drifted: true, reason: 'x', confidence: 'high' })).toBe(true);
    });

    it('returns false when drifted=false regardless of confidence', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'low' }, logger);
      expect(detector.shouldPause({ drifted: false, reason: 'x', confidence: 'high' })).toBe(false);
    });

    it('returns false when confidence is below minConfidenceToPause (high threshold, medium confidence)', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'high' }, logger);
      expect(detector.shouldPause({ drifted: true, reason: 'x', confidence: 'medium' })).toBe(false);
    });

    it('returns false when confidence is below minConfidenceToPause (medium threshold, low confidence)', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'medium' }, logger);
      expect(detector.shouldPause({ drifted: true, reason: 'x', confidence: 'low' })).toBe(false);
    });

    it('returns true when confidence meets minConfidenceToPause (medium threshold, medium confidence)', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'medium' }, logger);
      expect(detector.shouldPause({ drifted: true, reason: 'x', confidence: 'medium' })).toBe(true);
    });

    it('returns true when confidence exceeds minConfidenceToPause (medium threshold, high confidence)', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'medium' }, logger);
      expect(detector.shouldPause({ drifted: true, reason: 'x', confidence: 'high' })).toBe(true);
    });

    it('returns true for any drift when minConfidenceToPause is low', () => {
      const detector = new DriftDetector(provider, { ...defaultConfig, minConfidenceToPause: 'low' }, logger);
      expect(detector.shouldPause({ drifted: true, reason: 'x', confidence: 'low' })).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift test tests/unit/scheduler/drift-detector.test.ts 2>&1 | tail -20
```

Expected: fail with `Cannot find module '../../../src/scheduler/drift-detector.js'`.

- [ ] **Step 3: Implement `src/scheduler/drift-detector.ts`**

```typescript
// drift-detector.ts — LLM-as-judge check for persistent task intent drift.
//
// After each burst of a persistent scheduled task, the Scheduler calls check()
// with the task's intent_anchor, current task_payload, and optional last_run_summary.
// The LLM returns a structured verdict. shouldPause() applies the configured
// confidence threshold to decide whether the task should be paused.
//
// Failure modes are all fail-open: any LLM error, timeout, or malformed response
// is treated as "no drift" so the task continues. The failure is logged at warn.
//
// TODO: When multi-model support is added, make the LLM provider here independently
// configurable from the coordinator's provider (cheaper/faster model for this check).

import type { LLMProvider } from '../agents/llm/provider.js';
import type { Logger } from '../logger.js';

export type DriftConfidence = 'high' | 'medium' | 'low';

export interface DriftVerdict {
  drifted: boolean;
  reason: string;
  confidence: DriftConfidence;
}

export interface DriftConfig {
  enabled: boolean;
  /** Run the check every N bursts. 1 = every burst (default). */
  checkEveryNBursts: number;
  /** Minimum LLM confidence required to trigger a pause. */
  minConfidenceToPause: DriftConfidence;
}

export interface DriftCheckParams {
  intentAnchor: string;
  taskPayload: Record<string, unknown>;
  lastRunSummary?: string | null;
}

// Confidence levels ordered from lowest to highest for threshold comparison.
const CONFIDENCE_ORDER: Record<DriftConfidence, number> = { low: 0, medium: 1, high: 2 };

export class DriftDetector {
  constructor(
    private readonly provider: LLMProvider,
    private readonly config: DriftConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Ask the LLM whether the current task has drifted from the original intent.
   * Returns null if the check is skipped (disabled config) or if the LLM call fails.
   * Returns the verdict otherwise.
   */
  async check(params: DriftCheckParams): Promise<DriftVerdict | null> {
    if (!this.config.enabled) return null;

    const { intentAnchor, taskPayload, lastRunSummary } = params;

    const userLines = [
      '## Original intent',
      intentAnchor,
      '',
      '## Current task description',
      JSON.stringify(taskPayload, null, 2),
    ];

    if (lastRunSummary) {
      userLines.push('', '## What the agent did on its last run', lastRunSummary);
    }

    userLines.push('', 'Has this task drifted significantly from its original intent?');

    const systemPrompt =
      'You are a task integrity auditor. Your job is to determine whether a scheduled ' +
      'task has drifted significantly from its original mandate.\n\n' +
      'Respond ONLY with a JSON object in this exact format, no other text:\n' +
      '{"drifted": boolean, "reason": "one sentence", "confidence": "high"|"medium"|"low"}';

    let raw: string;
    try {
      const response = await this.provider.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userLines.join('\n') },
        ],
        options: { max_tokens: 200, temperature: 0 },
      });

      if (response.type === 'error') {
        this.logger.warn(
          { err: response.error, provider: this.provider.id },
          'drift-detector: drift check failed — LLM returned error response; treating as no-drift',
        );
        return null;
      }

      if (response.type !== 'text') {
        this.logger.warn(
          { responseType: response.type },
          'drift-detector: drift check failed — unexpected non-text LLM response; treating as no-drift',
        );
        return null;
      }

      raw = response.content.trim();
    } catch (err) {
      this.logger.warn(
        { err, provider: this.provider.id },
        'drift-detector: drift check failed — LLM call threw; treating as no-drift',
      );
      return null;
    }

    // Parse and validate the JSON verdict.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(
        { raw },
        'drift-detector: LLM returned malformed JSON verdict; treating as no-drift',
      );
      return null;
    }

    if (!isValidVerdict(parsed)) {
      this.logger.warn(
        { raw },
        'drift-detector: LLM returned invalid verdict shape; treating as no-drift',
      );
      return null;
    }

    return parsed;
  }

  /**
   * Returns true if the verdict indicates drift AND the confidence meets
   * the configured minimum threshold for triggering a pause.
   */
  shouldPause(verdict: DriftVerdict): boolean {
    if (!verdict.drifted) return false;
    return CONFIDENCE_ORDER[verdict.confidence] >= CONFIDENCE_ORDER[this.config.minConfidenceToPause];
  }
}

function isValidVerdict(value: unknown): value is DriftVerdict {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['drifted'] === 'boolean' &&
    typeof v['reason'] === 'string' &&
    (v['confidence'] === 'high' || v['confidence'] === 'medium' || v['confidence'] === 'low')
  );
}
```

- [ ] **Step 4: Run the tests — they should pass now**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift test tests/unit/scheduler/drift-detector.test.ts 2>&1 | tail -30
```

Expected: all tests pass. The "Task shifted from research to writing marketing copy" test may fail because the mock returns a different `reason` string than what the test asserts — adjust the assertion to match whatever the mock returns, not the input string. The test is validating round-trip deserialization, so assert `result?.reason` equals the exact string in the mocked JSON response.

Fix the test assertion:
```typescript
expect(result).toEqual({
  drifted: true,
  reason: 'Task shifted from writing research to writing marketing copy.',
  confidence: 'high',
});
```
should be:
```typescript
expect(result).toEqual({
  drifted: true,
  reason: 'Task shifted from research to writing marketing copy.',
  confidence: 'high',
});
```
(Match the exact string in the `content` field of the mock.)

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift add src/scheduler/drift-detector.ts tests/unit/scheduler/drift-detector.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift commit -m "feat: add DriftDetector (LLM-as-judge, confidence gating)"
```

---

## Task 4: SchedulerService — `pauseJobForDrift()`

**Files:**
- Modify: `src/scheduler/scheduler-service.ts`
- Modify: `tests/unit/scheduler/scheduler-service.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/unit/scheduler/scheduler-service.test.ts`, add a new `describe` block after the existing `cancelJob` tests:

```typescript
describe('pauseJobForDrift', () => {
  it('sets scheduled_jobs.status to paused and agent_tasks.status to paused', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await svc.pauseJobForDrift('job-drift-1');

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'paused'");
    expect(sql).toContain('scheduled_jobs');
    expect(sql).toContain('agent_tasks');
    expect(params).toContain('job-drift-1');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift test tests/unit/scheduler/scheduler-service.test.ts 2>&1 | tail -20
```

Expected: fail with `svc.pauseJobForDrift is not a function`.

- [ ] **Step 3: Implement `pauseJobForDrift` in `scheduler-service.ts`**

Add the method to the `SchedulerService` class. Place it near the `cancelJob` method for logical grouping:

```typescript
/**
 * Pause a job and its linked agent_task due to intent drift detection.
 * Sets status = 'paused' on both tables in a single query.
 * The CEO must review and resume or cancel the job manually.
 */
async pauseJobForDrift(jobId: string): Promise<void> {
  // Update both tables atomically: pause the job and its linked agent_task.
  // Uses a CTE so both updates happen in one round-trip and stay consistent.
  await this.pool.query(
    `WITH paused_job AS (
       UPDATE scheduled_jobs
          SET status = 'paused'
        WHERE id = $1
     )
     UPDATE agent_tasks
        SET status     = 'paused',
            updated_at = now()
      WHERE scheduled_job_id = $1`,
    [jobId],
  );

  this.logger.info({ jobId }, 'Job paused due to intent drift detection');
}
```

- [ ] **Step 4: Run the test — it should pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift test tests/unit/scheduler/scheduler-service.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift add src/scheduler/scheduler-service.ts tests/unit/scheduler/scheduler-service.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift commit -m "feat: add SchedulerService.pauseJobForDrift()"
```

---

## Task 5: Scheduler — Drift Check in `handleCompletion`

**Files:**
- Modify: `src/scheduler/scheduler.ts`
- Modify: `tests/unit/scheduler/scheduler.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/scheduler/scheduler.test.ts`, add a new `describe('drift detection', ...)` block. First, update `mockSchedulerService()` to include the new method:

```typescript
function mockSchedulerService() {
  return {
    completeJobRun: vi.fn(),
    upsertDeclarativeJob: vi.fn(),
    getJob: vi.fn(),
    nextRunFromCron: vi.fn(),
    recoverStuckJob: vi.fn(),
    pauseJobForDrift: vi.fn(),   // ADD THIS
  };
}
```

Add a `mockDriftDetector()` helper:

```typescript
function mockDriftDetector() {
  return {
    check: vi.fn(),
    shouldPause: vi.fn(),
  };
}
```

Add the `describe` block. Note: `Scheduler` takes an optional `driftDetector` in its config — the tests below create a separate scheduler instance with the mock injected:

```typescript
describe('drift detection in handleCompletion', () => {
  let driftScheduler: Scheduler;
  let driftPool: ReturnType<typeof mockPool>;
  let driftBus: ReturnType<typeof mockBus>;
  let driftLogger: ReturnType<typeof mockLogger>;
  let driftSchedulerService: ReturnType<typeof mockSchedulerService>;
  let driftDetector: ReturnType<typeof mockDriftDetector>;

  // A job row that looks like a persistent task (has agentTaskId + intentAnchor)
  const persistentRow = fakeDbRow({
    agent_task_id: 'task-99',
    intent_anchor: 'Research AI safety articles weekly.',
    task_payload: { skill: 'web-search', query: 'AI safety' },
    last_run_summary: 'Found 5 articles on AI safety.',
  });

  beforeEach(() => {
    driftPool = mockPool();
    driftBus = mockBus();
    driftLogger = mockLogger();
    driftSchedulerService = mockSchedulerService();
    driftDetector = mockDriftDetector();

    driftScheduler = new Scheduler({
      pool: driftPool,
      bus: driftBus,
      logger: driftLogger,
      schedulerService: driftSchedulerService,
      driftDetector,
    });
  });

  afterEach(() => {
    driftScheduler.stop();
  });

  it('runs drift check and calls completeJobRun when no drift detected', async () => {
    // Fire the job to populate pendingJobs
    driftPool.query.mockResolvedValueOnce({ rows: [persistentRow] });
    driftPool.query.mockResolvedValueOnce({ rows: [] });
    await driftScheduler.pollDueJobs();
    const [, taskEvent] = driftBus.publish.mock.calls[1] as [string, { id: string }];

    // Mock drift check: no drift
    driftSchedulerService.getJob.mockResolvedValueOnce({
      id: 'job-1',
      agentId: 'agent-1',
      agentTaskId: 'task-99',
      intentAnchor: 'Research AI safety articles weekly.',
      taskPayload: { skill: 'web-search', query: 'AI safety' },
      lastRunSummary: 'Found 5 articles on AI safety.',
    });
    driftDetector.check.mockResolvedValueOnce({ drifted: false, reason: 'Aligned.', confidence: 'high' });
    driftDetector.shouldPause.mockReturnValueOnce(false);
    driftSchedulerService.completeJobRun.mockResolvedValueOnce({ suspended: false });

    driftScheduler.start();
    const responseHandler = driftBus.subscribe.mock.calls[0]?.[2] as (event: unknown) => Promise<void>;
    await responseHandler({
      id: 'resp-drift-1',
      type: 'agent.response',
      sourceLayer: 'agent',
      parentEventId: taskEvent.id,
      timestamp: new Date(),
      payload: { agentId: 'agent-1', conversationId: 'c1', content: 'Here are the articles.' },
    });

    expect(driftDetector.check).toHaveBeenCalledWith({
      intentAnchor: 'Research AI safety articles weekly.',
      taskPayload: { skill: 'web-search', query: 'AI safety' },
      lastRunSummary: 'Found 5 articles on AI safety.',
    });
    expect(driftSchedulerService.pauseJobForDrift).not.toHaveBeenCalled();
    expect(driftSchedulerService.completeJobRun).toHaveBeenCalledWith('job-1', true, undefined);
  });

  it('pauses job, publishes drift event, notifies coordinator, and skips completeJobRun when drift detected', async () => {
    driftPool.query.mockResolvedValueOnce({ rows: [persistentRow] });
    driftPool.query.mockResolvedValueOnce({ rows: [] });
    await driftScheduler.pollDueJobs();
    const [, taskEvent] = driftBus.publish.mock.calls[1] as [string, { id: string }];

    const driftVerdict = { drifted: true, reason: 'Task shifted to writing marketing copy.', confidence: 'high' as const };
    driftSchedulerService.getJob.mockResolvedValueOnce({
      id: 'job-1',
      agentId: 'agent-1',
      agentTaskId: 'task-99',
      intentAnchor: 'Research AI safety articles weekly.',
      taskPayload: { skill: 'web-search', query: 'AI safety' },
      lastRunSummary: 'Found 5 articles on AI safety.',
    });
    driftDetector.check.mockResolvedValueOnce(driftVerdict);
    driftDetector.shouldPause.mockReturnValueOnce(true);
    driftSchedulerService.pauseJobForDrift.mockResolvedValueOnce(undefined);

    driftScheduler.start();
    const responseHandler = driftBus.subscribe.mock.calls[0]?.[2] as (event: unknown) => Promise<void>;
    await responseHandler({
      id: 'resp-drift-2',
      type: 'agent.response',
      sourceLayer: 'agent',
      parentEventId: taskEvent.id,
      timestamp: new Date(),
      payload: { agentId: 'agent-1', conversationId: 'c1', content: 'Here is your marketing copy.' },
    });

    // pauseJobForDrift called
    expect(driftSchedulerService.pauseJobForDrift).toHaveBeenCalledWith('job-1');

    // schedule.drift_paused published
    const publishedTypes = (driftBus.publish.mock.calls as [string, { type: string }][])
      .map(([, ev]) => ev.type);
    expect(publishedTypes).toContain('schedule.drift_paused');

    // Coordinator notification published (agent.task to 'coordinator')
    const notifyCall = (driftBus.publish.mock.calls as [string, { type: string; payload: { agentId: string } }][])
      .find(([, ev]) => ev.type === 'agent.task' && ev.payload.agentId === 'coordinator');
    expect(notifyCall).toBeDefined();

    // completeJobRun NOT called
    expect(driftSchedulerService.completeJobRun).not.toHaveBeenCalled();
  });

  it('calls completeJobRun when drift detected but below confidence threshold', async () => {
    driftPool.query.mockResolvedValueOnce({ rows: [persistentRow] });
    driftPool.query.mockResolvedValueOnce({ rows: [] });
    await driftScheduler.pollDueJobs();
    const [, taskEvent] = driftBus.publish.mock.calls[1] as [string, { id: string }];

    driftSchedulerService.getJob.mockResolvedValueOnce({
      id: 'job-1',
      agentId: 'agent-1',
      agentTaskId: 'task-99',
      intentAnchor: 'Research AI safety articles weekly.',
      taskPayload: { skill: 'web-search', query: 'AI safety' },
      lastRunSummary: null,
    });
    driftDetector.check.mockResolvedValueOnce({ drifted: true, reason: 'Possibly drifted.', confidence: 'low' });
    driftDetector.shouldPause.mockReturnValueOnce(false);  // below threshold
    driftSchedulerService.completeJobRun.mockResolvedValueOnce({ suspended: false });

    driftScheduler.start();
    const responseHandler = driftBus.subscribe.mock.calls[0]?.[2] as (event: unknown) => Promise<void>;
    await responseHandler({
      id: 'resp-drift-3',
      type: 'agent.response',
      sourceLayer: 'agent',
      parentEventId: taskEvent.id,
      timestamp: new Date(),
      payload: { agentId: 'agent-1', conversationId: 'c1', content: 'done' },
    });

    expect(driftSchedulerService.pauseJobForDrift).not.toHaveBeenCalled();
    expect(driftSchedulerService.completeJobRun).toHaveBeenCalledWith('job-1', true, undefined);
  });

  it('calls completeJobRun normally when drift check returns null (skipped)', async () => {
    driftPool.query.mockResolvedValueOnce({ rows: [persistentRow] });
    driftPool.query.mockResolvedValueOnce({ rows: [] });
    await driftScheduler.pollDueJobs();
    const [, taskEvent] = driftBus.publish.mock.calls[1] as [string, { id: string }];

    driftSchedulerService.getJob.mockResolvedValueOnce({
      id: 'job-1',
      agentId: 'agent-1',
      agentTaskId: 'task-99',
      intentAnchor: 'Research AI safety articles weekly.',
      taskPayload: { skill: 'web-search', query: 'AI safety' },
      lastRunSummary: null,
    });
    driftDetector.check.mockResolvedValueOnce(null);  // disabled/skipped
    driftSchedulerService.completeJobRun.mockResolvedValueOnce({ suspended: false });

    driftScheduler.start();
    const responseHandler = driftBus.subscribe.mock.calls[0]?.[2] as (event: unknown) => Promise<void>;
    await responseHandler({
      id: 'resp-drift-4',
      type: 'agent.response',
      sourceLayer: 'agent',
      parentEventId: taskEvent.id,
      timestamp: new Date(),
      payload: { agentId: 'agent-1', conversationId: 'c1', content: 'done' },
    });

    expect(driftSchedulerService.pauseJobForDrift).not.toHaveBeenCalled();
    expect(driftSchedulerService.completeJobRun).toHaveBeenCalledWith('job-1', true, undefined);
  });

  it('skips drift check for jobs without agentTaskId', async () => {
    // Non-persistent job (no agent_task_id)
    const simpleRow = fakeDbRow({ agent_task_id: null, intent_anchor: null });
    driftPool.query.mockResolvedValueOnce({ rows: [simpleRow] });
    driftPool.query.mockResolvedValueOnce({ rows: [] });
    await driftScheduler.pollDueJobs();
    const [, taskEvent] = driftBus.publish.mock.calls[1] as [string, { id: string }];

    driftSchedulerService.getJob.mockResolvedValueOnce({
      id: 'job-1',
      agentId: 'agent-1',
      agentTaskId: null,
      intentAnchor: null,
      taskPayload: { skill: 'morning-brief' },
      lastRunSummary: null,
    });
    driftSchedulerService.completeJobRun.mockResolvedValueOnce({ suspended: false });

    driftScheduler.start();
    const responseHandler = driftBus.subscribe.mock.calls[0]?.[2] as (event: unknown) => Promise<void>;
    await responseHandler({
      id: 'resp-drift-5',
      type: 'agent.response',
      sourceLayer: 'agent',
      parentEventId: taskEvent.id,
      timestamp: new Date(),
      payload: { agentId: 'agent-1', conversationId: 'c1', content: 'done' },
    });

    expect(driftDetector.check).not.toHaveBeenCalled();
    expect(driftSchedulerService.completeJobRun).toHaveBeenCalledWith('job-1', true, undefined);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift test tests/unit/scheduler/scheduler.test.ts 2>&1 | tail -20
```

Expected: TypeScript compile errors about `driftDetector` not being a valid `SchedulerConfig` field.

- [ ] **Step 3: Update `SchedulerConfig` and wire drift check into `scheduler.ts`**

**3a. Update imports at the top of `scheduler.ts`:**

```typescript
import { DriftDetector } from './drift-detector.js';
import type { DriftDetector as DriftDetectorType } from './drift-detector.js';
import {
  createScheduleFired,
  createScheduleSuspended,
  createScheduleRecovered,
  createScheduleDriftPaused,
  createAgentTask,
} from '../bus/events.js';
```

(Replace the `DriftDetector` import with a single value import since we only need it as a type in the config interface; we use it as a value when calling methods.)

Actually, simplify to:
```typescript
import { DriftDetector } from './drift-detector.js';
import {
  createScheduleFired,
  createScheduleSuspended,
  createScheduleRecovered,
  createScheduleDriftPaused,
  createAgentTask,
} from '../bus/events.js';
```

**3b. Update `SchedulerConfig`:**

```typescript
export interface SchedulerConfig {
  pool: Pool;
  bus: EventBus;
  logger: Logger;
  schedulerService: SchedulerService;
  /** Optional drift detector — when absent, the drift check is skipped entirely. */
  driftDetector?: DriftDetector;
}
```

**3c. Update the `Scheduler` class to store `driftDetector` and a burst counter map:**

```typescript
export class Scheduler {
  private pool: Pool;
  private bus: EventBus;
  private logger: Logger;
  private schedulerService: SchedulerService;
  private driftDetector?: DriftDetector;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private watchdogHandle: ReturnType<typeof setInterval> | null = null;
  private pendingJobs = new Map<string, string>();
  // Tracks burst counts per job for checkEveryNBursts support.
  // In-memory only — resets on process restart (a missed check is not a security failure).
  private burstCounts = new Map<string, number>();

  constructor(config: SchedulerConfig) {
    this.pool = config.pool;
    this.bus = config.bus;
    this.logger = config.logger;
    this.schedulerService = config.schedulerService;
    this.driftDetector = config.driftDetector;
  }
  // ... rest of the class
```

**3d. Update `handleCompletion` to run the drift check on the success path.**

Find the existing `handleCompletion` method. The relevant part is the success path (when `success === true` and we'd normally call `completeJobRun`). Add the drift check block **before** calling `completeJobRun`:

```typescript
private async handleCompletion(
  parentEventId: string,
  success: boolean,
  error?: string,
): Promise<void> {
  const jobId = this.pendingJobs.get(parentEventId);
  if (!jobId) return;

  this.pendingJobs.delete(parentEventId);

  try {
    // Run the drift check on the success path for persistent tasks only.
    // Skip on the failure path — the error handling flow takes over.
    if (success && this.driftDetector) {
      const job = await this.schedulerService.getJob(jobId);

      if (job?.agentTaskId && job.intentAnchor) {
        // Enforce checkEveryNBursts: only check on the Nth burst.
        const burstCount = (this.burstCounts.get(jobId) ?? 0) + 1;
        this.burstCounts.set(jobId, burstCount);

        const shouldCheck = burstCount % this.driftDetector['config'].checkEveryNBursts === 0;

        if (shouldCheck) {
          const verdict = await this.driftDetector.check({
            intentAnchor: job.intentAnchor,
            taskPayload: job.taskPayload,
            lastRunSummary: job.lastRunSummary ?? null,
          });

          if (verdict !== null) {
            this.logger.info(
              { jobId, agentTaskId: job.agentTaskId, drifted: verdict.drifted, confidence: verdict.confidence, reason: verdict.reason },
              'drift-detector: verdict',
            );

            if (this.driftDetector.shouldPause(verdict)) {
              // Hard pause: set status to paused, publish the drift event, notify CEO.
              await this.schedulerService.pauseJobForDrift(jobId);

              const driftEvent = createScheduleDriftPaused({
                jobId,
                agentId: job.agentId,
                agentTaskId: job.agentTaskId,
                intentAnchor: job.intentAnchor,
                taskPayload: job.taskPayload,
                lastRunSummary: job.lastRunSummary ?? null,
                verdict,
                parentEventId,
              });
              await this.bus.publish('system', driftEvent);

              // Notify the CEO via the coordinator (same pattern as schedule.suspended).
              const notifyContent = [
                `Task has been paused because its current instructions may have drifted from its original goal.`,
                ``,
                `Original intent: ${job.intentAnchor}`,
                ``,
                `Current task: ${JSON.stringify(job.taskPayload)}`,
                ``,
                `Reason: ${verdict.reason} (confidence: ${verdict.confidence})`,
                ``,
                `Please review the task and either resume it with corrected instructions or cancel it.`,
              ].join('\n');

              const notifyEvent = createAgentTask({
                agentId: 'coordinator',
                conversationId: `scheduler:${jobId}`,
                channelId: 'scheduler',
                senderId: 'scheduler',
                content: notifyContent,
                parentEventId: driftEvent.id,
              });
              await this.bus.publish('system', notifyEvent);

              this.logger.warn(
                { jobId, agentTaskId: job.agentTaskId, reason: verdict.reason, confidence: verdict.confidence },
                'Job paused due to intent drift detection',
              );

              // Do NOT call completeJobRun — the job is paused, not completed.
              return;
            }
          }
        }
      }
    }

    // Normal completion path (no drift, or drift check skipped/failed).
    const result = await this.schedulerService.completeJobRun(jobId, success, error);
    // ... rest of existing completion logic (suspended check, recovery notification, etc.)
```

**Important:** The `this.driftDetector['config']` access is a private-field access hack. Instead, expose `checkEveryNBursts` via a getter or pass the config separately. The simplest fix is to make `DriftDetector.checkEveryNBursts` a public readonly property:

In `drift-detector.ts`, add:
```typescript
get checkEveryNBursts(): number {
  return this.config.checkEveryNBursts;
}
```

Then use `this.driftDetector.checkEveryNBursts` in `scheduler.ts`.

- [ ] **Step 4: Run the full scheduler test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift test tests/unit/scheduler/scheduler.test.ts 2>&1 | tail -40
```

Expected: all tests pass, including the new drift detection block and all existing tests.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift add src/scheduler/scheduler.ts src/scheduler/drift-detector.ts tests/unit/scheduler/scheduler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift commit -m "feat: wire drift check into Scheduler.handleCompletion"
```

---

## Task 6: Config — YAML Schema + Validation

**Files:**
- Modify: `src/config.ts`
- Modify: `config/default.yaml`

- [ ] **Step 1: Add `intentDrift` to `YamlConfig` in `src/config.ts`**

Add to the `YamlConfig` interface:

```typescript
intentDrift?: {
  /** Enable intent drift detection. Default: false. */
  enabled?: boolean;
  /** Check every N bursts. Must be >= 1. Default: 1. */
  checkEveryNBursts?: number;
  /** Minimum LLM confidence required to pause the task. Default: 'high'. */
  minConfidenceToPause?: 'high' | 'medium' | 'low';
};
```

Add validation in `loadConfig()` after the existing `workingMemory` validation block:

```typescript
const drift = config.intentDrift;
if (drift !== undefined) {
  if (drift.checkEveryNBursts !== undefined) {
    if (!Number.isInteger(drift.checkEveryNBursts) || drift.checkEveryNBursts < 1) {
      throw new Error(
        `intentDrift.checkEveryNBursts must be a positive integer, got: ${drift.checkEveryNBursts}`,
      );
    }
  }
  const validConfidences = ['high', 'medium', 'low'];
  if (
    drift.minConfidenceToPause !== undefined &&
    !validConfidences.includes(drift.minConfidenceToPause)
  ) {
    throw new Error(
      `intentDrift.minConfidenceToPause must be one of: ${validConfidences.join(', ')}, got: "${drift.minConfidenceToPause}"`,
    );
  }
}
```

- [ ] **Step 2: Add the `intentDrift` block to `config/default.yaml`**

Add at the end of the file:

```yaml
# Intent drift detection (spec §06-audit-and-security.md — Intent Drift Detection).
# After each burst of a persistent scheduled task, the LLM compares the current
# task_payload against the original intent_anchor. If the task has drifted
# significantly with sufficient confidence, the job is paused and the CEO is notified.
#
# minConfidenceToPause controls the sensitivity:
#   "high"   — pause only on egregious, unambiguous deviations (default; fewest false positives)
#   "medium" — pause on probable deviations; some false positives expected
#   "low"    — pause whenever any drift is detected regardless of LLM confidence
#
# checkEveryNBursts: 1 checks on every burst. Set higher to reduce LLM call frequency
# for jobs that run very frequently and where occasional missed checks are acceptable.
#
# TODO: When multi-model support is added, add a provider field here so the drift
# judge can use a cheaper/faster model independently of the coordinator.
intentDrift:
  enabled: true
  checkEveryNBursts: 1
  minConfidenceToPause: high
```

- [ ] **Step 3: Run the config unit tests**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift test tests/unit/config.test.ts 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift add src/config.ts config/default.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift commit -m "feat: add intentDrift config schema and default.yaml block"
```

---

## Task 7: Wire Up in `index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import `DriftDetector` and `DriftConfig` at the top of `index.ts`**

```typescript
import { DriftDetector } from './scheduler/drift-detector.js';
import type { DriftConfig } from './scheduler/drift-detector.js';
```

- [ ] **Step 2: Construct the `DriftDetector` and pass it to `Scheduler`**

Find the `Scheduler` construction block (around line 565):

```typescript
const schedulerService = new SchedulerService(pool, bus, logger, config.timezone);
const scheduler = new Scheduler({ pool, bus, logger, schedulerService });
```

Replace with:

```typescript
const schedulerService = new SchedulerService(pool, bus, logger, config.timezone);

// Build the drift detector if enabled in config. Requires the coordinator's LLM
// provider (already created above). If enabled but no provider is available yet,
// the config is still valid — drift checks will simply never trigger.
//
// TODO: When multi-model support is added, make this provider independently configurable.
let driftDetector: DriftDetector | undefined;
if (yamlConfig.intentDrift?.enabled !== false) {
  // Resolve effective drift config with defaults.
  const driftConfig: DriftConfig = {
    enabled: yamlConfig.intentDrift?.enabled ?? true,
    checkEveryNBursts: yamlConfig.intentDrift?.checkEveryNBursts ?? 1,
    minConfidenceToPause: yamlConfig.intentDrift?.minConfidenceToPause ?? 'high',
  };
  // coordinatorProvider is the LLM provider already wired for the coordinator agent.
  // It is available at this point in the bootstrap sequence.
  driftDetector = new DriftDetector(coordinatorProvider, driftConfig, logger);
  logger.info({ driftConfig }, 'Intent drift detection enabled');
} else {
  logger.info('Intent drift detection disabled via config');
}

const scheduler = new Scheduler({ pool, bus, logger, schedulerService, driftDetector });
```

Note: `coordinatorProvider` is the variable name used in `index.ts` for the coordinator's LLM provider. Verify the actual variable name in context and use that.

- [ ] **Step 3: Build the project to catch any type errors**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift run build 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift add src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift commit -m "feat: wire DriftDetector into Scheduler bootstrap"
```

---

## Task 8: Full Test Run

- [ ] **Step 1: Run the complete test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift test 2>&1 | tail -40
```

Expected: all tests pass. Fix any failures before proceeding.

- [ ] **Step 2: Commit any fixes**

If you had to fix anything:
```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift add -p
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift commit -m "fix: <describe what broke>"
```

---

## Task 9: ADR, Spec Move, Changelog, Version Bump

**Files:**
- Create: `docs/adr/015-llm-as-judge-intent-drift.md`
- Modify: `docs/adr/README.md`
- Rename: `docs/superpowers/specs/2026-04-10-intent-drift-detection-design.md` → `docs/wip/2026-04-10-intent-drift-detection-design.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Write ADR 015**

Create `docs/adr/015-llm-as-judge-intent-drift.md`:

```markdown
# ADR 015 — LLM-as-judge for intent drift detection over embedding cosine similarity

**Status:** Accepted  
**Date:** 2026-04-10

## Context

Intent drift detection (spec §06) requires comparing the current `task_payload` of a
scheduled job against its original `intent_anchor` to determine whether the task has
meaningfully deviated from its mandate. Two approaches were considered:

1. **Embedding cosine similarity** — embed both texts with OpenAI text-embedding-3-small
   (already used for the knowledge graph) and compare cosine distances against a numeric
   threshold.

2. **LLM-as-judge** — prompt the coordinator's LLM to evaluate whether the task has
   drifted, returning a structured `{ drifted, reason, confidence }` verdict.

## Decision

Use LLM-as-judge (option 2).

Embedding similarity cannot distinguish between these two cases:
- "Research AI safety articles weekly" → "Summarise recent AI safety papers" (aligned, just rephrased)
- "Research AI safety articles weekly" → "Draft a market report on SaaS pricing" (clearly drifted)

Both pairs may have similar cosine distances depending on training data. The result is
unpredictable false-positive and false-negative rates that depend on embedding model
characteristics, not on semantic intent.

The LLM can reason about the *purpose* of a task and apply judgment that is not reducible
to vector distance. The `confidence` field also allows operators to tune sensitivity via
`minConfidenceToPause` without needing to calibrate a numeric threshold against
embedding geometry.

The `reason` field provides an audit trail that a similarity score cannot: it explains
*why* the LLM concluded the task has or has not drifted.

## Consequences

- **Easier:** Adding or tuning drift detection requires no knowledge of embedding geometry
  or threshold calibration. The natural language config (`minConfidenceToPause: high`) is
  self-documenting.
- **Harder:** LLM calls have latency and cost. One judge call per burst per persistent task
  is acceptable at current scale; at high job counts, `checkEveryNBursts` can reduce
  frequency.
- **Future:** When multi-model routing is added, the drift judge should be independently
  configurable to use a cheaper/faster model (e.g. Haiku instead of Sonnet). A TODO comment
  is placed at each wiring point.
- **Existing ADR 012** documents LLM-as-judge for outbound safety evaluation. This ADR
  extends the same pattern to a new evaluation surface (task integrity).
```

- [ ] **Step 2: Add ADR 015 to `docs/adr/README.md`**

Append to the index table:

```markdown
| [015](015-llm-as-judge-intent-drift.md) | LLM-as-judge for intent drift detection | Accepted |
```

- [ ] **Step 3: Move the spec file from the wrong location to `docs/wip/`**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift mv docs/superpowers/specs/2026-04-10-intent-drift-detection-design.md docs/wip/2026-04-10-intent-drift-detection-design.md
```

- [ ] **Step 4: Update `CHANGELOG.md`**

Add under `## [Unreleased]`:

```markdown
### Added
- **Intent drift detection** — after each burst of a persistent scheduled task, an LLM judge compares the current `task_payload` against the original `intent_anchor`. Tasks that drift with sufficient confidence are paused and the CEO is notified (spec §06-audit-and-security.md). Configured via `intentDrift:` block in `config/default.yaml`.
```

- [ ] **Step 5: Bump version in `package.json`**

Change `"version": "0.16.2"` to `"version": "0.16.3"`.

- [ ] **Step 6: Commit everything**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift add docs/adr/015-llm-as-judge-intent-drift.md docs/adr/README.md docs/wip/2026-04-10-intent-drift-detection-design.md CHANGELOG.md package.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift commit -m "chore: ADR 015, move spec to docs/wip, changelog, version bump 0.16.3"
```

---

## Task 10: Final Verification

- [ ] **Step 1: Run the full test suite one more time**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift test 2>&1 | tail -40
```

Expected: all tests pass.

- [ ] **Step 2: Build to confirm no type errors**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-intent-drift run build 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 3: Verify the acceptance criteria checklist**

Review the spec at `docs/wip/2026-04-10-intent-drift-detection-design.md` and confirm every unchecked acceptance criterion is now implemented.
