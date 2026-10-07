// telemetry-provider.test.ts — cleanup-propagation coverage for the telemetry decorator.
//
// TelemetryLlmProvider wraps an inner provider's stream() in a try/catch (to normalize
// unexpected throws into error events). This test proves that wrapper does NOT swallow
// the early-exit cleanup propagation: when a consumer stops iterating early, the inner
// provider's stream generator finally must still run — that finally is where the real
// providers (Anthropic/OpenRouter) release their SDK stream (#1648/#1651).

import { describe, it, expect, vi } from 'vitest';
import { TelemetryLlmProvider } from '../../../../src/agents/llm/telemetry-provider.js';
import { ModelRegistry } from '../../../../src/agents/llm/model-registry.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { LLMProvider, LLMStreamEvent } from '../../../../src/agents/llm/provider.js';
import type { EventBus } from '../../../../src/bus/bus.js';

describe('TelemetryLlmProvider — llm.call temperature', () => {
  it('records temperature 0 when the caller set it, and null when unset (#2038)', async () => {
    const inner: LLMProvider = {
      id: 'anthropic',
      chat: vi.fn(async () => ({
        type: 'text' as const,
        content: 'ok',
        usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: { requestedModel: 'm', actualModel: 'm', providerRequestId: 'r' },
      })),
    };
    const publish = vi.fn();
    const bus = { publish } as unknown as EventBus;
    const provider = new TelemetryLlmProvider(
      inner,
      bus,
      createSilentLogger(),
      'drift-detector',
      new ModelRegistry(createSilentLogger()),
    );

    await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
      options: { temperature: 0 },
    });
    expect(publish.mock.calls[0]![1].payload.temperature).toBe(0);

    publish.mockClear();
    await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
    });
    expect(publish.mock.calls[0]![1].payload.temperature).toBeNull();
  });
});

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

  it('archives tool-call text and reasoning through the shared response builder (#2042)', async () => {
    const usage = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 4 };
    const provenance = { requestedModel: 'm', actualModel: 'm', providerRequestId: 'r' };
    const inner: LLMProvider = {
      id: 'openrouter',
      chat: vi.fn(async () => ({
        type: 'tool_use' as const,
        toolCalls: [{ id: 'c1', name: 'email-send', input: { to: 'a@b.test' } }],
        content: 'Sending.',
        reasoning: 'They asked me to send it.',
        usage,
        provenance,
      })),
    };
    const published: Array<{ archive?: { response?: unknown } }> = [];
    const bus = {
      publish: vi.fn(async (_layer: string, event: { archive?: { response?: unknown } }) => {
        published.push(event);
      }),
    } as unknown as EventBus;
    const provider = new TelemetryLlmProvider(
      inner,
      bus,
      createSilentLogger(),
      'test-service',
      new ModelRegistry(createSilentLogger()),
    );
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' });
    expect(published[0]?.archive?.response).toEqual({
      type: 'tool_use',
      toolCalls: [{ id: 'c1', name: 'email-send', input: { to: 'a@b.test' } }],
      content: 'Sending.',
      reasoning: 'They asked me to send it.',
      reasoningTokens: 4,
    });
  });
});
