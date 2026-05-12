# Implementation Plan: Per-Call LLM Token Tracking (Issue #326)

**Branch:** `feat/llm-token-tracking`
**Date:** 2026-05-12
**Issue:** josephfung/curia#326

---

## Goal

Wire the existing (but never-called) `createLlmCall` factory so that a structured `llm.call` bus event is published after every Anthropic API call. This lands in `audit_log` automatically via the existing audit logger, providing per-agent token attribution as the baseline for data-driven context budgeting (#24).

Simultaneously:
- Capture cache tokens (`cache_creation_input_tokens`, `cache_read_input_tokens`) which are currently silently dropped
- Populate the full `LlmCallPayload` spec including `estimatedCostUsd`, `latencyMs`, `providerRequestId`, `promptHash`, `responseHash`

No new DB table is needed — the `audit_log` (JSONB) plus enriched structured log lines are sufficient.

---

## Architecture Decision

**Approach: Enrich `LLMResponse` with call provenance**

Three fields are only available inside `AnthropicProvider.chat()` but needed by the runtime for event publishing:
- `requestedModel` — the model string resolved at the start of `chat()`
- `actualModel` — from `response.model` in the API response body
- `providerRequestId` — from `response.id` (the `msg_xxx` identifier Anthropic shows in their console)

Solution: add a new `LLMCallProvenance` interface to `provider.ts` and attach it as a required `provenance` field on the `text` and `tool_use` response variants. The runtime then uses this plus its own context (timing, agentId, conversationId, bus) to build and publish the event.

Rejected alternatives:
- **Separate return type** (`LLMChatResult`): large blast radius — every `response.type`, `response.usage`, `response.content` read in `runtime.ts` would need updating.
- **Callback pattern** (`onCallComplete`): provider fires a callback from inside `chat()`, violating the layer boundary (provider would implicitly participate in bus publishing).

---

## Step-by-Step Plan

### Step 1 — Extend `LLMUsage` and add `LLMCallProvenance` in `provider.ts`

File: `src/agents/llm/provider.ts`

Changes:
1. Add cache fields to `LLMUsage`:
   ```ts
   export interface LLMUsage {
     inputTokens: number;
     outputTokens: number;
     cacheCreationInputTokens: number;  // 0 when not applicable
     cacheReadInputTokens: number;       // 0 when not applicable
   }
   ```
2. Add new interface:
   ```ts
   /** Provider-level metadata returned alongside every successful LLM response. */
   export interface LLMCallProvenance {
     requestedModel: string;   // model string passed to the provider (requested by caller)
     actualModel: string;      // model that actually ran (from API response body)
     providerRequestId: string; // Anthropic: response.id (msg_xxx); used for support correlation
   }
   ```
3. Add `provenance: LLMCallProvenance` to the `text` and `tool_use` variants in `LLMResponse`:
   ```ts
   export type LLMResponse =
     | { type: 'text'; content: string; usage: LLMUsage; provenance: LLMCallProvenance }
     | { type: 'tool_use'; toolCalls: ToolCall[]; content?: string; usage: LLMUsage; provenance: LLMCallProvenance }
     | { type: 'error'; error: AgentError; usage?: LLMUsage };
   ```
   Error paths don't include provenance — when the API fails (timeout, network error), there's no response body to extract these from.

**Why cache fields are `number` not `number | null`:** The `LlmCallPayload` spec defines them as `number`. Zero is semantically correct for non-caching calls — no tokens were served from cache.

---

### Step 2 — Populate provenance and cache tokens in `anthropic.ts`

File: `src/agents/llm/anthropic.ts`

Changes:
1. After the successful API response (`const response = await this.client.messages.create(...)`), build provenance:
   ```ts
   const provenance: LLMCallProvenance = {
     requestedModel: model,            // local const resolved at top of chat()
     actualModel: response.model,      // from response body
     providerRequestId: response.id,   // msg_xxx identifier
   };
   ```
2. Extend the `LLMUsage` construction (current lines 157–160) to include cache fields:
   ```ts
   const usage: LLMUsage = {
     inputTokens: response.usage.input_tokens,
     outputTokens: response.usage.output_tokens,
     cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
     cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
   };
   ```
3. Enrich the existing debug log (lines 147–155) to include cache fields:
   ```ts
   this.logger.debug(
     {
       model,
       inputTokens: response.usage.input_tokens,
       outputTokens: response.usage.output_tokens,
       cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
       cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
       stopReason: response.stop_reason,
     },
     'Anthropic API call completed',
   );
   ```
4. Add `provenance` to both return paths:
   - `tool_use` return: add `provenance` field
   - `text` return: add `provenance` field
   - `error` catch path: unchanged (no provenance)

---

### Step 3 — Create `src/agents/llm/pricing.ts`

New file: `src/agents/llm/pricing.ts`

Responsibilities:
- Define per-model pricing ($ per million tokens)
- Export `estimateCostUsd(actualModel: string, usage: LLMUsage): number`

Pricing data (as of 2026-05):
```
claude-opus-4-6:    $15.00/$75.00/$18.75/$1.50 per MTok (in/out/cache-create/cache-read)
claude-sonnet-4-6:  $3.00/$15.00/$3.75/$0.30 per MTok
claude-haiku-4-5:   $0.80/$4.00/$1.00/$0.08 per MTok
```

Lookup is by prefix-match on `actualModel` (handles minor version suffixes gracefully). Falls back to `claude-sonnet-4-6` pricing with a `warn` log when the model is unrecognized — never silently returns 0.

`estimateCostUsd` takes `LLMUsage` (which now has all four token fields) and returns a single `number` (full float precision, not rounded — callers round for display).

---

### Step 4 — Wire event publishing in `runtime.ts`

File: `src/agents/runtime.ts`

This is the core wiring step. All changes are inside `chatWithRetry()`.

Imports to add at top of file:
```ts
import { createHash } from 'node:crypto';
import { createLlmCall } from '../bus/events.js';
import { estimateCostUsd } from './llm/pricing.js';
```

In `chatWithRetry()`:

1. Add timing before the first `provider.chat()` call:
   ```ts
   const callStartMs = Date.now();
   const response = await provider.chat(params);
   const latencyMs = Date.now() - callStartMs;
   ```

2. Add a `publishLlmCallEvent` helper inline (or as a private method) that takes `(response, params, latencyMs, taskEvent)` and:
   - Returns early if `response.type === 'error'` (no provenance available)
   - Computes `promptHash` = SHA-256 of `JSON.stringify({ messages: params.messages, tools: params.tools ?? [] })`
   - Computes `responseHash`:
     - `text`: SHA-256 of `response.content`
     - `tool_use`: SHA-256 of `JSON.stringify(response.toolCalls)`
   - Calls `estimateCostUsd(response.provenance.actualModel, response.usage)`
   - Calls `createLlmCall({ agentId, conversationId: taskEvent.payload.conversationId, ...response.provenance, ...token fields, estimatedCostUsd, latencyMs, promptHash, responseHash, parentEventId: taskEvent.id })`
   - `await bus.publish('agent', event)`

3. Call the helper after the initial `provider.chat()` call succeeds (before returning).

4. Also call it in the retry loop after each successful retry attempt.

5. `bus` and `agentId` are destructured from `this.config` at the top of `chatWithRetry()`:
   ```ts
   const { agentId, bus, logger } = this.config;
   ```
   (Currently only `agentId` and `logger` are destructured here.)

**Note on error paths:** Failed attempts (responses of type `error`) do not emit `llm.call` events. A `// TODO: emit llm.call for error paths when spec 10 cost-on-failure policy is settled` comment marks the gap.

**Note on retry timing:** Each retry attempt resets `callStartMs` and measures its own `latencyMs`. The published event reflects the latency of the successful attempt, not the total time including wait periods.

---

### Step 5 — Tests

#### `src/agents/llm/anthropic.test.ts`

Additions:
- Extend mock API responses to include `id: 'msg_test_123'`, `model: 'claude-sonnet-4-6'`, and `usage.cache_creation_input_tokens: null`, `usage.cache_read_input_tokens: null`
- Add assertions on `result.provenance.actualModel`, `result.provenance.requestedModel`, `result.provenance.providerRequestId` for both `text` and `tool_use` response paths
- Add assertion that `result.usage.cacheCreationInputTokens === 0` when API returns `null`
- Add a test case where cache tokens are non-zero (e.g., `cache_creation_input_tokens: 1500`)

#### New `src/agents/llm/pricing.test.ts`

- `estimateCostUsd('claude-sonnet-4-6', { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 200, cacheReadInputTokens: 100 })` → expected value
- `estimateCostUsd('claude-opus-4-6', ...)` → expected value
- `estimateCostUsd('claude-haiku-4-5-20251001', ...)` → matches haiku pricing (prefix match)
- `estimateCostUsd('unknown-model-xyz', ...)` → falls back to sonnet pricing, verify no crash

---

## Files Modified/Created

| File | Type | Description |
|------|------|-------------|
| `src/agents/llm/provider.ts` | Modified | Add `LLMCallProvenance`, extend `LLMUsage`, add `provenance` to response types |
| `src/agents/llm/anthropic.ts` | Modified | Populate cache tokens, build provenance, enrich debug log |
| `src/agents/llm/pricing.ts` | **New** | `ANTHROPIC_PRICING` map + `estimateCostUsd()` function |
| `src/agents/runtime.ts` | Modified | Timing, hash computation, `llm.call` event publishing in `chatWithRetry()` |
| `src/agents/llm/anthropic.test.ts` | Modified | Extend mocks to include new fields, add provenance assertions |
| `src/agents/llm/pricing.test.ts` | **New** | Unit tests for `estimateCostUsd` |

No DB migrations needed. No new bus event types or permission entries needed (`llm.call` is already in the agent layer's publish allowlist at `permissions.ts:30`).

---

## Acceptance Criteria

(From issue #326 + design decisions above)

- [ ] Every successful Anthropic API call (initial, tool-use continuation, recovery) publishes a `llm.call` bus event with a complete `LlmCallPayload`
- [ ] `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens` are all populated correctly (cache fields default to 0 when not applicable)
- [ ] `provider` field is `'anthropic'` (from `AnthropicProvider.id`)
- [ ] `requestedModel` and `actualModel` are populated from the provider; they may differ if Anthropic aliases the model
- [ ] `providerRequestId` is the `msg_xxx` body identifier from the API response
- [ ] `estimatedCostUsd` reflects all four token types weighted by model pricing
- [ ] `latencyMs` measures only the actual API call time, not retry wait periods
- [ ] `promptHash` and `responseHash` are stable SHA-256 hex digests
- [ ] `parentEventId` traces back to the `agent.task` event that triggered the LLM call
- [ ] Failed API calls (type `'error'`) do not publish an event (TODO comment left for spec 10)
- [ ] Existing debug log at `'Anthropic API call completed'` is enriched with cache token fields
- [ ] All existing tests pass
- [ ] New tests pass: provenance fields on text/tool_use paths, cache token zero-default, pricing function correctness
