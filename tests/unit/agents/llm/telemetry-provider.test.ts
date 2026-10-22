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

  it('records null for a model that rejects sampling parameters, even when the caller set 0 (#2077)', async () => {
    const inner: LLMProvider = {
      id: 'anthropic',
      chat: vi.fn(async () => ({
        type: 'text' as const,
        content: 'ok',
        usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: { requestedModel: 'claude-haiku-5-5', actualModel: 'claude-haiku-5-5', providerRequestId: 'r' },
      })),
    };
    const publish = vi.fn();
    const provider = new TelemetryLlmProvider(
      inner,
      { publish } as unknown as EventBus,
      createSilentLogger(),
      'drift-detector',
      new ModelRegistry(createSilentLogger()),
    );

    await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-haiku-5-5',
      options: { temperature: 0 },
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

describe('TelemetryLlmProvider — caller cancellation (#1968)', () => {
  const abortedError: LLMStreamEvent = {
    type: 'error',
    error: {
      type: 'UNKNOWN',
      source: 'anthropic',
      message: 'Request was aborted.',
      retryable: false,
      context: {},
      timestamp: new Date(),
    },
  };

  function setup() {
    const inner: LLMProvider = {
      id: 'anthropic',
      chat: vi.fn(),
      async *stream() {
        yield abortedError;
      },
    };
    const publish = vi.fn();
    const provider = new TelemetryLlmProvider(
      inner,
      { publish } as unknown as EventBus,
      createSilentLogger(),
      'voice-turn',
      new ModelRegistry(createSilentLogger()),
    );
    return { provider, publish };
  }

  async function drain(provider: TelemetryLlmProvider, signal?: AbortSignal): Promise<LLMStreamEvent[]> {
    const events: LLMStreamEvent[] = [];
    for await (const e of provider.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'm', options: { signal } })) {
      events.push(e);
    }
    return events;
  }

  it('publishes no llm.error when the caller aborted the stream (barge-in, hang-up)', async () => {
    const { provider, publish } = setup();
    const controller = new AbortController();
    controller.abort();
    const events = await drain(provider, controller.signal);
    // The caller still sees the error event, so its loop stops.
    expect(events).toEqual([abortedError]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('still publishes llm.error when the signal fired because the request timed out', async () => {
    const { provider, publish } = setup();
    const controller = new AbortController();
    controller.abort(new DOMException('timed out', 'TimeoutError'));
    await drain(provider, controller.signal);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![1].type).toBe('llm.error');
  });

  it('still publishes llm.error for a failure with no abort', async () => {
    const { provider, publish } = setup();
    await drain(provider, new AbortController().signal);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
