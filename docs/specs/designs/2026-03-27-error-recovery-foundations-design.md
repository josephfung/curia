# Error Recovery Foundations — Design

**Date:** 2026-03-27
**Scope:** Tier A — AgentError types, error classification, error budgets, structured error injection, `agent.error` bus event
**Spec reference:** `docs/specs/05-error-recovery.md`

---

## Problem

Every review cycle has flagged error handling gaps. Today:

- The `AnthropicProvider` catches all errors and returns `{ type: 'error', error: string }` — no classification, no retry hint, no structure.
- The `AgentRuntime` has a catch-all error boundary that sends a generic "sorry" message. No budgets, no structured error context for the LLM, no audit trail.
- The bus has no `agent.error` event. Errors are invisible to dispatch and audit.
- Skill failures pass raw error strings to the LLM with no classification or attempt tracking.

## Design Decisions

1. **Errors are classified at the source, retried by the runtime.** Providers classify errors into `AgentError` with `retryable` flag. The runtime owns retry policy (backoff timing, attempt limits, budget accounting). This keeps providers simple and lets us add new providers or change retry strategy without touching classification logic.

2. **Error budgets track turns and consecutive errors, not cost.** Cost-based budgets (`max_cost_usd`) require a token pricing table — deferred. Turn and error limits prevent runaway loops, which is the immediate need.

3. **`agent.error` is a first-class bus event.** Gives audit structured error records and lets dispatch distinguish failures from normal responses.

4. **Error types live in `src/errors/`.** `AgentError` is cross-cutting (used by providers, runtime, bus, eventually skills) so it gets its own home rather than being wedged into a provider or bus file.

---

## 1. AgentError Type & ErrorType Union

**File:** `src/errors/types.ts`

```typescript
export type ErrorType =
  | 'AUTH_FAILURE'       // 401/403 — never retry, counts double against budget
  | 'RATE_LIMIT'         // 429 — retryable with backoff
  | 'TIMEOUT'            // request timeout, ETIMEDOUT
  | 'NOT_FOUND'          // 404, ENOENT
  | 'VALIDATION_ERROR'   // malformed input, schema violation
  | 'PROVIDER_ERROR'     // 5xx, upstream LLM failure
  | 'SKILL_ERROR'        // skill returned { success: false }
  | 'BUDGET_EXCEEDED'    // turn or error budget exhausted
  | 'UNKNOWN';           // fallback — something unexpected

export interface AgentError {
  type: ErrorType;
  source: string;           // e.g. 'anthropic', 'skill:email-send', 'runtime'
  message: string;          // human-readable, sanitized (max 400 chars, no injection vectors)
  retryable: boolean;       // deterministic from ErrorType
  context: Record<string, unknown>;  // structured metadata (status code, tool name, etc.)
  timestamp: Date;
}

export interface ErrorBudget {
  maxTurns: number;              // max LLM round-trips per task (default: 20)
  maxConsecutiveErrors: number;  // max consecutive errors before abort (default: 5)
  turnsUsed: number;
  consecutiveErrors: number;
}
```

### Retryable mapping

| ErrorType | retryable |
|-----------|-----------|
| AUTH_FAILURE | false |
| RATE_LIMIT | true |
| TIMEOUT | true |
| NOT_FOUND | false |
| VALIDATION_ERROR | false |
| PROVIDER_ERROR | true |
| SKILL_ERROR | false |
| BUDGET_EXCEEDED | false |
| UNKNOWN | false |

---

## 2. Error Classifier

**File:** `src/errors/classify.ts`

Single function: `classifyError(err: unknown, source: string): AgentError`

### Classification strategy

1. **Anthropic SDK errors** — check `err.status` for HTTP status codes:
   - 401, 403 → AUTH_FAILURE
   - 429 → RATE_LIMIT
   - 408 → TIMEOUT
   - 404 → NOT_FOUND
   - 400, 422 → VALIDATION_ERROR
   - 500, 502, 503, 529 → PROVIDER_ERROR

