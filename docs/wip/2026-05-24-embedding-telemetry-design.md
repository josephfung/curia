# Embedding Telemetry Design

**Issue:** josephfung/curia#654
**Date:** 2026-05-24
**Branch:** feat/embedding-telemetry

## Problem

`EmbeddingService` makes OpenAI API calls (`text-embedding-3-small`) for semantic search, entity resolution, fact deduplication, and similarity scoring. These calls are invisible to cost telemetry — no bus events are published, so their costs don't appear in the audit log. This is the same blind spot that #637 fixed for LLM calls, but for the embedding axis.

## Approach

**Option A selected:** Inject `EventBus` and `ModelRegistry` into `OpenAIBackend` directly. Token counts come from the OpenAI embeddings API response (`usage.prompt_tokens`), which is already returned but currently discarded. The backend is the natural publish site — telemetry fires right where the API call happens.

Not chosen: decorator wrapper (`TelemetryEmbeddingService`) — would require changing the `EmbeddingBackend` interface to surface token counts to the wrapper layer. More churn for no additional benefit given `EmbeddingBackend` is a private, two-implementation interface (not a public extensibility point like `LLMProvider`).

## Design

### 1. `embedding.call` event type (`src/bus/events.ts`)

New `EmbeddingCallPayload`:

```typescript
interface EmbeddingCallPayload {
  model: string;          // e.g. 'text-embedding-3-small'
  inputTokens: number;    // from API response usage.prompt_tokens
  estimatedCostUsd: number;
  latencyMs: number;
  inputTextLength: number; // character count — diagnostic for oversized inputs
}
```

`sourceLayer: 'system'` — embeddings are infrastructure, not agent-layer calls.

`parentEventId` is **optional** (unlike `llm.call` which requires it). Embedding calls fire from KG and validator paths that don't always have a task event ID.

Omitted vs `llm.call`:
- No `promptHash`/`responseHash` — content auditing isn't required, only cost tracking
- No `provider` field — hardcoded to OpenAI today; add when a second provider exists
- No `agentId`/`conversationId` — embeddings are infrastructure, not agent contexts

New factory:
```typescript
export function createEmbeddingCall(
  payload: EmbeddingCallPayload & { parentEventId?: string },
): EmbeddingCallEvent
```

`EmbeddingCallEvent` is added to the `BusEvent` discriminated union.

### 2. Model registry (`src/agents/llm/model-registry.ts`)

Add to `MODEL_REGISTRY`:

```typescript
'text-embedding-3-small': {
  provider: 'openai',
  contextWindow: 8191,
  pricing: {
    inputPerMToken: 0.02,  // $0.02/MTok — current OpenAI pricing
    outputPerMToken: 0,    // embeddings have no output tokens
  },
  capabilities: ['embedding'],
}
```

`ModelPricing` interface is unchanged. `outputPerMToken: 0` is factually correct — embeddings produce no billed output. `contextWindow` and `capabilities` satisfy the existing interface; neither is currently gated on for embedding paths.

### 3. `OpenAIBackend` changes (`src/memory/embedding.ts`)

`EmbeddingService.createWithOpenAI()` gains two optional parameters:

```typescript
static createWithOpenAI(
  apiKey: string,
  logger: Logger,
  bus?: EventBus,
  modelRegistry?: ModelRegistry,
): EmbeddingService
```

Optional so `createForTesting()` is unchanged and all existing test call sites compile without modification. In production (`src/index.ts`), both are always passed.

`OpenAIBackend` changes:
- Constructor stores `bus` and `modelRegistry` (both optional)
- JSON response type widened: `{ data: Array<{ embedding: number[] }>; usage: { prompt_tokens: number } }`
- `embed()` records `start = Date.now()` before fetch, computes `latencyMs` after
- On success, calls private `publishTelemetry(inputTokens, latencyMs, inputText)` helper
- `publishTelemetry()` wrapped in try/catch — telemetry failure never breaks `embed()`
- Only publishes when `this.bus` and `this.modelRegistry` are both present
- Cost estimation: `modelRegistry.getPricing('text-embedding-3-small')` — model name is a constant in the backend, not passed through

`FakeEmbeddingBackend` is entirely untouched.

### 4. Bus permissions (`src/bus/permissions.ts`)

Add `'embedding.call'` to:
- `system` layer publish allowlist
- `system` layer subscribe allowlist

### 5. Audit logger

No code changes needed. `AuditLogger` is wired as a write-ahead hook that logs every `BusEvent` generically. Once `EmbeddingCallEvent` joins the `BusEvent` union, embedding costs are automatically persisted to `audit_log` alongside `llm.call` entries.

### 6. Wiring (`src/index.ts`)

Update `EmbeddingService.createWithOpenAI()` call at line 401 to pass `bus` and `modelRegistry`:

```typescript
const embeddingService = EmbeddingService.createWithOpenAI(
  config.openaiApiKey,
  logger,
  bus,
  modelRegistry,
);
```

Both are already in scope at that point (bus: line 234, modelRegistry: line 281).

## Testing

New file: `src/memory/embedding.test.ts`

1. **Happy path with telemetry** — mock `fetch` returning a valid embedding + `usage.prompt_tokens: 8`; assert `embedding.call` event published with correct `inputTokens`, `estimatedCostUsd`, `latencyMs`, `model`, `inputTextLength`
2. **Telemetry failure is non-fatal** — mock `bus.publish` throwing; assert `embed()` still resolves with the embedding vector
3. **No bus wired** — `createWithOpenAI(apiKey, logger)` called without bus/modelRegistry; assert `embed()` resolves normally and `bus.publish` is never called
4. **Model registry pricing** — `text-embedding-3-small` entry has `inputPerMToken: 0.02` and `outputPerMToken: 0` (added to `model-registry.test.ts`)

Existing tests (`entity-memory.*`, `knowledge-graph.*`) all use `createForTesting()` — untouched, no test churn.

## Acceptance Criteria (from issue)

- [ ] New `embedding.call` event type in `src/bus/events.ts`
- [ ] `EmbeddingService` publishes events after each API call
- [ ] Events include: model, input token count, estimated cost, latency
- [ ] Costs appear in the same audit log as `llm.call` events
- [ ] No measurable latency regression from telemetry overhead
