// Bus layer enforcement — EventBus throw-at-call-time contract
//
// Confirms that unauthorized publish/subscribe attempts are rejected at the bus level —
// not silently dropped, not deferred, but thrown synchronously at call time.
//
// These tests exercise EventBus directly (no DB, no external services) and prove that
// the throw-at-call-time contract holds for a real EventBus instance, complementing the
// canPublish/canSubscribe lookup tests in permissions.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import {
  createAgentTask,
  createInboundMessage,
  createSkillResult,
  createLlmCall,
  createHumanDecision,
} from '../../../src/bus/events.js';
import { createLogger } from '../../../src/logger.js';

describe('Bus Layer Enforcement (integration)', () => {
  // Use 'error' log level to suppress debug noise in test output.
  const logger = createLogger('error');

  it('channel layer cannot publish agent.task — throws at call time', async () => {
    const bus = new EventBus(logger);
    const event = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'inbound-1',
    });
    // Only dispatch can publish agent.task; the channel layer routes inbound messages, not tasks
    await expect(bus.publish('channel', event)).rejects.toThrow(
      /not authorized to publish/,
    );
  });

  it('dispatch layer cannot publish skill.result — throws at call time', async () => {
    const bus = new EventBus(logger);
    // skill.result is owned by execution (and agent on its behalf); dispatch has no publish right
    const event = createSkillResult({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      skillName: 'send-email',
      result: { success: true, data: {} },
      durationMs: 120,
      parentEventId: 'invoke-1',
    });
    await expect(bus.publish('dispatch', event)).rejects.toThrow(
      /not authorized to publish/,
    );
  });

  it('channel layer cannot subscribe to agent.task — throws at registration', () => {
    const bus = new EventBus(logger);
    // Registration-time enforcement: this must throw immediately so misconfiguration
    // surfaces at startup before any events flow.
    expect(() =>
      bus.subscribe('agent.task', 'channel', vi.fn()),
    ).toThrow(/not authorized to subscribe/);
  });

  it('execution layer cannot subscribe to inbound.message — throws at registration', () => {
    const bus = new EventBus(logger);
    expect(() =>
      bus.subscribe('inbound.message', 'execution', vi.fn()),
    ).toThrow(/not authorized to subscribe/);
  });

  it('agent layer cannot subscribe to inbound.message — throws at registration', () => {
    const bus = new EventBus(logger);
    // Agents receive tasks via agent.task, not raw inbound messages
    expect(() =>
      bus.subscribe('inbound.message', 'agent', vi.fn()),
    ).toThrow(/not authorized to subscribe/);
  });

  it('human.decision can be published by dispatch but not by agent', async () => {
    const bus = new EventBus(logger);
    const decisionEvent = createHumanDecision({
      decision: 'approve',
      deciderId: 'joseph@example.com',
      deciderChannel: 'email',
      subjectEventId: 'outbound-event-1',
      subjectSummary: 'Send project update email to board',
      contextShown: ['Email subject', 'Email body preview'],
      presentedAt: new Date('2026-04-09T10:00:00Z'),
      decidedAt: new Date('2026-04-09T10:02:00Z'),
      defaultAction: 'block',
      autonomyTier: 'elevated_skill',
      parentEventId: 'outbound-1',
    });

    // dispatch can publish human.decision (approval gates are enforced at the dispatch layer)
    await expect(bus.publish('dispatch', decisionEvent)).resolves.toBeUndefined();

    // agent cannot — approval decisions are not the agent's responsibility
    await expect(bus.publish('agent', decisionEvent)).rejects.toThrow(
      /not authorized to publish/,
    );
  });

  it('llm.call can be published by agent but not by dispatch', async () => {
    const bus = new EventBus(logger);
    const llmEvent = createLlmCall({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      requestedModel: 'claude-sonnet-4-6',
      actualModel: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 150,
      outputTokens: 75,
      estimatedCostUsd: 0.0015,
      latencyMs: 1200,
      providerRequestId: 'req-xyz789',
      promptHash: '112233',
      responseHash: '445566',
      parentEventId: 'task-2',
    });

    // agent can publish llm.call (the agent runtime makes LLM calls)
    await expect(bus.publish('agent', llmEvent)).resolves.toBeUndefined();

    // dispatch cannot — dispatch routes messages, it doesn't invoke the LLM directly
    await expect(bus.publish('dispatch', llmEvent)).rejects.toThrow(
      /not authorized to publish/,
    );
  });

  it('system layer can publish events from any other layer (no restrictions)', async () => {
    const bus = new EventBus(logger);
    // system layer is unrestricted — audit logger and scheduler publish as system
    const inbound = createInboundMessage({
      conversationId: 'conv-sys',
      channelId: 'cli',
      senderId: 'local-user',
      content: 'System test',
    });
    await expect(bus.publish('system', inbound)).resolves.toBeUndefined();
  });
});