2. **Node.js system errors** — check `err.code`:
   - ETIMEDOUT, ESOCKETTIMEDOUT → TIMEOUT
   - ECONNREFUSED, ECONNRESET, ENOTFOUND → PROVIDER_ERROR
   - ENOENT → NOT_FOUND
   - EACCES, EPERM → AUTH_FAILURE

3. **Fallback** → UNKNOWN

### Sanitization

Reuses the existing `sanitizeOutput()` from `src/skills/sanitize.ts` for consistency. Before setting `message` on the AgentError:
- Truncate to 400 characters
- Strip XML/HTML tags (prevent injection into `<task_error>` blocks)
- Strip potential prompt injection patterns

### Skill error classification

A separate helper: `classifySkillError(skillName: string, error: string): AgentError`
- Source is set to `skill:<skillName>`
- Type is always `SKILL_ERROR`
- Message is the sanitized skill error string

---

## 3. Error Budget Enforcement

### Config source

From agent YAML (field already parsed by `loader.ts`):

```yaml
error_budget:
  max_turns: 20
  max_errors: 5
```

Defaults: `maxTurns: 20`, `maxConsecutiveErrors: 5`.

### AgentConfig change

```typescript
export interface AgentConfig {
  // ... existing fields ...
  errorBudget?: {
    maxTurns: number;
    maxConsecutiveErrors: number;
  };
}
```

### Runtime enforcement

In the tool-use loop (`processTask`):

- Every LLM round-trip increments `turnsUsed`
- Every error increments `consecutiveErrors` (AUTH_FAILURE increments by 2)
- A successful LLM response or successful skill result resets `consecutiveErrors` to 0
- When either limit is exceeded:
  1. Create a `BUDGET_EXCEEDED` AgentError
  2. Publish `agent.error` on the bus
  3. Send a user-facing response: "I wasn't able to complete that request — I've used too many attempts."
  4. Stop the loop

The current `MAX_TOOL_ITERATIONS` constant is replaced by budget-driven limits.

### Budget state

In-memory per task execution. Not persisted — persistence is future work (state continuity).

---

## 4. `agent.error` Bus Event

**Files:** `src/bus/events.ts`, `src/bus/permissions.ts`

### Payload

```typescript
interface AgentErrorPayload {
  agentId: string;
  conversationId: string;
  errorType: ErrorType;
  source: string;
  message: string;
  retryable: boolean;
  context: Record<string, unknown>;
}
```

### Event shape

```typescript
interface AgentErrorEvent extends BaseEvent {
  type: 'agent.error';
  sourceLayer: 'agent';
  payload: AgentErrorPayload;
}
```

### Integration

- Added to `BusEvent` discriminated union
- Factory: `createAgentError(payload)` — follows existing pattern
- Permissions: agent layer can publish `agent.error`
- Dispatch subscribes to `agent.error` and translates to `outbound.message` for the originating channel

---

## 5. Structured Error Injection into LLM History

When a skill fails during the tool-use loop, the `tool_result` content is formatted as a structured block instead of a raw error string:

```xml
<task_error>
  <tool>email-send</tool>
  <error_type>TIMEOUT</error_type>
  <message>Nylas API request timed out after 30s</message>
  <attempt>2 of 5</attempt>
</task_error>
```

This gives the LLM:
- The error classification (so it knows a TIMEOUT is different from AUTH_FAILURE)
- The attempt count (so it can decide whether retrying is worthwhile)
- A sanitized message (safe for prompt context)

The `<task_error>` block is a terminal leaf — no nested XML, no child tags.

