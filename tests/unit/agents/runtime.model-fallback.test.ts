// runtime.test.ts — tests for AgentRuntime model-fallback behavior (#813).
//
// Uses a real EventBus (with permission enforcement) and mock LLMProviders
// to exercise the chatWithRetry() fallback path end-to-end without a real
// API key or database. Focuses on the three acceptance criteria:
//   (a) primary success — no fallback
//   (b) primary NOT_FOUND → fallback success
//   (c) all models fail → error surfaces to caller

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import type { LLMProvider, LLMResponse } from '../../../src/agents/llm/provider.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask, type AgentErrorEvent, type AgentResponseEvent, type ModelFallbackEngagedEvent } from '../../../src/bus/events.js';
import { createSilentLogger } from '../../../src/logger.js';
import { randomUUID } from 'node:crypto';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function makeSuccessResponse(model: string): LLMResponse {
  return {
    type: 'text',
    content: `response from ${model}`,
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    provenance: { requestedModel: model, actualModel: model, providerRequestId: `req-${model}` },
  };
}

function makeNotFoundResponse(source = 'openrouter', message = '404 No endpoints found'): LLMResponse {
  return {
    type: 'error',
    error: {
      type: 'NOT_FOUND',
      source,
      message,
      retryable: false,
      context: { status: 404 },
      timestamp: new Date(),
    },
  };
}

function makeAuthFailureResponse(): LLMResponse {
  return {
    type: 'error',
    error: {
      type: 'AUTH_FAILURE',
      source: 'openrouter',
      message: '401 Unauthorized',
      retryable: false,
      context: { status: 401 },
      timestamp: new Date(),
    },
  };
}

function makeProvider(id: string, response: LLMResponse): LLMProvider {
  return { id, chat: vi.fn().mockResolvedValue(response) };
}

