// Runtime feeds the turn activity registry (#2588): every task start and end is
// recorded, and a registry failure never fails the turn.

import { describe, it, expect, vi } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { TurnActivityRegistry } from '../../../src/dispatch/turn-activity.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { LLMProvider, LLMResponse } from '../../../src/agents/llm/provider.js';
import { createLogger } from '../../../src/logger.js';

const USAGE = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const PROVENANCE = {
  requestedModel: 'mock-model',
  actualModel: 'mock-model',
  providerRequestId: 'msg_mock_000',
} as const;
const CONTACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function text(content: string): LLMResponse {
  return { type: 'text', content, usage: USAGE, provenance: PROVENANCE };
}

function task(content: string, overrides: Partial<AgentTaskEvent['payload']> = {}): AgentTaskEvent {
  return createAgentTask({
    agentId: 'coordinator',
    conversationId: 'conv-1',
    channelId: 'email',
    senderId: CONTACT,
    content,
    parentEventId: `parent-${content}`,
    ...overrides,
  });
}

function build(provider: LLMProvider, registry: TurnActivityRegistry) {
  const logger = createLogger('error');
  const errorSpy = vi.spyOn(logger, 'error');
  const bus = new EventBus(logger);
  new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'x',
    provider,
    resolvedModel: 'mock-model',
    bus,
    logger,
    turnActivity: registry,
  }).register();
  return { bus, errorSpy, logger };
}

describe('runtime turn activity (#2588)', () => {
  it('registers start and end for every task', async () => {
    const logger = createLogger('error');
    const registry = new TurnActivityRegistry({ logger });
    const provider: LLMProvider = { id: 'mock', chat: vi.fn(() => Promise.resolve(text('ok'))) };
    const { bus } = build(provider, registry);
    const event = task('hello');
    await bus.publish('dispatch', event);
    const root = registry.rootOf(event.id);
    expect(root).toBeDefined();
    expect(root!.endedAt).not.toBeNull();
    expect(root!.originatorContactId).toBe(null);
  });

  it('ends the task even when the turn throws', async () => {
    const logger = createLogger('error');
    const registry = new TurnActivityRegistry({ logger });
    const provider: LLMProvider = { id: 'mock', chat: vi.fn(() => Promise.reject(new Error('boom'))) };
    const { bus } = build(provider, registry);
    const event = task('hello');
    await bus.publish('dispatch', event);
    expect(registry.rootOf(event.id)?.endedAt).not.toBeNull();
  });

  it('delegated task registers under its root', async () => {
    const logger = createLogger('error');
    const registry = new TurnActivityRegistry({ logger });
    const provider: LLMProvider = { id: 'mock', chat: vi.fn(() => Promise.resolve(text('ok'))) };
    const { bus } = build(provider, registry);
    // The delegation origin is a root the registry already knows.
    const coord = task('coordinator turn');
    await bus.publish('dispatch', coord);
    const event = task('delegated', {
      metadata: { delegationOrigin: { taskEventId: coord.id, conversationId: 'conv-1' } },
    });
    await bus.publish('dispatch', event);
    expect(registry.rootOf(event.id)?.rootId).toBe(coord.id);
  });

  it('registry error does not fail the turn', async () => {
    const logger = createLogger('error');
    const registry = new TurnActivityRegistry({ logger });
    vi.spyOn(registry, 'taskStarted').mockImplementation(() => {
      throw new Error('registry down');
    });
    const chat = vi.fn(() => Promise.resolve(text('ok')));
    const provider: LLMProvider = { id: 'mock', chat };
    const { bus, errorSpy } = build(provider, registry);
    await bus.publish('dispatch', task('hello'));
    expect(chat).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});
