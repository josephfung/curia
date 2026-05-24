# Embedding Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `embedding.call` bus events from `EmbeddingService` after each OpenAI API call so embedding costs appear in the audit log alongside `llm.call` entries.

**Architecture:** Inject `EventBus` and `ModelRegistry` into `OpenAIBackend` (the private transport class inside `EmbeddingService`). The backend already parses the OpenAI embeddings API response — extend the JSON type to include `usage.prompt_tokens`, record latency with `Date.now()`, and publish an `embedding.call` event after each successful call. The event is sourced from the `system` layer; telemetry failure never breaks `embed()`.

**Tech Stack:** TypeScript/ESM, Vitest, existing `EventBus` / `ModelRegistry` / `createEmbeddingCall` (to be added) infrastructure.

---

## File Map

**Modify:**
- `src/agents/llm/model-registry.ts` — add `text-embedding-3-small` registry entry
- `src/agents/llm/model-registry.test.ts` — add embedding model tests
- `src/bus/events.ts` — add `EmbeddingCallPayload`, `EmbeddingCallEvent`, `createEmbeddingCall()`, add to `BusEvent` union
- `src/bus/permissions.ts` — add `'embedding.call'` to `system` layer publish + subscribe allowlists
- `src/memory/embedding.ts` — add imports, inject bus/modelRegistry into `OpenAIBackend`, capture `usage.prompt_tokens`, add `publishTelemetry()`, call it after success
- `src/index.ts` — pass `bus` and `modelRegistry` to `EmbeddingService.createWithOpenAI()`
- `CHANGELOG.md` — add entry under `[Unreleased]`

**Create:**
- `src/memory/embedding.test.ts` — unit tests for `OpenAIBackend` telemetry

---

## Task 1: Add `text-embedding-3-small` to the model registry

**Files:**
- Modify: `src/agents/llm/model-registry.ts`
- Modify: `src/agents/llm/model-registry.test.ts`

- [ ] **Step 1: Add the failing tests to `model-registry.test.ts`**

  Append a new `describe` block at the bottom of the file (before the final `}`):

  ```typescript
  describe('Embedding models', () => {
    it('text-embedding-3-small is registered with provider openai', () => {
      const meta = registry.getModel('text-embedding-3-small');
      expect(meta).toBeDefined();
      expect(meta!.provider).toBe('openai');
      expect(meta!.contextWindow).toBe(8191);
      expect(meta!.capabilities).toContain('embedding');
    });

    it('text-embedding-3-small has correct pricing ($0.02/MTok input, $0 output)', () => {
      const pricing = registry.getPricing('text-embedding-3-small');
      expect(pricing).toBeDefined();
      expect(pricing!.inputPerMToken).toBe(0.02);
      expect(pricing!.outputPerMToken).toBe(0);
      expect(pricing!.cacheCreationPerMToken).toBeUndefined();
      expect(pricing!.cacheReadPerMToken).toBeUndefined();
    });
  });
  ```

- [ ] **Step 2: Run the tests to confirm they fail**

  ```bash
  npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry vitest run src/agents/llm/model-registry.test.ts
  ```

  Expected: 2 failures — `text-embedding-3-small` not found in registry.

- [ ] **Step 3: Add the entry to `MODEL_REGISTRY` in `model-registry.ts`**

  In `src/agents/llm/model-registry.ts`, add to the `MODEL_REGISTRY` object (after the OpenRouter models block, before the closing `}`):

  ```typescript
  // OpenAI embedding model — used by EmbeddingService for semantic search and entity resolution.
  // inputPerMToken matches current OpenAI pricing for text-embedding-3-small.
  // outputPerMToken is 0: embeddings produce no billed output tokens.
  'text-embedding-3-small': {
    provider: 'openai',
    contextWindow: 8191,
    pricing: {
      inputPerMToken: 0.02,
      outputPerMToken: 0,
    },
    capabilities: ['embedding'],
  },
  ```