// Publish a task and return a promise that resolves with the agent.response event.
// Uses the system layer to capture all bus events.
async function runTask(bus: EventBus, agentId: string, content = 'hello', turnDeadlineAt?: number): Promise<{
  response: AgentResponseEvent | null;
  fallbackEvents: ModelFallbackEngagedEvent[];
  errorEvents: AgentErrorEvent[];
}> {
  const fallbackEvents: ModelFallbackEngagedEvent[] = [];
  const errorEvents: AgentErrorEvent[] = [];
  let resolveResponse: (ev: AgentResponseEvent) => void;
  const responsePromise = new Promise<AgentResponseEvent>(res => { resolveResponse = res; });

  bus.subscribe('agent.response', 'system', event => {
    resolveResponse(event as AgentResponseEvent);
  });
  bus.subscribe('model.fallback', 'system', event => {
    fallbackEvents.push(event as ModelFallbackEngagedEvent);
  });
  bus.subscribe('agent.error', 'system', event => {
    errorEvents.push(event as AgentErrorEvent);
  });

  const parentId = randomUUID();
  const taskEvent = createAgentTask({
    agentId,
    conversationId: randomUUID(),
    channelId: 'cli',
    senderId: 'test-sender',
    content,
    ...(turnDeadlineAt !== undefined && { turnDeadlineAt }),
    parentEventId: parentId,
  });

  await bus.publish('dispatch', taskEvent);

  // Wait for the response with a generous timeout to avoid flaky tests
  const response = await Promise.race([
    responsePromise,
    new Promise<null>(res => setTimeout(() => res(null), 5_000)),
  ]);

  return { response, fallbackEvents, errorEvents };
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('AgentRuntime model fallback (#813)', () => {
  const logger = createSilentLogger();
  const AGENT_ID = 'test-agent';
  const PRIMARY_MODEL = 'google/gemini-2.0-flash-lite';
  const FALLBACK_MODEL = 'claude-sonnet-4-6';

  let bus: EventBus;

  beforeEach(() => {
    // Fresh bus per test so subscriber state doesn't bleed between tests.
    bus = new EventBus(logger);
  });

  it('(a) returns the primary model response when it succeeds', async () => {
    const primary = makeProvider('openrouter', makeSuccessResponse(PRIMARY_MODEL));
    const fallback = makeProvider('anthropic', makeSuccessResponse(FALLBACK_MODEL));

    const runtime = new AgentRuntime({
      agentId: AGENT_ID,
      systemPrompt: 'You are helpful.',
      provider: primary,
      resolvedModel: PRIMARY_MODEL,
      tier: 'fast',
      fallbackModel: FALLBACK_MODEL,
      fallbackProvider: fallback,
      bus,
      logger,
    });
    runtime.register();

    const { response, fallbackEvents } = await runTask(bus, AGENT_ID);

    expect(response).not.toBeNull();
    expect(response!.payload.isError).toBeFalsy();
    expect(response!.payload.content).toContain(PRIMARY_MODEL);
    expect(fallbackEvents).toHaveLength(0);
    expect(primary.chat).toHaveBeenCalledOnce();
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it('(b) falls through to the fallback model when the primary returns NOT_FOUND', async () => {
    const primary = makeProvider('openrouter', makeNotFoundResponse());
    const fallback = makeProvider('anthropic', makeSuccessResponse(FALLBACK_MODEL));

    const runtime = new AgentRuntime({
      agentId: AGENT_ID,
      systemPrompt: 'You are helpful.',
      provider: primary,
      resolvedModel: PRIMARY_MODEL,
      tier: 'fast',
      fallbackModel: FALLBACK_MODEL,
      fallbackProvider: fallback,
      bus,
      logger,
    });
    runtime.register();

    const { response, fallbackEvents } = await runTask(bus, AGENT_ID);

    // Final response should be the fallback's success
    expect(response).not.toBeNull();
    expect(response!.payload.isError).toBeFalsy();
    expect(response!.payload.content).toContain(FALLBACK_MODEL);

    // model.fallback event must be published exactly once
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]!.payload.tier).toBe('fast');
    expect(fallbackEvents[0]!.payload.failedModel).toBe(PRIMARY_MODEL);
    expect(fallbackEvents[0]!.payload.fallbackModel).toBe(FALLBACK_MODEL);
    expect(fallbackEvents[0]!.payload.reason).toBe('NOT_FOUND');

    expect(primary.chat).toHaveBeenCalledOnce();
    expect(fallback.chat).toHaveBeenCalledOnce();
  });

  it('(c) surfaces an error when both primary and fallback fail', async () => {
    // Use distinct sources so we can verify it's the fallback's error that surfaces.
    const primary = makeProvider('openrouter', makeNotFoundResponse('openrouter', 'primary model gone'));
    const fallback = makeProvider('anthropic', makeNotFoundResponse('anthropic', 'fallback model gone'));

    const runtime = new AgentRuntime({
      agentId: AGENT_ID,
      systemPrompt: 'You are helpful.',
      provider: primary,
      resolvedModel: PRIMARY_MODEL,
      tier: 'fast',
      fallbackModel: FALLBACK_MODEL,
      fallbackProvider: fallback,
      bus,
      logger,
    });
    runtime.register();

    const { response, fallbackEvents, errorEvents } = await runTask(bus, AGENT_ID);

    // Should still get a response, but it's an error response
    expect(response).not.toBeNull();
    expect(response!.payload.isError).toBe(true);

    // model.fallback event was still published (we attempted the fallback)
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]!.payload.failedModel).toBe(PRIMARY_MODEL);

    // The agent.error event must carry the fallback's source, proving it's the fallback
    // error that was surfaced rather than the primary NOT_FOUND.
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.payload.source).toBe('anthropic');

    expect(primary.chat).toHaveBeenCalledOnce();
    expect(fallback.chat).toHaveBeenCalledOnce();
  });

  it('does not attempt fallback for non-NOT_FOUND errors', async () => {
    const primary = makeProvider('openrouter', makeAuthFailureResponse());
    const fallback = makeProvider('anthropic', makeSuccessResponse(FALLBACK_MODEL));

    const runtime = new AgentRuntime({
      agentId: AGENT_ID,
      systemPrompt: 'You are helpful.',
      provider: primary,
      resolvedModel: PRIMARY_MODEL,
      tier: 'fast',
      fallbackModel: FALLBACK_MODEL,
      fallbackProvider: fallback,
      bus,
      logger,
    });
    runtime.register();

    const { response, fallbackEvents } = await runTask(bus, AGENT_ID);

    // AUTH_FAILURE should hard-fail without trying the fallback
    expect(response).not.toBeNull();
    expect(response!.payload.isError).toBe(true);
    expect(fallbackEvents).toHaveLength(0);
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it('succeeds with primary model when no fallback is configured', async () => {
    const primary = makeProvider('openrouter', makeSuccessResponse(PRIMARY_MODEL));

    const runtime = new AgentRuntime({
      agentId: AGENT_ID,
      systemPrompt: 'You are helpful.',
      provider: primary,
      resolvedModel: PRIMARY_MODEL,
      // No tier, fallbackModel, or fallbackProvider
      bus,
      logger,
    });
    runtime.register();

    const { response, fallbackEvents } = await runTask(bus, AGENT_ID);

    expect(response).not.toBeNull();
    expect(response!.payload.isError).toBeFalsy();
    expect(fallbackEvents).toHaveLength(0);
  });

  it('surfaces error when NOT_FOUND occurs and no fallback is configured', async () => {
    const primary = makeProvider('openrouter', makeNotFoundResponse());

    const runtime = new AgentRuntime({
      agentId: AGENT_ID,
      systemPrompt: 'You are helpful.',
      provider: primary,
      resolvedModel: PRIMARY_MODEL,
      // No fallback configured
      bus,
      logger,
    });
    runtime.register();

    const { response, fallbackEvents } = await runTask(bus, AGENT_ID);

    expect(response).not.toBeNull();
    expect(response!.payload.isError).toBe(true);
    expect(fallbackEvents).toHaveLength(0);
  });
});