> **TODO:** Evaluate TOON (Token-Oriented Object Notation) as a more token-efficient
> format for this and other structured LLM context blocks (sender context, authorization).
> TOON benchmarks at ~40% fewer tokens than JSON for flat structures. See [#55](https://github.com/josephfung/curia/issues/55).

### LLM call errors (mid-loop)

When `provider.chat()` fails during the tool-use loop and the runtime decides to retry, the error is injected as a system-content note in the messages array before the retry call. This gives the LLM context about the transient failure without polluting the tool_result flow:

```
[Previous LLM call failed: RATE_LIMIT — retrying (attempt 2 of 3)]
```

This is lightweight — just a bracketed note, not a full `<task_error>` block — since the LLM doesn't need to take action on transient retries.

---

## 6. Provider Changes

### LLMResponse update (`src/agents/llm/provider.ts`)

The error variant changes:

```typescript
// Before
{ type: 'error'; error: string }

// After
{ type: 'error'; error: AgentError }
```

### AnthropicProvider changes (`src/agents/llm/anthropic.ts`)

The catch block calls `classifyError(err, 'anthropic')` instead of extracting a raw message string. No retry logic — that's the runtime's job.

### Runtime retry logic

When `provider.chat()` returns `{ type: 'error' }`:

1. Check `error.retryable`
   - If `false` → stop, publish `agent.error`
   - If `true` → retry with backoff
2. Backoff schedule: `[1000, 5000, 15000]` ms (3 attempts max)
3. Each retry increments budget counters
4. If all retries exhausted → publish `agent.error`, send user-facing message

---

## 7. Dispatcher Changes

`src/dispatch/dispatcher.ts` subscribes to `agent.error`:

- Translates to an `outbound.message` for the originating channel
- Content is a user-appropriate message (not the raw error), e.g. "I ran into an issue and couldn't complete that request."
- The `agent.error` event still flows to the audit logger for structured error records

---

## Files Changed

| File | Change |
|------|--------|
| `src/errors/types.ts` | **New.** AgentError, ErrorType, ErrorBudget |
| `src/errors/classify.ts` | **New.** classifyError(), classifySkillError() |
| `src/bus/events.ts` | Add AgentErrorEvent, payload, factory, union |
| `src/bus/permissions.ts` | Allow agent layer to publish agent.error |
| `src/agents/llm/provider.ts` | LLMResponse error variant: string → AgentError |
| `src/agents/llm/anthropic.ts` | Use classifyError() in catch block |
| `src/agents/runtime.ts` | Error budgets, retry logic, structured injection, agent.error publishing |
| `src/agents/loader.ts` | Pipe error_budget config into AgentConfig |
| `src/dispatch/dispatcher.ts` | Subscribe to agent.error |

### Tests

| File | Coverage |
|------|----------|
| `src/errors/classify.test.ts` | Classification by HTTP status, system error codes, fallback; sanitization |
| `src/agents/runtime.test.ts` | Budget enforcement (turn limit, error limit, auth double-count, reset on success); retry backoff; structured error injection; agent.error publishing |

---

## Future Work (Tiers B & C)

These are explicitly deferred — not in scope for this pass:

- **Error Pattern Detection (Tier B)** — Per-task sliding window circuit breaker. Detects when the LLM keeps calling the same failing tool with similar args. Injects steering hints. The budget system handles runaway loops for now.
- **Cross-Task Error Learning (Tier C)** — `known_failures` table recording tool + error-type combinations that consistently fail. Warns agents before they hit known-broken tools.
- **Progress Extraction (Tier C)** — Summarize partial work before aborting a budget-exceeded task, so long-running tasks can resume from where they left off.
- **Retry Queue (Tier C)** — Disk-persisted failed tasks with exponential backoff for later retry. Requires state continuity infrastructure.
- **Cost-Based Budgets** — `max_cost_usd` in ErrorBudget. Requires token-to-dollar price table per model.
- **Error Budget Persistence** — Persist budget state to working memory for restart recovery.
- **Fallback Providers** — Retry on a different LLM provider when the primary fails. Requires multi-provider runtime support.