- [ ] **Step 4: Run the tests to confirm they pass**

  ```bash
  npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry vitest run src/agents/llm/model-registry.test.ts
  ```

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry add src/agents/llm/model-registry.ts src/agents/llm/model-registry.test.ts
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry commit -m "feat: add text-embedding-3-small to model registry (#654)"
  ```

---

## Task 2: Add `embedding.call` event type and update bus permissions

**Files:**
- Modify: `src/bus/events.ts`
- Modify: `src/bus/permissions.ts`

There are no unit tests for `events.ts` factories (they are thin wrappers over `randomUUID`). Correctness is verified by TypeScript's type checker and by Task 3's tests which assert the published event's shape.

- [ ] **Step 1: Add `EmbeddingCallPayload` and `EmbeddingCallEvent` to `events.ts`**

  In `src/bus/events.ts`, add immediately after the `LlmCallPayload` / `LlmCallEvent` block (around line 670):

  ```typescript
  // EmbeddingCallPayload — emitted by EmbeddingService (OpenAI backend) after each
  // successful embedding API call. Tracks model, token consumption, estimated cost,
  // and latency. Allows embedding costs to appear in the same audit log as llm.call.
  // sourceLayer 'system' because embeddings fire from infrastructure, not agent tasks.
  // parentEventId is optional — embedding calls fire from KG/validator paths that
  // don't always have a task event ID in scope.
  interface EmbeddingCallPayload {
    /** Embedding model used — e.g. 'text-embedding-3-small'. */
    model: string;
    /** Token count from OpenAI API response usage.prompt_tokens. */
    inputTokens: number;
    /** Estimated cost in USD, computed at call time from model registry pricing. */
    estimatedCostUsd: number;
    /** Wall-clock latency for the API call in milliseconds. */
    latencyMs: number;
    /** Character count of the input text — diagnostic for oversized inputs. */
    inputTextLength: number;
  }

  export interface EmbeddingCallEvent extends BaseEvent {
    type: 'embedding.call';
    sourceLayer: 'system';
    payload: EmbeddingCallPayload;
  }
  ```

- [ ] **Step 2: Add the `createEmbeddingCall` factory to `events.ts`**

  Add immediately after `createLlmCall` (around line 1188):

  ```typescript
  export function createEmbeddingCall(
    payload: EmbeddingCallPayload & { parentEventId?: string },
  ): EmbeddingCallEvent {
    const { parentEventId, ...rest } = payload;
    return {
      id: randomUUID(),
      timestamp: new Date(),
      type: 'embedding.call',
      sourceLayer: 'system',
      payload: rest,
      parentEventId,
    };
  }
  ```

- [ ] **Step 3: Add `EmbeddingCallEvent` to the `BusEvent` union in `events.ts`**

  In the `BusEvent` discriminated union (around line 766), add:

  ```typescript
  | EmbeddingCallEvent         // #654: embedding API call cost telemetry
  ```

  Place it after `| LlmCallEvent`.

- [ ] **Step 4: Update `permissions.ts`**

  In `src/bus/permissions.ts`, add `'embedding.call'` to the `system` set in both `publishAllowlist` and `subscribeAllowlist`. Find the two `system:` lines and append the new event type to each.

- [ ] **Step 5: Run typecheck**

  ```bash
  pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry run typecheck
  ```

  Expected: no errors.

- [ ] **Step 6: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry add src/bus/events.ts src/bus/permissions.ts
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry commit -m "feat: add embedding.call event type and bus permissions (#654)"
  ```

---

## Task 3: Instrument `OpenAIBackend` with telemetry

**Files:**
- Create: `src/memory/embedding.test.ts`
- Modify: `src/memory/embedding.ts`