describe('AgentRuntime reasoning setting (ADR-048 §3)', () => {
  const logger = createSilentLogger();
  const AGENT_ID = 'test-agent';
  const PRIMARY_MODEL = 'deepseek/deepseek-v4.1-flash';
  const FALLBACK_MODEL = 'claude-sonnet-4-6';

  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus(logger);
  });

  function optionsOf(provider: LLMProvider): unknown {
    const params = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { options?: unknown };
    return params.options;
  }

  it('sends the tier reasoning setting on agent turns', async () => {
    const primary = makeProvider('openrouter', makeSuccessResponse(PRIMARY_MODEL));
    new AgentRuntime({
      agentId: AGENT_ID, systemPrompt: 'You are helpful.', provider: primary, resolvedModel: PRIMARY_MODEL,
      tier: 'standard', reasoning: { effort: 'low' }, bus, logger,
    }).register();
    await runTask(bus, AGENT_ID);
    expect(optionsOf(primary)).toEqual({ reasoning: { effort: 'low' } });
  });

  it('sends no options when the tier leaves reasoning unset', async () => {
    const primary = makeProvider('openrouter', makeSuccessResponse(PRIMARY_MODEL));
    new AgentRuntime({
      agentId: AGENT_ID, systemPrompt: 'You are helpful.', provider: primary, resolvedModel: PRIMARY_MODEL, tier: 'standard', bus, logger,
    }).register();
    await runTask(bus, AGENT_ID);
    expect(optionsOf(primary)).toBeUndefined();
  });

  it('sends the fallback tier its own setting', async () => {
    const primary = makeProvider('openrouter', makeNotFoundResponse());
    const fallback = makeProvider('anthropic', makeSuccessResponse(FALLBACK_MODEL));
    new AgentRuntime({
      agentId: AGENT_ID, systemPrompt: 'You are helpful.', provider: primary, resolvedModel: PRIMARY_MODEL, tier: 'standard',
      reasoning: { effort: 'low' }, fallbackModel: FALLBACK_MODEL, fallbackProvider: fallback, fallbackReasoning: { effort: 'high' },
      bus, logger,
    }).register();
    await runTask(bus, AGENT_ID);
    expect(optionsOf(primary)).toEqual({ reasoning: { effort: 'low' } });
    expect(optionsOf(fallback)).toEqual({ reasoning: { effort: 'high' } });
  });

  it('records the effort the provider reports it sent on llm.call', async () => {
    const response = makeSuccessResponse(PRIMARY_MODEL);
    if (response.type === 'text') response.provenance.reasoningEffort = 'low';
    const primary = makeProvider('openrouter', response);
    const calls: Array<{ payload: { reasoningEffort?: unknown } }> = [];
    bus.subscribe('llm.call', 'system', (event) => { calls.push(event as unknown as { payload: { reasoningEffort?: unknown } }); });
    new AgentRuntime({
      agentId: AGENT_ID, systemPrompt: 'You are helpful.', provider: primary, resolvedModel: PRIMARY_MODEL,
      tier: 'standard', reasoning: { effort: 'low' }, bus, logger,
    }).register();
    await runTask(bus, AGENT_ID);
    expect(calls[0]!.payload.reasoningEffort).toBe('low');
  });
});

