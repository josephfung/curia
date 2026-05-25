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

    // Fresh logger with a warn spy — verifies the failure is logged, not silently swallowed.
    const testLogger = createSilentLogger();
    const warnSpy = vi.spyOn(testLogger, 'warn');
    const service = EmbeddingService.createWithOpenAI('test-key', testLogger, mockBus, modelRegistry);
    // Must not throw — telemetry failure is non-fatal
    const result = await service.embed('hello world');
    expect(result).toEqual(FAKE_EMBEDDING);
    // publishTelemetry is fire-and-forget; drain pending microtasks so the
    // catch block (which calls logger.warn) completes before we assert it.
    await new Promise(resolve => setImmediate(resolve));
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('does not call bus.publish when no bus is wired', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeEmbeddingResponse(8)),
    }));

    // No bus/modelRegistry — simulates test or misconfigured production paths
    const service = EmbeddingService.createWithOpenAI('test-key', logger);
    const result = await service.embed('hello world');

    // The service was created without a bus, so embed() should resolve normally.
    expect(result).toEqual(FAKE_EMBEDDING);
  });
});
