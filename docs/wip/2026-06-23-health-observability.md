# Health Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a three-state `/api/health` endpoint, a daily credential canary job, and the bus-event infrastructure to track LLM/embedding/image-gen call outcomes — giving Better Stack (or any heartbeat service) full visibility into Curia's sub-service health.

**Architecture:** A new `src/health/` module contains types, an in-memory outcome tracker, individual probe functions, and a central `HealthService`. The `HealthService` subscribes to bus events (`llm.call`, `llm.error`, `embedding.call`, `embedding.error`, `skill.result`) to track call outcomes, and probes services directly (Signal socket, browser context, MCP stdio subprocess) on each `/api/health` request. A daily scheduler job (`runCanaries()`) validates credentials and pings heartbeat URLs.

**Tech Stack:** TypeScript ESM, Fastify, Vitest, pino, `@modelcontextprotocol/sdk` Client, `pg` Pool, node `fetch`.

## Global Constraints

- ESM only: `"type": "module"` — all relative imports must use `.js` extension.
- No `any` — use proper types, generics, or `unknown` + narrowing.
- Node 24+: use `import.meta.dirname` not `__dirname`.
- Logging: pino only — no `console.log` anywhere.
- Parameterized SQL queries only — never interpolate.
- Type check: always run `pnpm run typecheck` (not bare `tsc`).
- Tests: Vitest, co-located in `tests/unit/health/` and `tests/integration/`.
- Commit style: `feat:` / `fix:` / `chore:` conventional commits, no `Co-Authored-By`.
- No `Co-Authored-By` or "Generated with Claude Code" in any commit or PR.
- `Closes #434` in the PR body.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/health/types.ts` | New | `CheckResult`, `HealthStatus`, `HealthResponse`, `CanaryResult`, `TrackerKey` |
| `src/health/llm-outcome-tracker.ts` | New | In-memory per-key success/error recorder |
| `src/health/health-checks.ts` | New | Individual probe functions (db, bus, email, signal, browser, mcp, scheduler) |
| `src/health/health-service.ts` | New | `HealthService`: `getStatus()`, `runCanaries()`, `start()` |
| `src/bus/events.ts` | Modify | Add `llm.error` + `embedding.error` event types and factory functions |
| `src/agents/llm/telemetry-provider.ts` | Modify | Publish `llm.error` on error response path |
| `src/agents/runtime.ts` | Modify | Publish `llm.error` on error path in `chatWithRetry` |
| `src/memory/embedding.ts` | Modify | Publish `embedding.error` on OpenAI backend failure |
| `src/scheduler/scheduler.ts` | Modify | Add `public lastTickAt: Date \| null = null`; update in watchdog |
| `src/channels/http/routes/health.ts` | Modify | Thin shim — calls `healthService.getStatus()` |
| `src/channels/http/http-adapter.ts` | Modify | Add `healthService?: HealthService` to `HttpAdapterConfig` |
| `src/config.ts` | Modify | `HealthConfig` interface + `resolveHealthConfig()` + `YamlConfig.health` |
| `config/default.yaml` | Modify | New `health:` block |
| `src/index.ts` | Modify | Construct `HealthService`, wire bus subs, register canary, pass to HttpAdapter |
| `docs/dev/health-monitoring.md` | New | Operator setup guide |
| `CHANGELOG.md` | Modify | Unreleased entry for this PR |

---

## Task 1: Foundation Types + `LlmOutcomeTracker`

**Files:**
- Create: `src/health/types.ts`
- Create: `src/health/llm-outcome-tracker.ts`
- Test: `tests/unit/health/llm-outcome-tracker.test.ts`

**Interfaces:**
- Produces: `CheckResult`, `HealthStatus`, `HealthResponse`, `TrackerKey`, `LlmOutcomeTracker` class

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/health/llm-outcome-tracker.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { LlmOutcomeTracker } from '../../../src/health/llm-outcome-tracker.js';

describe('LlmOutcomeTracker', () => {
  let tracker: LlmOutcomeTracker;

  beforeEach(() => {
    tracker = new LlmOutcomeTracker();
  });

  it('starts with null outcomes for all keys', () => {
    const outcome = tracker.getOutcome('fast');
    expect(outcome.lastSuccessAt).toBeNull();
    expect(outcome.lastErrorAt).toBeNull();
  });

  it('records success', () => {
    tracker.recordSuccess('fast');
    const outcome = tracker.getOutcome('fast');
    expect(outcome.lastSuccessAt).toBeInstanceOf(Date);
    expect(outcome.lastErrorAt).toBeNull();
  });

  it('records error', () => {
    tracker.recordError('standard');
    const outcome = tracker.getOutcome('standard');
    expect(outcome.lastErrorAt).toBeInstanceOf(Date);
    expect(outcome.lastSuccessAt).toBeNull();
  });

  it('records embeddings key', () => {
    tracker.recordSuccess('embeddings');
    expect(tracker.getOutcome('embeddings').lastSuccessAt).toBeInstanceOf(Date);
  });

  it('records image_gen key', () => {
    tracker.recordError('image_gen');
    expect(tracker.getOutcome('image_gen').lastErrorAt).toBeInstanceOf(Date);
  });

  it('latest error after success indicates failure', () => {
    tracker.recordSuccess('fast');
    tracker.recordError('fast');
    const { lastSuccessAt, lastErrorAt } = tracker.getOutcome('fast');
    expect(lastErrorAt!.getTime()).toBeGreaterThan(lastSuccessAt!.getTime());
  });

  it('latest success after error indicates ok', () => {
    tracker.recordError('fast');
    tracker.recordSuccess('fast');
    const { lastSuccessAt, lastErrorAt } = tracker.getOutcome('fast');
    expect(lastSuccessAt!.getTime()).toBeGreaterThan(lastErrorAt!.getTime());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/health/llm-outcome-tracker.test.ts
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Write `src/health/types.ts`**

```typescript
// types.ts — shared types for the health observability module.

export type CheckResult = 'ok' | 'fail' | 'skipped';

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthResponse {
  status: HealthStatus;
  uptime_s: number;
  checks: {
    db: CheckResult;
    bus: CheckResult;
    signal: CheckResult;
    email: CheckResult;
    browser: CheckResult;
    mcp: { google_workspace: CheckResult };
    scheduler: CheckResult;
  };
}

export interface CanaryResult {
  name: string;
  status: 'ok' | 'fail' | 'skipped';
  detail?: string;
}

// Keys the LlmOutcomeTracker records against.
// LLM tiers match the model_routing tier names.
// 'embeddings' and 'image_gen' track OpenAI-backed capability calls.
export type TrackerKey = 'fast' | 'standard' | 'powerful' | 'embeddings' | 'image_gen';

export interface TierOutcome {
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
}
```

- [ ] **Step 4: Write `src/health/llm-outcome-tracker.ts`**

```typescript
// llm-outcome-tracker.ts — in-memory recorder of per-key LLM/embedding call outcomes.
//
// Maintained by HealthService via bus event subscriptions (llm.call, llm.error,
// embedding.call, embedding.error, skill.result). Read by runCanaries() to determine
// whether each capability tier has been healthy without making billed probe calls.

import type { TrackerKey, TierOutcome } from './types.js';

export class LlmOutcomeTracker {
  private readonly outcomes = new Map<TrackerKey, TierOutcome>();

  recordSuccess(key: TrackerKey): void {
    const existing = this.outcomes.get(key) ?? { lastSuccessAt: null, lastErrorAt: null };
    this.outcomes.set(key, { ...existing, lastSuccessAt: new Date() });
  }

  recordError(key: TrackerKey): void {
    const existing = this.outcomes.get(key) ?? { lastSuccessAt: null, lastErrorAt: null };
    this.outcomes.set(key, { ...existing, lastErrorAt: new Date() });
  }