describe('AgentRuntime turn deadline (#2371)', () => {
  const logger = createSilentLogger();
  const AGENT_ID = 'test-agent';
  const PRIMARY_MODEL = 'deepseek/deepseek-v4.1-flash';
  const FALLBACK_MODEL = 'claude-sonnet-4-6';
  const DEADLINE = 1_800_000_000_000;

  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus(logger);
  });

  function optionsOfCall(provider: LLMProvider, n: number): unknown {
    const params = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[n]![0] as { options?: unknown };
    return params.options;
  }

  it('passes options.deadlineAt from turnDeadlineAt on the primary call, alongside reasoning', async () => {
    const primary = makeProvider('openrouter', makeSuccessResponse(PRIMARY_MODEL));
    new AgentRuntime({
      agentId: AGENT_ID, systemPrompt: 'You are helpful.', provider: primary, resolvedModel: PRIMARY_MODEL,
      tier: 'standard', reasoning: { effort: 'low' }, bus, logger,
    }).register();
    await runTask(bus, AGENT_ID, 'hello', DEADLINE);
    expect(optionsOfCall(primary, 0)).toEqual({ reasoning: { effort: 'low' }, deadlineAt: DEADLINE });
  });

  it('passes deadlineAt alone when the tier has no reasoning setting', async () => {
    const primary = makeProvider('openrouter', makeSuccessResponse(PRIMARY_MODEL));
    new AgentRuntime({
      agentId: AGENT_ID, systemPrompt: 'You are helpful.', provider: primary, resolvedModel: PRIMARY_MODEL, tier: 'standard', bus, logger,
    }).register();
    await runTask(bus, AGENT_ID, 'hello', DEADLINE);
    expect(optionsOfCall(primary, 0)).toEqual({ deadlineAt: DEADLINE });
  });

  it('passes deadlineAt on the fallback call with the fallback tier reasoning', async () => {
    const primary = makeProvider('openrouter', makeNotFoundResponse());
    const fallback = makeProvider('anthropic', makeSuccessResponse(FALLBACK_MODEL));
    new AgentRuntime({
      agentId: AGENT_ID, systemPrompt: 'You are helpful.', provider: primary, resolvedModel: PRIMARY_MODEL, tier: 'standard',
      reasoning: { effort: 'low' }, fallbackModel: FALLBACK_MODEL, fallbackProvider: fallback, fallbackReasoning: { effort: 'high' },
      bus, logger,
    }).register();
    await runTask(bus, AGENT_ID, 'hello', DEADLINE);
    expect(optionsOfCall(primary, 0)).toEqual({ reasoning: { effort: 'low' }, deadlineAt: DEADLINE });
    expect(optionsOfCall(fallback, 0)).toEqual({ reasoning: { effort: 'high' }, deadlineAt: DEADLINE });
  });

  it('passes deadlineAt on the retry call', async () => {
    const retryable: LLMResponse = {
      type: 'error',
      error: { type: 'RATE_LIMIT', source: 'openrouter', message: '429', retryable: true, context: {}, timestamp: new Date() },
    };
    const chat = vi.fn()
      .mockResolvedValueOnce(retryable)
      .mockResolvedValueOnce(makeSuccessResponse(PRIMARY_MODEL));
    const primary: LLMProvider = { id: 'openrouter', chat };
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      new AgentRuntime({
        agentId: AGENT_ID, systemPrompt: 'You are helpful.', provider: primary, resolvedModel: PRIMARY_MODEL,
        tier: 'standard', reasoning: { effort: 'low' }, bus, logger,
      }).register();
      const done = runTask(bus, AGENT_ID, 'hello', DEADLINE);
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(chat).toHaveBeenCalledTimes(2);
    expect(optionsOfCall(primary, 0)).toEqual({ reasoning: { effort: 'low' }, deadlineAt: DEADLINE });
    expect(optionsOfCall(primary, 1)).toEqual({ reasoning: { effort: 'low' }, deadlineAt: DEADLINE });
  });

  it('omits deadlineAt when the task has none', async () => {
    const primary = makeProvider('openrouter', makeSuccessResponse(PRIMARY_MODEL));
    new AgentRuntime({
      agentId: AGENT_ID, systemPrompt: 'You are helpful.', provider: primary, resolvedModel: PRIMARY_MODEL,
      tier: 'standard', reasoning: { effort: 'low' }, bus, logger,
    }).register();
    await runTask(bus, AGENT_ID);
    expect(optionsOfCall(primary, 0)).toEqual({ reasoning: { effort: 'low' } });
  });
});
