// telemetry-provider.test.ts — cleanup-propagation coverage for the telemetry decorator.
//
// TelemetryLlmProvider wraps an inner provider's stream() in a try/catch (to normalize
// unexpected throws into error events). This test proves that wrapper does NOT swallow
// the early-exit cleanup propagation: when a consumer stops iterating early, the inner
// provider's stream generator finally must still run — that finally is where the real
// providers (Anthropic/OpenRouter) release their SDK stream (#1648/#1651).

import { describe, it, expect, vi } from 'vitest';
import { TelemetryLlmProvider } from './telemetry-provider.js';
import { ModelRegistry } from './model-registry.js';
import { createSilentLogger } from '../../logger.js';
import type { LLMProvider, LLMStreamEvent } from './provider.js';
import type { EventBus } from '../../bus/bus.js';

describe('TelemetryLlmProvider — stream cleanup propagation', () => {
  it('runs the inner stream finally when the consumer stops iterating early (#1651)', async () => {
    let innerCleanedUp = false;
    const inner: LLMProvider = {
      id: 'anthropic',
      chat: vi.fn(),
      stream: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          try {
            yield { type: 'text_delta', text: 'a' } as LLMStreamEvent;
            yield { type: 'text_delta', text: 'b' } as LLMStreamEvent;
          } finally {
            // A real provider aborts its SDK stream here; the decorator's try/catch
            // (which only catches throws) must not block this from running.
            innerCleanedUp = true;
          }
        },
      })),
    };
    const bus = { publish: vi.fn() } as unknown as EventBus;
    const provider = new TelemetryLlmProvider(
      inner,
      bus,
      createSilentLogger(),
      'test-service',
      new ModelRegistry(createSilentLogger()),
    );

    const seen: LLMStreamEvent[] = [];
    for await (const event of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      seen.push(event);
      break;
    }

    expect(seen).toHaveLength(1);
    expect(innerCleanedUp).toBe(true);
  });
});