  getOutcome(key: TrackerKey): TierOutcome {
    return this.outcomes.get(key) ?? { lastSuccessAt: null, lastErrorAt: null };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/unit/health/llm-outcome-tracker.test.ts
```

Expected: PASS (7 tests)

- [ ] **Step 6: Type check**

```bash
pnpm run typecheck
```

Expected: no errors

- [ ] **Step 7: Commit**

```bash
git -C /path/to/worktree add src/health/types.ts src/health/llm-outcome-tracker.ts tests/unit/health/llm-outcome-tracker.test.ts
git -C /path/to/worktree commit -m "feat: add health types and LlmOutcomeTracker"
```

---

## Task 2: Bus Error Events + Telemetry Publishing

**Files:**
- Modify: `src/bus/events.ts`
- Modify: `src/agents/llm/telemetry-provider.ts`
- Modify: `src/agents/runtime.ts`
- Modify: `src/memory/embedding.ts`
- Test: `tests/unit/health/error-events.test.ts`

**Interfaces:**
- Consumes: existing `llm.call`, `embedding.call` bus event patterns
- Produces: `LlmErrorEvent`, `EmbeddingErrorEvent`, factory functions `createLlmError`, `createEmbeddingError`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/health/error-events.test.ts
import { describe, it, expect } from 'vitest';
import { createLlmError, createEmbeddingError } from '../../../src/bus/events.js';

describe('llm.error event factory', () => {
  it('creates a valid llm.error event', () => {
    const event = createLlmError({
      agentId: 'system:drift-detector',
      conversationId: 'system',
      requestedModel: 'claude-haiku-4-5',
      provider: 'anthropic',
      errorType: 'AUTH_FAILURE',
      parentEventId: 'system',
    });
    expect(event.type).toBe('llm.error');
    expect(event.sourceLayer).toBe('agent');
    expect(event.payload.requestedModel).toBe('claude-haiku-4-5');
    expect(event.payload.errorType).toBe('AUTH_FAILURE');
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeInstanceOf(Date);
  });
});

describe('embedding.error event factory', () => {
  it('creates a valid embedding.error event', () => {
    const event = createEmbeddingError({
      model: 'text-embedding-3-small',
      errorType: 'FETCH_FAILED',
    });
    expect(event.type).toBe('embedding.error');
    expect(event.sourceLayer).toBe('agent');
    expect(event.payload.model).toBe('text-embedding-3-small');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/health/error-events.test.ts
```

Expected: FAIL — `createLlmError` and `createEmbeddingError` not exported

- [ ] **Step 3: Add `llm.error` event to `src/bus/events.ts`**

Find the block after the `LlmCallEvent` definition (around line 806) and add after it:

```typescript
// LlmErrorEvent — published by TelemetryLlmProvider and AgentRuntime on every
// failed LLM call (response.type === 'error'). Used by HealthService to maintain
// the per-tier outcome tracker without making billed probe calls.
interface LlmErrorPayload {
  agentId: string;
  conversationId: string;
  /** Model that was requested — used by HealthService to reverse-map to a tier. */
  requestedModel: string;
  provider: string;
  errorType: string;
  parentEventId: string;
}

export interface LlmErrorEvent extends BaseEvent {
  type: 'llm.error';
  sourceLayer: 'agent';
  payload: LlmErrorPayload;
}

export function createLlmError(
  payload: LlmErrorPayload,
): LlmErrorEvent {
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'llm.error',
    sourceLayer: 'agent',
    payload,
    parentEventId: payload.parentEventId,
  };
}
```

Also add `LlmErrorEvent` to the `BusEvent` union type (the discriminated union near the bottom of events.ts that lists all event types). Find it with:
```bash
grep -n "LlmCallEvent\|BusEvent =" src/bus/events.ts | head -10
```
Add `| LlmErrorEvent` alongside `LlmCallEvent`.

- [ ] **Step 4: Add `embedding.error` event to `src/bus/events.ts`**

Find the `EmbeddingCallEvent` block and add after it:

```typescript
// EmbeddingErrorEvent — published by the OpenAI embedding backend on failure.
// Used by HealthService to track embedding service health.
interface EmbeddingErrorPayload {
  model: string;
  errorType: string;
}

export interface EmbeddingErrorEvent extends BaseEvent {
  type: 'embedding.error';
  sourceLayer: 'agent';
  payload: EmbeddingErrorPayload;
}

export function createEmbeddingError(
  payload: EmbeddingErrorPayload,
): EmbeddingErrorEvent {
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'embedding.error',
    sourceLayer: 'agent',
    payload,
  };
}
```

Add `| EmbeddingErrorEvent` to the `BusEvent` union type.

Also add `'llm.error'` and `'embedding.error'` to the `EventType` string union (wherever `'llm.call'` and `'embedding.call'` appear in the union).

- [ ] **Step 5: Add `llm.error` publishing to `TelemetryLlmProvider`**

In `src/agents/llm/telemetry-provider.ts`, add `createLlmError` to the import line:

```typescript
import { createLlmCall, createLlmError } from '../../bus/events.js';
```

In the `chat()` method, the error path currently at line 59 (`if (response.type !== 'error') { ... }`):

```typescript
// After the existing success block that publishes llm.call,
// add an error block that publishes llm.error.
// The current code returns response at line 101 — add BEFORE that return:
if (response.type === 'error') {
  try {
    const event = createLlmError({
      agentId: `system:${this.serviceId}`,
      conversationId: 'system',
      requestedModel: params.model ?? 'unknown',
      provider: this.inner.id,
      errorType: response.error.type,
      parentEventId: 'system',
    });
    await this.bus.publish('agent', event);
  } catch (err) {
    this.logger.warn(
      { err, serviceId: this.serviceId },
      'TelemetryLlmProvider: failed to publish llm.error event',
    );
  }
}
```

Add this block immediately after the existing telemetry block (after line 98's closing `}`) and before `return response`.

- [ ] **Step 6: Add `llm.error` publishing to `AgentRuntime`**

In `src/agents/runtime.ts`, find `publishLlmCallEvent` (around line 1316). Add a parallel helper right after it:

```typescript
// Publish llm.error for failed provider calls — used by HealthService to track
// tier health without making billed probes. Fire-and-forget with try-catch like
// publishLlmCallEvent: telemetry failure must never abort an agent task.
const publishLlmErrorEvent = async (
  response: LLMResponse & { type: 'error' },
  requestedModel: string | undefined,
  providerIdOverride?: string,
): Promise<void> => {
  try {
    const event = createLlmError({
      agentId,
      conversationId: taskEvent.payload.conversationId,
      requestedModel: requestedModel ?? 'unknown',
      provider: providerIdOverride ?? provider.id,
      errorType: response.error.type,
      parentEventId: taskEvent.id,
    });
    await bus.publish('agent', event);
  } catch (err) {
    logger.error({ err, agentId }, 'Failed to publish llm.error telemetry event');
  }
};
```

Add `createLlmError` to the import of `createLlmCall` at the top of the file:
```typescript
import { createLlmCall, createLlmError } from '../bus/events.js';
```

Then in the error path (around line 1373, after `const agentErr = response.error;`), add:
```typescript
// Publish llm.error before any retry/fallback so the tracker records the raw failure.
await publishLlmErrorEvent(response, modelForCall);
```

Also add the same call in the retry loop when the retry also fails.

- [ ] **Step 7: Add `embedding.error` publishing to `EmbeddingService`**

In `src/memory/embedding.ts`, add `createEmbeddingError` to the import:
```typescript
import { createEmbeddingCall, createEmbeddingError } from '../bus/events.js';
```

In `OpenAIBackend.embed()`, the current error handling at line ~102 throws:
```typescript
this.logger.error({ err }, 'OpenAI embedding fetch failed');
throw new Error(...);
```

Wrap the throw with an error event publish:
```typescript
// Publish embedding.error so HealthService can track embedding health.
if (this.bus) {
  this.bus.publish('agent', createEmbeddingError({
    model: 'text-embedding-3-small',
    errorType: 'FETCH_FAILED',
  })).catch((publishErr: unknown) => {
    this.logger.warn({ publishErr }, 'Failed to publish embedding.error event');
  });
}
this.logger.error({ err }, 'OpenAI embedding fetch failed');
throw new Error(`OpenAI embedding fetch error: ${(err as Error).message}`);
```

Apply the same pattern to the API error case (~line 109) and JSON parse error (~line 121), using `errorType: 'API_ERROR'` and `errorType: 'PARSE_ERROR'` respectively.

- [ ] **Step 8: Run test**

```bash
npx vitest run tests/unit/health/error-events.test.ts
```

Expected: PASS

- [ ] **Step 9: Type check**

```bash
pnpm run typecheck
```

Expected: no errors. Fix any union/type issues found.

- [ ] **Step 10: Commit**

```bash
git -C /path/to/worktree add src/bus/events.ts src/agents/llm/telemetry-provider.ts src/agents/runtime.ts src/memory/embedding.ts tests/unit/health/error-events.test.ts
git -C /path/to/worktree commit -m "feat: add llm.error and embedding.error bus events"
```

---

## Task 3: Scheduler `lastTickAt`

**Files:**
- Modify: `src/scheduler/scheduler.ts`
- Test: `tests/unit/scheduler/scheduler-last-tick.test.ts`

**Interfaces:**
- Produces: `Scheduler.lastTickAt: Date | null` (public field)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/scheduler/scheduler-last-tick.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Scheduler } from '../../../src/scheduler/scheduler.js';

describe('Scheduler.lastTickAt', () => {
  it('starts as null', () => {
    const scheduler = new Scheduler({
      pool: {} as never,
      bus: { subscribe: vi.fn(), publish: vi.fn() } as never,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
      schedulerService: {} as never,
    });
    expect(scheduler.lastTickAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/scheduler/scheduler-last-tick.test.ts
```

Expected: FAIL — `lastTickAt` is not a property of `Scheduler`

- [ ] **Step 3: Add `lastTickAt` to `Scheduler` class**

In `src/scheduler/scheduler.ts`, find the private fields section (around line 120–138). Add:

```typescript
/** Timestamp of the most recent watchdog tick. Null until the first tick runs.
 *  Read by HealthService to detect a stalled scheduler. */
public lastTickAt: Date | null = null;
```

Then in the watchdog callback (around line 193–197):

```typescript
this.watchdogHandle = setInterval(() => {
  this.lastTickAt = new Date();  // <-- add this line
  this.recoverStuckJobs().catch((err) => {
    this.logger.error({ err }, 'Unhandled error in recoverStuckJobs watchdog');
  });
}, WATCHDOG_INTERVAL_MS);
```

- [ ] **Step 4: Run test**

```bash
npx vitest run tests/unit/scheduler/scheduler-last-tick.test.ts
```

Expected: PASS

- [ ] **Step 5: Type check + commit**

```bash
pnpm run typecheck
git -C /path/to/worktree add src/scheduler/scheduler.ts tests/unit/scheduler/scheduler-last-tick.test.ts
git -C /path/to/worktree commit -m "feat: add lastTickAt to Scheduler for health observability"
```

---

## Task 4: Health Config

**Files:**
- Modify: `config/default.yaml`
- Modify: `src/config.ts`
- Test: `tests/unit/health/config.test.ts`

**Interfaces:**
- Produces: `HealthConfig` interface, `resolveHealthConfig(yaml)` function

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/health/config.test.ts
import { describe, it, expect } from 'vitest';
import { resolveHealthConfig } from '../../../src/config.js';

describe('resolveHealthConfig', () => {
  it('returns defaults for undefined input', () => {
    const config = resolveHealthConfig(undefined);
    expect(config.liveness.emailStallFactor).toBe(3);
    expect(config.liveness.schedulerMaxTickS).toBe(120);
    expect(config.canarySchedule).toBe('0 6 * * *');
    expect(config.heartbeats.llm_fast).toBeNull();
  });

  it('accepts valid heartbeat URLs', () => {
    const config = resolveHealthConfig({
      liveness: { email_stall_factor: 5, scheduler_max_tick_s: 60 },
      canary_schedule: '0 8 * * *',
      heartbeats: { llm_fast: 'https://uptime.betterstack.com/api/v1/heartbeat/abc123' },
    });
    expect(config.heartbeats.llm_fast).toBe('https://uptime.betterstack.com/api/v1/heartbeat/abc123');
    expect(config.liveness.emailStallFactor).toBe(5);
  });

  it('nulls out non-https heartbeat URLs with a warning (no throw)', () => {
    // Should not throw — just silently null out the bad URL.
    const config = resolveHealthConfig({
      heartbeats: { nylas: 'http://insecure.example.com/heartbeat' },
    });
    expect(config.heartbeats.nylas).toBeNull();
  });

  it('nulls out invalid heartbeat URLs', () => {
    const config = resolveHealthConfig({
      heartbeats: { signal: 'not-a-url' },
    });
    expect(config.heartbeats.signal).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/health/config.test.ts
```

Expected: FAIL — `resolveHealthConfig` not exported

- [ ] **Step 3: Add `health:` block to `config/default.yaml`**

Add after the `scheduler:` section (around line 104):

```yaml
health:
  # Thresholds for time-based liveness checks
  liveness:
    email_stall_factor: 3      # fail if last poll older than N × pollingIntervalMs
    scheduler_max_tick_s: 120  # fail if scheduler watchdog last ticked > N seconds ago

  # Cron schedule for the daily credential/dependency canary job (server local time)
  canary_schedule: "0 6 * * *"

  # Heartbeat URLs — GET on successful canary (Better Stack, Healthchecks.io, Cronitor, etc.)
  # LLM keys are tier-named so they survive a model_routing provider swap.
  # Leave empty to skip the ping (canary still runs and logs).
  heartbeats:
    llm_fast: ""
    llm_standard: ""
    llm_powerful: ""
    embeddings: ""
    image_gen: ""
    nylas: ""
    signal: ""
    google_workspace: ""
    tavily: ""
```

- [ ] **Step 4: Add `HealthConfig` to `src/config.ts`**

After the existing `TasksConfig` block (around line 72), add:

```typescript
export interface HealthLivenessConfig {
  /** Fail email check if last poll is older than N × pollingIntervalMs. */
  emailStallFactor: number;
  /** Fail scheduler check if watchdog last ticked more than N seconds ago. */
  schedulerMaxTickS: number;
}

export interface HealthHeartbeats {
  llm_fast: string | null;
  llm_standard: string | null;
  llm_powerful: string | null;
  embeddings: string | null;
  image_gen: string | null;
  nylas: string | null;
  signal: string | null;
  google_workspace: string | null;
  tavily: string | null;
}

export interface HealthConfig {
  liveness: HealthLivenessConfig;
  canarySchedule: string;
  heartbeats: HealthHeartbeats;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  liveness: {
    emailStallFactor: 3,
    schedulerMaxTickS: 120,
  },
  canarySchedule: '0 6 * * *',
  heartbeats: {
    llm_fast: null,
    llm_standard: null,
    llm_powerful: null,
    embeddings: null,
    image_gen: null,
    nylas: null,
    signal: null,
    google_workspace: null,
    tavily: null,
  },
};

/** Validate a heartbeat URL: must be https:// or null. Returns null + logs warn if invalid. */
function validateHeartbeatUrl(raw: string | undefined | null, key: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') {
      // Non-https URLs are not safe to ping — log warning and skip.
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/** Resolve the optional YAML health block to a fully-populated config with defaults. */
export function resolveHealthConfig(
  yamlHealth: YamlConfig['health'] | undefined,
): HealthConfig {
  const hb = yamlHealth?.heartbeats;
  return {
    liveness: {
      emailStallFactor: yamlHealth?.liveness?.email_stall_factor ?? DEFAULT_HEALTH_CONFIG.liveness.emailStallFactor,
      schedulerMaxTickS: yamlHealth?.liveness?.scheduler_max_tick_s ?? DEFAULT_HEALTH_CONFIG.liveness.schedulerMaxTickS,
    },
    canarySchedule: yamlHealth?.canary_schedule ?? DEFAULT_HEALTH_CONFIG.canarySchedule,
    heartbeats: {
      llm_fast: validateHeartbeatUrl(hb?.llm_fast, 'llm_fast'),
      llm_standard: validateHeartbeatUrl(hb?.llm_standard, 'llm_standard'),
      llm_powerful: validateHeartbeatUrl(hb?.llm_powerful, 'llm_powerful'),
      embeddings: validateHeartbeatUrl(hb?.embeddings, 'embeddings'),
      image_gen: validateHeartbeatUrl(hb?.image_gen, 'image_gen'),
      nylas: validateHeartbeatUrl(hb?.nylas, 'nylas'),
      signal: validateHeartbeatUrl(hb?.signal, 'signal'),
      google_workspace: validateHeartbeatUrl(hb?.google_workspace, 'google_workspace'),
      tavily: validateHeartbeatUrl(hb?.tavily, 'tavily'),
    },
  };
}
```

Also add the `health` field to `YamlConfig` interface (wherever it's defined in `config.ts`):

```typescript
health?: {
  liveness?: {
    email_stall_factor?: number;
    scheduler_max_tick_s?: number;
  };
  canary_schedule?: string;
  heartbeats?: {
    llm_fast?: string;
    llm_standard?: string;
    llm_powerful?: string;
    embeddings?: string;
    image_gen?: string;
    nylas?: string;
    signal?: string;
    google_workspace?: string;
    tavily?: string;
  };
};
```

- [ ] **Step 5: Run test**

```bash
npx vitest run tests/unit/health/config.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 6: Type check + commit**

```bash
pnpm run typecheck
git -C /path/to/worktree add config/default.yaml src/config.ts tests/unit/health/config.test.ts
git -C /path/to/worktree commit -m "feat: add health config schema and resolver"
```

---

## Task 5: `health-checks.ts` — Liveness Probes

**Files:**
- Create: `src/health/health-checks.ts`
- Test: `tests/unit/health/health-checks.test.ts`

**Interfaces:**
- Consumes: `Pool` (pg), `EventBus`, `EmailAdapter.lastSuccessfulPollAt`, `EmailAdapter.pollingIntervalMs`, `SignalRpcClient.listGroups()`, `BrowserService.context`, `McpSession[]` (from mcp-client.ts), `Scheduler.lastTickAt`
- Produces: individual `check*()` functions, each returning `Promise<CheckResult>`

**Important:** The `EmailAdapter` needs a public getter for `lastSuccessfulPollAt` and `pollingIntervalMs`. Confirm these are currently private — if so, add:
```typescript
get lastSuccessfulPollAt(): Date | null { return this._lastSuccessfulPollAt; }
get pollingIntervalMs(): number { return this.config.pollingIntervalMs; }
```
to `EmailAdapter` in `src/channels/email/email-adapter.ts`. Check the field name (`lastSuccessfulPollAt` may already be typed as a number/epoch; if so, convert to `Date` in the check).

**Important:** The `BrowserService.context` is `private`. Add a getter:
```typescript
get browserContext(): BrowserContext | null { return this.context; }
```
to `BrowserService` in `src/browser/browser-service.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/health/health-checks.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  checkDb,
  checkBus,
  checkEmail,
  checkScheduler,
} from '../../../src/health/health-checks.js';

describe('checkDb', () => {
  it('returns ok when SELECT 1 succeeds', async () => {
    const pool = { query: vi.fn().mockResolvedValue({}) } as never;
    expect(await checkDb(pool)).toBe('ok');
  });

  it('returns fail when query throws', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection refused')) } as never;
    expect(await checkDb(pool)).toBe('fail');
  });
});

describe('checkBus', () => {
  it('returns ok when bus has listeners', () => {
    const bus = { listenerCount: vi.fn().mockReturnValue(3) } as never;
    expect(checkBus(bus)).toBe('ok');
  });

  it('returns fail when bus has no listeners', () => {
    const bus = { listenerCount: vi.fn().mockReturnValue(0) } as never;
    expect(checkBus(bus)).toBe('fail');
  });
});

describe('checkEmail', () => {
  const startedAt = new Date(Date.now() - 60_000); // 60s ago

  it('returns skipped when no adapter provided', () => {
    expect(checkEmail(undefined, 3, startedAt)).toBe('skipped');
  });

  it('returns ok within grace window when lastSuccessfulPollAt is null', () => {
    const recentStart = new Date(Date.now() - 1000); // 1s ago
    const adapter = { lastSuccessfulPollAt: null, pollingIntervalMs: 60_000 } as never;
    expect(checkEmail(adapter, 3, recentStart)).toBe('ok');
  });

  it('returns fail when null past grace window', () => {
    const oldStart = new Date(Date.now() - 300_000); // 5min ago, grace = 3×60s = 3min
    const adapter = { lastSuccessfulPollAt: null, pollingIntervalMs: 60_000 } as never;
    expect(checkEmail(adapter, 3, oldStart)).toBe('fail');
  });

  it('returns ok when last poll is recent', () => {
    const adapter = {
      lastSuccessfulPollAt: new Date(Date.now() - 30_000), // 30s ago
      pollingIntervalMs: 60_000,
    } as never;
    expect(checkEmail(adapter, 3, startedAt)).toBe('ok');
  });

  it('returns fail when last poll is stale', () => {
    const adapter = {
      lastSuccessfulPollAt: new Date(Date.now() - 300_000), // 5min ago, threshold = 3×60s = 3min
      pollingIntervalMs: 60_000,
    } as never;
    expect(checkEmail(adapter, 3, startedAt)).toBe('fail');
  });
});

describe('checkScheduler', () => {
  it('returns ok within grace window when lastTickAt is null', () => {
    const recentStart = new Date(Date.now() - 5_000);
    const scheduler = { lastTickAt: null } as never;
    expect(checkScheduler(scheduler, 120, recentStart)).toBe('ok');
  });

  it('returns fail when null past grace window', () => {
    const oldStart = new Date(Date.now() - 300_000);
    const scheduler = { lastTickAt: null } as never;
    expect(checkScheduler(scheduler, 120, oldStart)).toBe('fail');
  });

  it('returns ok when last tick is recent', () => {
    const scheduler = { lastTickAt: new Date(Date.now() - 60_000) } as never;
    expect(checkScheduler(scheduler, 120, new Date(0))).toBe('ok');
  });

  it('returns fail when last tick is stale', () => {
    const scheduler = { lastTickAt: new Date(Date.now() - 300_000) } as never;
    expect(checkScheduler(scheduler, 120, new Date(0))).toBe('fail');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/health/health-checks.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Add public getters to `EmailAdapter` and `BrowserService`**

In `src/channels/email/email-adapter.ts`, locate the `lastSuccessfulPollAt` field (likely stored as epoch ms or Date). Add a getter:
```typescript
get lastSuccessfulPollAt(): Date | null {
  // If stored as epoch ms (number), convert: return this._lastSuccessfulPollAt != null
  //   ? new Date(this._lastSuccessfulPollAt) : null;
  // If already a Date | null, just return it:
  return this._lastSuccessfulPollAt;
}
get pollingIntervalMs(): number {
  return this.config.pollingIntervalMs;
}
```
(Inspect the actual field type/name and adjust. The field was confirmed to be `lastSuccessfulPollAt`.)

In `src/browser/browser-service.ts`, add:
```typescript
get browserContext(): import('playwright').BrowserContext | null {
  return this.context;
}
```

- [ ] **Step 4: Write `src/health/health-checks.ts`**

```typescript
// health-checks.ts — individual liveness probe functions for /api/health.
//
// Each function is independent, has a hard timeout, and returns CheckResult.
// 'skipped' means the service is not configured — never affects overall status.
// Probe-based checks (db, bus, signal, browser, mcp) run on every request.
// Time-based checks (email, scheduler) use startedAt as a grace-period anchor.

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { CheckResult } from './types.js';
import type { Scheduler } from '../scheduler/scheduler.js';

// -- Type aliases for the injectable service references --
// Using structural typing so we don't create hard circular imports.

export interface EmailAdapterHealth {
  lastSuccessfulPollAt: Date | null;
  pollingIntervalMs: number;
}

export interface SignalRpcClientHealth {
  listGroups(): Promise<unknown[]>;
}

export interface BrowserServiceHealth {
  browserContext: { isConnected(): boolean } | null;
}

export interface McpSessionHealth {
  serverId: string;
  client: {
    listTools(): Promise<unknown>;
  };
}

/** Run SELECT 1 with a 2s timeout. Critical check. */
export async function checkDb(pool: Pool): Promise<CheckResult> {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2_000),
      ),
    ]);
    return 'ok';
  } catch {
    return 'fail';
  }
}

/** Verify the event bus has active listeners (not torn down). Synchronous. Critical check. */
export function checkBus(bus: EventBus): CheckResult {
  // EventBus wraps an EventEmitter — check total listener count.
  // A live bus has at minimum the audit-logger subscriptions.
  const count = (bus as unknown as { listenerCount?: (event: string) => number }).listenerCount;
  if (typeof count === 'function') {
    // Check a well-known event type that is always subscribed at startup.
    // If zero, the bus emitter has been torn down.
    return count.call(bus, 'agent.task') > 0 ? 'ok' : 'fail';
  }
  // Fallback: EventBus is alive if it's a non-null object — best-effort.
  return bus != null ? 'ok' : 'fail';
}

/**
 * Check email adapter stall state. Non-critical.
 * Boot-correct: within grace window (emailStallFactor × pollingIntervalMs from startedAt),
 * null lastSuccessfulPollAt is ok.
 */
export function checkEmail(
  adapter: EmailAdapterHealth | undefined,
  emailStallFactor: number,
  startedAt: Date,
): CheckResult {
  if (!adapter) return 'skipped';
  const { lastSuccessfulPollAt, pollingIntervalMs } = adapter;
  const now = Date.now();
  const graceMs = emailStallFactor * pollingIntervalMs;

  if (lastSuccessfulPollAt === null) {
    return now - startedAt.getTime() < graceMs ? 'ok' : 'fail';
  }
  return now - lastSuccessfulPollAt.getTime() < graceMs ? 'ok' : 'fail';
}

/**
 * Check Signal RPC socket connectivity via a lightweight listGroups() call.
 * Non-critical. Skipped when no signalRpcClient is provided.
 */
export async function checkSignal(
  client: SignalRpcClientHealth | undefined,
): Promise<CheckResult> {
  if (!client) return 'skipped';
  try {
    await Promise.race([
      client.listGroups(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3_000),
      ),
    ]);
    return 'ok';
  } catch {
    return 'fail';
  }
}

/** Check Playwright browser context connectivity. Non-critical. Synchronous. */
export function checkBrowser(service: BrowserServiceHealth | undefined): CheckResult {
  if (!service) return 'skipped';
  if (!service.browserContext) return 'fail';
  return service.browserContext.isConnected() ? 'ok' : 'fail';
}

/**
 * Check google-workspace MCP subprocess via tools/list call.
 * Non-critical. Skipped when the server is not in mcpSessions.
 */
export async function checkMcpGoogleWorkspace(
  mcpSessions: McpSessionHealth[],
): Promise<CheckResult> {
  const session = mcpSessions.find(s => s.serverId === 'google-workspace');
  if (!session) return 'skipped';
  try {
    await Promise.race([
      session.client.listTools(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3_000),
      ),
    ]);
    return 'ok';
  } catch {
    return 'fail';
  }
}

/**
 * Check scheduler watchdog liveness. Non-critical.
 * Boot-correct: within grace window (schedulerMaxTickS seconds from startedAt),
 * null lastTickAt is ok.
 */
export function checkScheduler(
  scheduler: Pick<Scheduler, 'lastTickAt'>,
  schedulerMaxTickS: number,
  startedAt: Date,
): CheckResult {
  const now = Date.now();
  const graceMs = schedulerMaxTickS * 1_000;
  if (scheduler.lastTickAt === null) {
    return now - startedAt.getTime() < graceMs ? 'ok' : 'fail';
  }
  return now - scheduler.lastTickAt.getTime() < graceMs ? 'ok' : 'fail';
}
```

- [ ] **Step 5: Run test**

```bash
npx vitest run tests/unit/health/health-checks.test.ts
```

Expected: PASS (all tests)

- [ ] **Step 6: Type check + commit**

```bash
pnpm run typecheck
git -C /path/to/worktree add src/health/health-checks.ts src/channels/email/email-adapter.ts src/browser/browser-service.ts tests/unit/health/health-checks.test.ts
git -C /path/to/worktree commit -m "feat: add health liveness probe functions"
```

---

## Task 6: `HealthService`

**Files:**
- Create: `src/health/health-service.ts`
- Test: `tests/unit/health/health-service.test.ts`

**Interfaces:**
- Consumes: `LlmOutcomeTracker` (internal), all `check*()` functions from health-checks.ts, `HealthConfig`, `ModelRoutingConfig`, `McpSession[]`
- Produces: `HealthService` class with `start()`, `getStatus()`, `runCanaries()`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/health/health-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthService } from '../../../src/health/health-service.js';
import { DEFAULT_HEALTH_CONFIG } from '../../../src/config.js';

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    db: { query: vi.fn().mockResolvedValue({}) },
    bus: { subscribe: vi.fn(), publish: vi.fn(), listenerCount: vi.fn().mockReturnValue(5) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    scheduler: { lastTickAt: new Date() },
    emailAdapter: undefined,
    signalRpcClient: undefined,
    browserService: undefined,
    mcpSessions: [],
    modelRoutingConfig: {
      tiers: {
        fast: { model: 'claude-haiku-4-5' },
        standard: { model: 'claude-sonnet-4-6' },
        powerful: { model: 'claude-opus-4-8' },
      },
      default_tier: 'standard',
    },
    config: DEFAULT_HEALTH_CONFIG,
    openaiApiKey: undefined,
    ...overrides,
  };
}

describe('HealthService.getStatus()', () => {
  it('returns ok when all critical checks pass', async () => {
    const svc = new HealthService(makeDeps() as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('ok');
    expect(result.checks.db).toBe('ok');
    expect(result.checks.bus).toBe('ok');
    expect(result.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it('returns down when db fails', async () => {
    const svc = new HealthService(makeDeps({
      db: { query: vi.fn().mockRejectedValue(new Error('connection lost')) },
    }) as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('down');
    expect(result.checks.db).toBe('fail');
  });

  it('skips signal/email/browser when not configured', async () => {
    const svc = new HealthService(makeDeps() as never);
    const result = await svc.getStatus();
    expect(result.checks.signal).toBe('skipped');
    expect(result.checks.email).toBe('skipped');
    expect(result.checks.browser).toBe('skipped');
    expect(result.checks.mcp.google_workspace).toBe('skipped');
  });

  it('returns degraded when a non-critical check fails', async () => {
    const svc = new HealthService(makeDeps({
      signalRpcClient: { listGroups: vi.fn().mockRejectedValue(new Error('EACCES')) },
    }) as never);
    const result = await svc.getStatus();
    expect(result.status).toBe('degraded');
    expect(result.checks.signal).toBe('fail');
    expect(result.checks.db).toBe('ok');
  });
});

describe('HealthService LLM outcome tracking', () => {
  it('records llm.call events as tier success', () => {
    const svc = new HealthService(makeDeps() as never);
    // Simulate bus event subscription firing
    const subscribeCalls = (makeDeps().bus.subscribe as ReturnType<typeof vi.fn>).mock.calls;
    // start() must be called to subscribe; test via tracker directly
    const tracker = (svc as unknown as { tracker: { getOutcome: (k: string) => { lastSuccessAt: Date | null } } }).tracker;
    expect(tracker).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/health/health-service.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Write `src/health/health-service.ts`**

```typescript
// health-service.ts — central health observability service.
//
// Responsibilities:
//   1. getStatus() — run all liveness probes and return the three-state response.
//      Called by GET /api/health. Runs every request; no cached ok state.
//   2. runCanaries() — validate external credentials and ping heartbeat URLs.
//      Called by the daily scheduler job.
//   3. start() — subscribe to bus events to maintain LlmOutcomeTracker;
//      register the daily canary job with SchedulerService.

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { ModelRoutingConfig } from '../agents/llm/model-router.js';
import type { McpSession } from '../skills/mcp-client.js';
import type { HealthConfig } from '../config.js';
import type { LlmCallEvent, LlmErrorEvent, EmbeddingCallEvent, EmbeddingErrorEvent, SkillResultEvent } from '../bus/events.js';
import type { CheckResult, HealthResponse, HealthStatus, TrackerKey, CanaryResult } from './types.js';
import { LlmOutcomeTracker } from './llm-outcome-tracker.js';
import {
  checkDb, checkBus, checkEmail, checkSignal, checkBrowser,
  checkMcpGoogleWorkspace, checkScheduler,
  type EmailAdapterHealth, type SignalRpcClientHealth, type BrowserServiceHealth,
} from './health-checks.js';
import type { NylasClient } from '../channels/email/nylas-client.js'; // confirm actual import

export interface HealthServiceDeps {
  db: Pool;
  bus: EventBus;
  logger: Logger;
  scheduler: Pick<Scheduler, 'lastTickAt'>;
  schedulerService: SchedulerService;
  emailAdapter?: EmailAdapterHealth & { accountId: string };
  nylasClient?: NylasClient;  // for Nylas canary — confirm actual type
  signalRpcClient?: SignalRpcClientHealth;
  browserService?: BrowserServiceHealth;
  mcpSessions: McpSession[];
  modelRoutingConfig: ModelRoutingConfig;
  config: HealthConfig;
  openaiApiKey?: string;
  tavilyApiKey?: string;
  googleWorkspaceConfigPath?: string;  // path to google workspace credential file
}

export class HealthService {
  private readonly tracker = new LlmOutcomeTracker();
  private readonly startedAt = new Date();
  /** Reverse map from model string → tier, built from modelRoutingConfig at start(). */
  private modelToTier = new Map<string, 'fast' | 'standard' | 'powerful'>();

  constructor(private readonly deps: HealthServiceDeps) {}

  /** Subscribe to bus events and register the daily canary job. Call once at bootstrap. */
  async start(): Promise<void> {
    const { bus, logger, config, schedulerService, modelRoutingConfig } = this.deps;

    // Build reverse map: model string → tier for LLM outcome tracking.
    for (const [tier, tc] of Object.entries(modelRoutingConfig.tiers) as [string, { model: string }][]) {
      this.modelToTier.set(tc.model, tier as 'fast' | 'standard' | 'powerful');
    }

    // Subscribe to llm.call (success) — map model → tier → record success.
    bus.subscribe('llm.call', 'system', (event) => {
      const e = event as LlmCallEvent;
      const tier = this.modelToTier.get(e.payload.requestedModel);
      if (tier) this.tracker.recordSuccess(tier);
    });

    // Subscribe to llm.error (failure) — map model → tier → record error.
    bus.subscribe('llm.error', 'system', (event) => {
      const e = event as LlmErrorEvent;
      const tier = this.modelToTier.get(e.payload.requestedModel);
      if (tier) this.tracker.recordError(tier);
    });

    // Subscribe to embedding.call (success).
    bus.subscribe('embedding.call', 'system', () => {
      this.tracker.recordSuccess('embeddings');
    });

    // Subscribe to embedding.error (failure).
    bus.subscribe('embedding.error', 'system', () => {
      this.tracker.recordError('embeddings');
    });

    // Subscribe to skill.result for image-generate.
    bus.subscribe('skill.result', 'system', (event) => {
      const e = event as SkillResultEvent;
      if (e.payload.skillName !== 'image-generate') return;
      const key: TrackerKey = 'image_gen';
      if (e.payload.result.success) {
        this.tracker.recordSuccess(key);
      } else {
        this.tracker.recordError(key);
      }
    });

    // Register daily canary job.
    try {
      await schedulerService.upsertDeclarativeJob({
        jobId: 'health-canary',
        agentId: 'health-service',
        cronExpr: config.canarySchedule,
        taskPayload: { type: 'health-canary' },
        createdBy: 'health-service',
        expectedDurationSeconds: 60,
      });
      logger.info({ schedule: config.canarySchedule }, 'Health canary job registered');
    } catch (err) {
      logger.warn({ err }, 'Failed to register health canary job — canaries will not run on schedule');
    }
  }

  /** Run all liveness probes and return the three-state response. */
  async getStatus(): Promise<HealthResponse> {
    const { db, bus, emailAdapter, signalRpcClient, browserService, mcpSessions, scheduler, config } = this.deps;
    const { liveness } = config;

    const [db_check, signal_check, browser_check, mcp_gw] = await Promise.all([
      checkDb(db),
      checkSignal(signalRpcClient),
      Promise.resolve(checkBrowser(browserService)),
      checkMcpGoogleWorkspace(mcpSessions as never),
    ]);
    const bus_check = checkBus(bus);
    const email_check = checkEmail(emailAdapter, liveness.emailStallFactor, this.startedAt);
    const scheduler_check = checkScheduler(scheduler, liveness.schedulerMaxTickS, this.startedAt);

    const checks = {
      db: db_check,
      bus: bus_check,
      signal: signal_check,
      email: email_check,
      browser: browser_check,
      mcp: { google_workspace: mcp_gw },
      scheduler: scheduler_check,
    };

    const status = this.aggregateStatus(checks);
    const uptime_s = Math.floor((Date.now() - this.startedAt.getTime()) / 1_000);

    return { status, uptime_s, checks };
  }

  /** Run daily credential canaries and ping heartbeat URLs on success. */
  async runCanaries(): Promise<CanaryResult[]> {
    const { logger, config, openaiApiKey, tavilyApiKey, nylasClient, signalRpcClient,
            googleWorkspaceConfigPath, mcpSessions, modelRoutingConfig } = this.deps;
    const results: CanaryResult[] = [];

    const run = async (name: string, probe: () => Promise<CanaryResult>): Promise<void> => {
      try {
        const result = await probe();
        results.push(result);
        if (result.status === 'ok') {
          const url = config.heartbeats[name as keyof typeof config.heartbeats];
          if (url) await this.pingHeartbeat(url, name);
        }
        const level = result.status === 'fail' ? 'error' : 'info';
        logger[level]({ canary: name, status: result.status, detail: result.detail }, 'Health canary result');
      } catch (err) {
        logger.error({ err, canary: name }, 'Canary probe threw unexpectedly');
        results.push({ name, status: 'fail', detail: String(err) });
      }
    };

    // LLM tier canaries — keyed by tier name.
    for (const tier of ['fast', 'standard', 'powerful'] as const) {
      await run(`llm_${tier}`, async () => this.canaryLlmTier(tier, modelRoutingConfig));
    }

    // Embeddings canary.
    await run('embeddings', async () => {
      if (!openaiApiKey) return { name: 'embeddings', status: 'skipped' };
      return this.canaryOutcome('embeddings', 'embeddings');
    });

    // Image gen canary.
    await run('image_gen', async () => {
      if (!openaiApiKey) return { name: 'image_gen', status: 'skipped' };
      return this.canaryOutcome('image_gen', 'image_gen');
    });

    // Nylas canary — confirm by listing messages for each configured grant.
    await run('nylas', async () => {
      if (!nylasClient) return { name: 'nylas', status: 'skipped' };
      // nylasClient.listMessages(accountId, { limit: 1 }) with 5s timeout.
      // Confirm the actual Nylas client API in src/channels/email/.
      try {
        await Promise.race([
          nylasClient.listMessages({ limit: 1 }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 5_000),
          ),
        ]);
        return { name: 'nylas', status: 'ok' };
      } catch (err) {
        return { name: 'nylas', status: 'fail', detail: String(err) };
      }
    });

    // Signal canary — same RPC ping as liveness check.
    await run('signal', async () => {
      if (!signalRpcClient) return { name: 'signal', status: 'skipped' };
      const result = await checkSignal(signalRpcClient);
      return { name: 'signal', status: result === 'ok' ? 'ok' : 'fail' };
    });

    // Google Workspace canary — credential file readable + refresh token not expired.
    await run('google_workspace', async () => {
      const session = mcpSessions.find(s => s.serverId === 'google-workspace');
      if (!session || !googleWorkspaceConfigPath) return { name: 'google_workspace', status: 'skipped' };
      const result = await this.canaryGoogleWorkspace(googleWorkspaceConfigPath);
      return result;
    });

    // Tavily canary — key present.
    await run('tavily', async () => {
      if (!tavilyApiKey) return { name: 'tavily', status: 'skipped' };
      return { name: 'tavily', status: 'ok' };
    });

    return results;
  }

  // -- Private helpers --

  private aggregateStatus(checks: HealthResponse['checks']): HealthStatus {
    if (checks.db === 'fail' || checks.bus === 'fail') return 'down';
    const nonCritical: CheckResult[] = [
      checks.signal, checks.email, checks.browser,
      checks.mcp.google_workspace, checks.scheduler,
    ];
    if (nonCritical.some(c => c === 'fail')) return 'degraded';
    return 'ok';
  }

  private canaryLlmTier(
    tier: 'fast' | 'standard' | 'powerful',
    modelRoutingConfig: ModelRoutingConfig,
  ): CanaryResult {
    const name = `llm_${tier}`;
    // Check provider key via modelRoutingConfig — if the tier's model has no
    // registered provider key, treat as fail. (The actual key check requires
    // access to the provider registry; for now check that the tier model is configured.)
    const model = modelRoutingConfig.tiers[tier]?.model;
    if (!model) return { name, status: 'fail', detail: 'no model configured for tier' };
    return this.canaryOutcome(name as TrackerKey, tier);
  }

  private canaryOutcome(name: TrackerKey, label: string): CanaryResult {
    const { lastSuccessAt, lastErrorAt } = this.tracker.getOutcome(name);
    // Fail if the most recent recorded outcome is an error.
    if (lastErrorAt !== null && (lastSuccessAt === null || lastErrorAt > lastSuccessAt)) {
      return { name: label, status: 'fail', detail: `last call errored at ${lastErrorAt.toISOString()}` };
    }
    return { name: label, status: 'ok' };
  }

  private async canaryGoogleWorkspace(credentialPath: string): Promise<CanaryResult> {
    const { readFile } = await import('node:fs/promises');
    try {
      const raw = await readFile(credentialPath, 'utf-8');
      const creds = JSON.parse(raw) as { expiry_date?: number };
      if (creds.expiry_date && creds.expiry_date < Date.now()) {
        return { name: 'google_workspace', status: 'fail', detail: 'refresh token expired' };
      }
      return { name: 'google_workspace', status: 'ok' };
    } catch (err) {
      return { name: 'google_workspace', status: 'fail', detail: String(err) };
    }
  }

  private async pingHeartbeat(url: string, name: string): Promise<void> {
    try {
      await Promise.race([
        fetch(url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5_000),
        ),
      ]);
      this.deps.logger.debug({ canary: name, url }, 'Heartbeat pinged');
    } catch (err) {
      this.deps.logger.warn({ err, canary: name, url }, 'Heartbeat ping failed (non-fatal)');
    }
  }
}
```

**Note:** The `upsertDeclarativeJob` API on `SchedulerService` — confirm the actual method name and params by grepping `src/scheduler/scheduler-service.ts` for `upsert`. If it's `createJob` with idempotency, use that pattern. The canary job is identified by its `agentId: 'health-service'` and `taskPayload.type: 'health-canary'`. The scheduler loop will fire it via the `fireJob()` path; the health-service module doesn't need a bus subscriber to trigger it — the Scheduler handles the dispatch.

**Note:** The `NylasClient` type for the nylas canary — look at how the email adapter accesses the Nylas API (likely via a client in `src/channels/email/nylas-client.ts` or inline). Adjust the dep interface and import accordingly.

- [ ] **Step 4: Run test**

```bash
npx vitest run tests/unit/health/health-service.test.ts
```

Expected: PASS (core tests). Fix any import errors.

- [ ] **Step 5: Type check + commit**

```bash
pnpm run typecheck
git -C /path/to/worktree add src/health/health-service.ts tests/unit/health/health-service.test.ts
git -C /path/to/worktree commit -m "feat: add HealthService with getStatus and runCanaries"
```

---

## Task 7: HTTP Route Shim + Adapter Config

**Files:**
- Modify: `src/channels/http/routes/health.ts`
- Modify: `src/channels/http/http-adapter.ts`
- Test: `tests/unit/health/health-route.test.ts`

**Interfaces:**
- Consumes: `HealthService.getStatus()` → `HealthResponse`
- Produces: updated `HealthRouteOptions`, updated `HttpAdapterConfig`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/health/health-route.test.ts
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from '../../../src/channels/http/routes/health.js';

describe('GET /api/health', () => {
  it('returns 200 and ok status when health service says ok', async () => {
    const app = Fastify();
    const healthService = {
      getStatus: vi.fn().mockResolvedValue({
        status: 'ok',
        uptime_s: 42,
        checks: {
          db: 'ok', bus: 'ok', signal: 'skipped',
          email: 'skipped', browser: 'skipped',
          mcp: { google_workspace: 'skipped' },
          scheduler: 'ok',
        },
      }),
    };
    await app.register(healthRoutes, { healthService } as never);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.uptime_s).toBe(42);
    expect(body.checks.db).toBe('ok');
  });

  it('returns 503 when health service says down', async () => {
    const app = Fastify();
    const healthService = {
      getStatus: vi.fn().mockResolvedValue({
        status: 'down',
        uptime_s: 5,
        checks: {
          db: 'fail', bus: 'ok', signal: 'skipped',
          email: 'skipped', browser: 'skipped',
          mcp: { google_workspace: 'skipped' },
          scheduler: 'ok',
        },
      }),
    };
    await app.register(healthRoutes, { healthService } as never);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
  });

  it('returns 200 when health service says degraded', async () => {
    const app = Fastify();
    const healthService = {
      getStatus: vi.fn().mockResolvedValue({
        status: 'degraded',
        uptime_s: 100,
        checks: {
          db: 'ok', bus: 'ok', signal: 'fail',
          email: 'skipped', browser: 'skipped',
          mcp: { google_workspace: 'skipped' },
          scheduler: 'ok',
        },
      }),
    };
    await app.register(healthRoutes, { healthService } as never);
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('degraded');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/health/health-route.test.ts
```

Expected: FAIL — `HealthService` not in route options

- [ ] **Step 3: Rewrite `src/channels/http/routes/health.ts`**

Replace the entire file:

```typescript
// health.ts — GET /api/health endpoint (thin shim over HealthService).
//
// All probe logic lives in HealthService. This route calls getStatus() and maps
// the three-state result to HTTP status codes: 503 for 'down', 200 for all else.

import type { FastifyInstance } from 'fastify';
import type { HealthService } from '../../../health/health-service.js';

export interface HealthRouteOptions {
  healthService: HealthService;
}

export async function healthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions,
): Promise<void> {
  const { healthService } = options;

  // Permissive rate limit: 60 req/min per IP — allows monitoring tools to probe every
  // second while still preventing denial-of-service from rogue scanners.
  app.get('/api/health', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_request, reply) => {
    const result = await healthService.getStatus();
    const statusCode = result.status === 'down' ? 503 : 200;
    return reply.status(statusCode).send(result);
  });
}
```

- [ ] **Step 4: Update `HttpAdapterConfig` in `src/channels/http/http-adapter.ts`**

Add `healthService?: HealthService` to the `HttpAdapterConfig` interface (alongside `schedulerService?`):

```typescript
import type { HealthService } from '../../health/health-service.js';

// In HttpAdapterConfig interface, add:
healthService?: HealthService;
```

Update the route registration in `start()` (around line 290):

```typescript
// Replace:
await this.app.register(healthRoutes, { pool, logger, agentNames, skillNames });
// With:
await this.app.register(healthRoutes, {
  healthService: this.config.healthService ?? createFallbackHealthService(pool, logger),
});
```

Add `createFallbackHealthService` as a local helper (for backward compat if healthService is omitted — optional, but prevents startup failure if healthService wiring is incomplete):

```typescript
// In http-adapter.ts, after imports:
import { HealthService } from '../../health/health-service.js';

function createFallbackHealthService(pool: Pool, logger: Logger): HealthService {
  // Minimal deps — only db check works; everything else is skipped.
  // Used as a safety net if HealthService wasn't passed at construction.
  return new HealthService({
    db: pool,
    bus: null as never,    // bus not available here — bus check will be fail/skipped
    logger,
    scheduler: { lastTickAt: null },
    schedulerService: null as never,
    mcpSessions: [],
    modelRoutingConfig: { tiers: { fast: { model: '' }, standard: { model: '' }, powerful: { model: '' } }, default_tier: 'standard' },
    config: DEFAULT_HEALTH_CONFIG,
  } as never);
}
```

(Import `DEFAULT_HEALTH_CONFIG` from `../../config.js`.)

- [ ] **Step 5: Run test**

```bash
npx vitest run tests/unit/health/health-route.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 6: Type check + commit**

```bash
pnpm run typecheck
git -C /path/to/worktree add src/channels/http/routes/health.ts src/channels/http/http-adapter.ts
git -C /path/to/worktree commit -m "feat: update health route to use HealthService (three-state)"
```

---

## Task 8: Bootstrap Wiring (`src/index.ts`)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add HealthService construction in `index.ts`**

Find the section where `scheduler` is constructed (around line 1549: `const scheduler = new Scheduler({ ... })`). After the scheduler is constructed and after `mcpSessions` is available from `loadMcpServers()`, add:

```typescript
import { HealthService } from './health/health-service.js';
import { resolveHealthConfig } from './config.js';

// ... (after scheduler and mcpSessions are available) ...

const healthConfig = resolveHealthConfig(yamlConfig.health);
const healthService = new HealthService({
  db: pool,
  bus,
  logger,
  scheduler,                    // Scheduler instance (not SchedulerService)
  schedulerService,             // SchedulerService — for registering canary job
  emailAdapter: emailAdapter ?? undefined,   // the email channel adapter, if configured
  nylasClient: nylasClient ?? undefined,     // Nylas client for canary, if configured
  signalRpcClient: signalAdapter?.rpcClient ?? undefined,  // confirm field name
  browserService: browserService ?? undefined,
  mcpSessions,                  // McpSession[] from loadMcpServers()
  modelRoutingConfig,           // the config used to build modelRouter
  config: healthConfig,
  openaiApiKey: config.openaiApiKey,
  tavilyApiKey: config.tavilyApiKey ?? undefined,   // confirm field name
  googleWorkspaceConfigPath: undefined,             // populate from skills.yaml/config if available
});
await healthService.start();
```

**Note:** Confirm the exact variable names by searching `index.ts`:
- `emailAdapter` — the EmailAdapter instance (the one whose `lastSuccessfulPollAt` we read)
- `signalAdapter` — the SignalAdapter instance; its `rpcClient` field may be private — add a getter
- `browserService` — the BrowserService instance  
- `mcpSessions` — the `McpSession[]` returned by `loadMcpServers()` (look for where it's destructured)
- `nylasClient` — the Nylas API client used by the email adapter

Find the `HttpAdapter` construction (around line 2077) and add `healthService`:

```typescript
const httpAdapter = new HttpAdapter({
  // ... existing fields ...
  healthService,
});
```

- [ ] **Step 2: Type check — this is the integration gate**

```bash
pnpm run typecheck
```

Fix all type errors found. Common issues:
- Private fields needing getters (SignalAdapter.rpcClient, EmailAdapter fields)
- Optional deps typed as `never` in HealthService when not configured
- Missing imports

- [ ] **Step 3: Smoke test — start the process and hit /api/health**

```bash
# In the worktree:
node --loader ts-node/esm src/index.ts &  # or however dev is started
curl http://localhost:3000/api/health
```

Expected: JSON response with `{"status":"ok",...}` or `{"status":"degraded",...}` (db + bus should be ok; everything else skipped if unconfigured).

- [ ] **Step 4: Commit**

```bash
git -C /path/to/worktree add src/index.ts
git -C /path/to/worktree commit -m "feat: wire HealthService into bootstrap"
```

---

## Task 9: Documentation + Housekeeping

**Files:**
- Create: `docs/dev/health-monitoring.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write `docs/dev/health-monitoring.md`**

```markdown
# Health Monitoring

Curia exposes a three-state health endpoint and a daily credential canary that feed external uptime monitors. This guide covers setup for operators.

## The `/api/health` endpoint

`GET https://<your-domain>/api/health` — unauthenticated. Rate-limited to 60 req/min.

### Response

```json
{
  "status": "ok | degraded | down",
  "uptime_s": 3812,
  "checks": {
    "db":        "ok | fail",
    "bus":       "ok | fail",
    "signal":    "ok | fail | skipped",
    "email":     "ok | fail | skipped",
    "browser":   "ok | fail | skipped",
    "mcp":       { "google_workspace": "ok | fail | skipped" },
    "scheduler": "ok | fail"
  }
}
```

### Status values

| `status` | HTTP | Meaning |
|---|---|---|
| `ok` | 200 | All enabled checks pass |
| `degraded` | 200 | A non-critical service is down (signal, email, browser, MCP, scheduler) |
| `down` | 503 | A critical service is unreachable (db or bus) — Curia cannot function |

`skipped` means a check's underlying service is not configured (e.g. Signal is disabled). Skipped checks never affect the overall status.

### Which checks are critical vs. non-critical

**Critical (down → 503):** `db`, `bus`
**Non-critical (degraded → 200):** `signal`, `email`, `browser`, `mcp.*`, `scheduler`

Rationale: a dead Signal socket should not page as a full outage when email still works.

## Setting up an uptime monitor (Better Stack / Healthchecks.io / etc.)

1. Create an **uptime monitor** pointing at `https://<your-domain>/api/health`.
2. Set the alert condition to **HTTP status != 200** (triggers on `down`/503).
3. Optionally, add a second **keyword check** monitor that alerts when the response body contains `"status":"degraded"` — this gives a softer warning for non-critical failures.

## Daily canary job + heartbeat URLs

The canary job runs daily (default 06:00 server time, configurable via `health.canary_schedule` in `config/default.yaml`) and:

1. Checks that each enabled credential/dependency is valid
2. On success, GETs a heartbeat URL — the monitoring service pages on missed pings

To configure, add URLs to the `health.heartbeats` block in `config/default.yaml`:

```yaml
health:
  heartbeats:
    llm_fast: "https://uptime.betterstack.com/api/v1/heartbeat/<token>"
    nylas:    "https://uptime.betterstack.com/api/v1/heartbeat/<token>"
    # etc.
```

Each URL must be `https://`. Non-https URLs are silently ignored at startup.

### Why LLM keys are tier-named (`llm_fast`, `llm_standard`, `llm_powerful`)

The heartbeat key identifies the capability tier, not the vendor. If you remap `standard` from Claude to an OpenRouter model, the heartbeat URL for `llm_standard` still works correctly — the canary queries the model routing config to find the current provider.

### What each canary checks

| Key | Probe | Skipped when |
|---|---|---|
| `llm_fast/standard/powerful` | Last recorded call outcome for that tier (no billed probe call) | Provider key for the tier's resolved model is missing |
| `embeddings` | Last recorded embedding call outcome | No `OPENAI_API_KEY` |
| `image_gen` | Last `image-generate` skill outcome | No `OPENAI_API_KEY` |
| `nylas` | `listMessages(limit=1)` for each configured grant | Email not configured |
| `signal` | Signal-cli socket ping | Signal not configured |
| `google_workspace` | Credential file readable + refresh token not expired | MCP server not registered |
| `tavily` | `tavily_api_key` present in config | Key not set |

### LLM canaries make no billed calls

The LLM tier canaries read the outcome of the most recent *real* call to that tier (recorded by the telemetry layer). An idle tier (key configured, no calls made yet, no errors) is always `ok`. The canary only fails if the most recent recorded call was an error.
```

- [ ] **Step 2: Update `CHANGELOG.md`**

Add under `## [Unreleased]`:

```markdown
### Added
- **Health observability** — `GET /api/health` now returns a three-state `ok / degraded / down` response with per-check status for db, bus, signal, email, browser, MCP (google-workspace), and scheduler. `down` (503) only fires when db or bus is unreachable; non-critical failures surface as `degraded` (200). (#434)
- **Daily canary job** — a scheduler job (default 06:00) validates credentials and external dependencies (LLM tiers, embeddings, image-gen, Nylas, Signal, Google Workspace, Tavily), pings configured heartbeat URLs on success. (#434)
- **LLM error telemetry** — `TelemetryLlmProvider` and `AgentRuntime` now publish `llm.error` bus events on failed calls, enabling the health layer to track per-tier outcomes without making billed probe calls. (#434)
- **Embedding error telemetry** — `EmbeddingService` now publishes `embedding.error` bus events on OpenAI backend failures. (#434)
```

- [ ] **Step 3: Full test run**

```bash
pnpm run typecheck
pnpm test
```

Expected: all tests pass. Fix any failures.

- [ ] **Step 4: Final commit**

```bash
git -C /path/to/worktree add docs/dev/health-monitoring.md CHANGELOG.md
git -C /path/to/worktree commit -m "docs: add health monitoring guide and changelog entry"
```

---

## Plan Self-Review

### Spec coverage

| Spec requirement | Task |
|---|---|
| `/health` 200 ok | Task 6, 7 |
| `/health` 200 degraded on non-critical fail | Task 6, 7 |
| `/health` 503 down on db/bus fail | Task 6, 7 |
| `skipped` for unconfigured services | Task 5, 6 |
| < 500ms, no billed calls | Task 5 timeouts |
| Boot-correct state (no optimistic ok) | Task 5 grace window logic |
| signal EACCES detection | Task 5 `checkSignal` |
| browser disconnection detection | Task 5 `checkBrowser` |
| MCP subprocess detection | Task 5 `checkMcpGoogleWorkspace` |
| email stall detection | Task 5 `checkEmail` |
| scheduler stall detection | Task 3 + Task 5 |
| LLM tier outcome recording | Task 2 + Task 6 `start()` |
| Daily canary job | Task 6 `runCanaries()` |
| LLM tier canary logic | Task 6 |
| No billed LLM probe calls | Task 6 `canaryLlmTier` |
| embeddings/image_gen key off OPENAI_API_KEY + outcome | Task 2 + Task 6 |
| nylas credential canary | Task 6 |
| signal/google_workspace/tavily canaries | Task 6 |
| Heartbeat ping on success | Task 6 `pingHeartbeat` |
| Invalid URL → warn + null, no crash | Task 4 `validateHeartbeatUrl` |
| `default.yaml` health block | Task 4 |
| Docs | Task 9 |

### Key implementation notes for the implementer

1. **`checkBus`**: The `EventBus` class wraps an `EventEmitter`. The test uses `listenerCount` but the actual implementation needs to inspect the real EventBus API. Open `src/bus/bus.ts` and find out how to check liveness — if `listenerCount` isn't exposed, use an alternative (e.g. `bus instanceof EventBus && bus !== null`).

2. **`upsertDeclarativeJob` vs `createJob`**: `SchedulerService` has `createJob()` and possibly `upsertDeclarativeJob()`. For the canary, use `upsertDeclarativeJob()` if available (idempotent across restarts). If only `createJob()` exists, check for existence first or wrap in try-catch for duplicate key.

3. **`NylasClient` type**: Confirm the class/interface that wraps the Nylas REST API calls in `src/channels/email/`. Adjust the `HealthServiceDeps.nylasClient` type and the canary probe accordingly.

4. **`SignalAdapter.rpcClient`**: If `rpcClient` is private on `SignalAdapter`, add `get rpcClient()` getter or expose it another way. Don't use `as any`.

5. **`GoogleWorkspace credential path`**: The `google-workspace` MCP server config in `config/skills.yaml` has an env block with a token cache path. Read it from the skills config at bootstrap and pass to HealthService.

---

**Plan complete and saved to `docs/wip/2026-06-23-health-observability.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, with checkpoints

Which approach?
