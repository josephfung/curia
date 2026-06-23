// runtime.test.ts — tests for AgentRuntime model-fallback behavior (#813).
//
// Uses a real EventBus (with permission enforcement) and mock LLMProviders
// to exercise the chatWithRetry() fallback path end-to-end without a real
// API key or database. Focuses on the three acceptance criteria:
//   (a) primary success — no fallback
//   (b) primary NOT_FOUND → fallback success
//   (c) all models fail → error surfaces to caller

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRuntime } from './runtime.js';
import type { LLMProvider, LLMResponse } from './llm/provider.js';
import { EventBus } from '../bus/bus.js';
import { createAgentTask, type AgentResponseEvent, type ModelFallbackEngagedEvent } from '../bus/events.js';
import { createSilentLogger } from '../logger.js';
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

function makeNotFoundResponse(): LLMResponse {
  return {
    type: 'error',
    error: {
      type: 'NOT_FOUND',
      source: 'openrouter',
      message: '404 No endpoints found',
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
async function runTask(bus: EventBus, agentId: string, content = 'hello'): Promise<{
  response: AgentResponseEvent | null;
  fallbackEvents: ModelFallbackEngagedEvent[];
}> {
  const fallbackEvents: ModelFallbackEngagedEvent[] = [];
  let resolveResponse: (ev: AgentResponseEvent) => void;
  const responsePromise = new Promise<AgentResponseEvent>(res => { resolveResponse = res; });

  bus.subscribe('agent.response', 'system', event => {
    resolveResponse(event as AgentResponseEvent);
  });
  bus.subscribe('model.fallback', 'system', event => {
    fallbackEvents.push(event as ModelFallbackEngagedEvent);
  });

  const parentId = randomUUID();
  const taskEvent = createAgentTask({
    agentId,
    conversationId: randomUUID(),
    channelId: 'cli',
    senderId: 'test-sender',
    content,
    parentEventId: parentId,
  });

  await bus.publish('dispatch', taskEvent);

  // Wait for the response with a generous timeout to avoid flaky tests
  const response = await Promise.race([
    responsePromise,
    new Promise<null>(res => setTimeout(() => res(null), 5_000)),
  ]);

  return { response, fallbackEvents };
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
    const primary = makeProvider('openrouter', makeNotFoundResponse());
    const fallback = makeProvider('anthropic', makeNotFoundResponse());

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

    // Should still get a response, but it's an error response
    expect(response).not.toBeNull();
    expect(response!.payload.isError).toBe(true);

    // model.fallback event was still published (we attempted the fallback)
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]!.payload.failedModel).toBe(PRIMARY_MODEL);

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