- [ ] **Step 1: Create `src/memory/embedding.test.ts` with failing tests**

  ```typescript
  // embedding.test.ts — unit tests for OpenAIBackend telemetry.
  //
  // Mocks globalThis.fetch so tests run without a real API key.
  // Uses vi.stubGlobal / vi.unstubAllGlobals to keep the mock isolated per test.

  import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
  import { EmbeddingService } from './embedding.js';
  import type { EventBus } from '../bus/bus.js';
  import { ModelRegistry } from '../agents/llm/model-registry.js';
  import { createSilentLogger } from '../logger.js';
  import { EMBEDDING_DIMENSIONS } from './types.js';

  const logger = createSilentLogger();
  const modelRegistry = new ModelRegistry(logger);

  // A valid embedding of the correct dimension — used as the mock API response payload.
  const FAKE_EMBEDDING = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / EMBEDDING_DIMENSIONS);

  // Builds a minimal OpenAI embeddings API response.
  const makeEmbeddingResponse = (promptTokens = 8) => ({
    data: [{ embedding: FAKE_EMBEDDING }],
    usage: { prompt_tokens: promptTokens },
  });

  describe('EmbeddingService — OpenAI backend telemetry', () => {
    let mockBus: EventBus;

    beforeEach(() => {
      mockBus = { publish: vi.fn() } as unknown as EventBus;
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('publishes an embedding.call event after a successful API call', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeEmbeddingResponse(8)),
      }));

      const service = EmbeddingService.createWithOpenAI('test-key', logger, mockBus, modelRegistry);
      const result = await service.embed('hello world');

      expect(result).toEqual(FAKE_EMBEDDING);
      expect(mockBus.publish).toHaveBeenCalledOnce();

      const [layer, event] = (mockBus.publish as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(layer).toBe('system');
      expect(event.type).toBe('embedding.call');
      expect(event.payload.model).toBe('text-embedding-3-small');
      expect(event.payload.inputTokens).toBe(8);
      // $0.02 / 1_000_000 * 8 tokens
      expect(event.payload.estimatedCostUsd).toBeCloseTo(0.00000016);
      expect(event.payload.latencyMs).toBeGreaterThanOrEqual(0);
      expect(event.payload.inputTextLength).toBe('hello world'.length);
    });

    it('still resolves embed() if bus.publish throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeEmbeddingResponse(8)),
      }));
      (mockBus.publish as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bus down'));

      const service = EmbeddingService.createWithOpenAI('test-key', logger, mockBus, modelRegistry);
      // Must not throw — telemetry failure is non-fatal
      const result = await service.embed('hello world');
      expect(result).toEqual(FAKE_EMBEDDING);
    });

    it('does not call bus.publish when no bus is wired', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(makeEmbeddingResponse(8)),
      }));

      // No bus/modelRegistry — simulates test or misconfigured production paths
      const service = EmbeddingService.createWithOpenAI('test-key', logger);
      const result = await service.embed('hello world');

      expect(result).toEqual(FAKE_EMBEDDING);
      expect(mockBus.publish).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 2: Run the tests to confirm they fail**

  ```bash
  npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry vitest run src/memory/embedding.test.ts
  ```

  Expected: 3 failures — `createWithOpenAI` doesn't accept bus/modelRegistry yet, no publish happens.

- [ ] **Step 3: Update imports in `embedding.ts`**

  At the top of `src/memory/embedding.ts`, add after the existing imports:

  ```typescript
  import type { EventBus } from '../bus/bus.js';
  import type { ModelRegistry } from '../agents/llm/model-registry.js';
  import { createEmbeddingCall } from '../bus/events.js';
  ```

- [ ] **Step 4: Update `EmbeddingService.createWithOpenAI()` in `embedding.ts`**

  Replace the existing `createWithOpenAI` static method:

  ```typescript
  // Production factory — requires a live OpenAI API key.
  // Pass bus and modelRegistry to enable embedding.call telemetry.
  // Both are optional so the service still works without them, but in production
  // both should always be provided so costs appear in the audit log.
  static createWithOpenAI(
    apiKey: string,
    logger: Logger,
    bus?: EventBus,
    modelRegistry?: ModelRegistry,
  ): EmbeddingService {
    return new EmbeddingService(new OpenAIBackend(apiKey, logger, bus, modelRegistry));
  }
  ```

- [ ] **Step 5: Update `OpenAIBackend` constructor signature in `embedding.ts`**

  Replace the `OpenAIBackend` class constructor:

  ```typescript
  class OpenAIBackend implements EmbeddingBackend {
    constructor(
      private apiKey: string,
      private logger: Logger,
      private bus?: EventBus,
      private modelRegistry?: ModelRegistry,
    ) {}
  ```

- [ ] **Step 6: Update `embed()` in `OpenAIBackend` to capture usage and latency**

  In `OpenAIBackend.embed()`:

  1. Add `const start = Date.now();` as the first line of the method body (before the `try` block).

  2. Widen the `json` type to include `usage`:

     Replace:
     ```typescript
     let json: { data: Array<{ embedding: number[] }> };
     ```
     With:
     ```typescript
     let json: { data: Array<{ embedding: number[] }>; usage: { prompt_tokens: number } };
     ```

  3. After the `return embedding;` line at the end of the method, insert the latency capture and telemetry call. The final method looks like this for the success path (after the dimension check):

     ```typescript
     // Telemetry — non-fatal; failure must not break the caller.
     const latencyMs = Date.now() - start;
     await this.publishTelemetry(json.usage.prompt_tokens, latencyMs, text);
     return embedding;
     ```

     Note: move `return embedding;` to AFTER the `publishTelemetry` call.

- [ ] **Step 7: Add `publishTelemetry()` private method to `OpenAIBackend`**

  Add after the `embed()` method:

  ```typescript
  // Publishes an embedding.call telemetry event. Non-fatal — any failure is
  // logged and swallowed so it never breaks the embed() call chain.
  // Only runs when both bus and modelRegistry are wired (production path).
  private async publishTelemetry(
    inputTokens: number,
    latencyMs: number,
    inputText: string,
  ): Promise<void> {
    if (!this.bus || !this.modelRegistry) return;
    try {
      const pricing = this.modelRegistry.getPricing('text-embedding-3-small');
      // pricing will always be defined after Task 1 adds the registry entry,
      // but guard defensively so a misconfigured registry doesn't break embed().
      const estimatedCostUsd = pricing
        ? (inputTokens * pricing.inputPerMToken) / 1_000_000
        : 0;

      const event = createEmbeddingCall({
        model: 'text-embedding-3-small',
        inputTokens,
        estimatedCostUsd,
        latencyMs,
        inputTextLength: inputText.length,
      });
      await this.bus.publish('system', event);
    } catch (err) {
      // Telemetry failures must never propagate — log at warn so they're visible
      // in dashboards without impacting the caller.
      this.logger.warn({ err }, 'OpenAIBackend: failed to publish embedding.call telemetry event — cost tracking gap');
    }
  }
  ```

- [ ] **Step 8: Run the tests to confirm they pass**

  ```bash
  npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry vitest run src/memory/embedding.test.ts
  ```

  Expected: all 3 tests pass.

- [ ] **Step 9: Run typecheck**

  ```bash
  pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry run typecheck
  ```

  Expected: no errors.

- [ ] **Step 10: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry add src/memory/embedding.ts src/memory/embedding.test.ts
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry commit -m "feat: publish embedding.call telemetry from OpenAIBackend (#654)"
  ```

---

## Task 4: Wire up `bus` and `modelRegistry` in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

This is dependency injection wiring. No unit test needed — verified by typecheck and the full test suite.

**Audit logger note:** No changes needed to `src/audit/logger.ts`. The audit logger is wired as a write-ahead hook on the bus (`bus.setWriteAheadHook`) and logs every `BusEvent` generically. Once `EmbeddingCallEvent` is in the `BusEvent` union (Task 2), embedding costs are automatically persisted to `audit_log` alongside `llm.call` entries.

- [ ] **Step 1: Update the `EmbeddingService.createWithOpenAI()` call in `index.ts`**

  Find line 401 (the `EmbeddingService.createWithOpenAI(...)` call inside the `if (config.openaiApiKey)` block) and replace it:

  ```typescript
  const embeddingService = EmbeddingService.createWithOpenAI(
    config.openaiApiKey,
    logger,
    bus,           // EventBus — wired at line 234
    modelRegistry, // ModelRegistry — wired at line 281
  );
  ```

- [ ] **Step 2: Run typecheck**

  ```bash
  pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry run typecheck
  ```

  Expected: no errors.

- [ ] **Step 3: Run the full test suite**

  ```bash
  pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry test
  ```

  Expected: all tests pass, including the new embedding tests and all existing tests (no regressions).

- [ ] **Step 4: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry add src/index.ts
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry commit -m "chore: wire bus and modelRegistry into EmbeddingService (#654)"
  ```

---

## Task 5: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entry under `## [Unreleased]` in `CHANGELOG.md`**

  Under `## [Unreleased]`, add or append to an `### Added` section:

  ```markdown
  - **`embedding.call` bus event** — `EmbeddingService` now publishes cost telemetry after each OpenAI embedding API call; token counts and estimated costs appear in `audit_log` alongside `llm.call` entries. (#654)
  ```

- [ ] **Step 2: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry add CHANGELOG.md
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-embedding-telemetry commit -m "chore: update CHANGELOG for embedding telemetry (#654)"
  ```
