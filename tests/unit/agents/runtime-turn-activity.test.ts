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
    // No originator: Curia's own work.
    expect(root!.originatorIsSystem).toBe(true);
  });

  it("an internal task carrying a person's originator is that person's turn, not system", async () => {
    const logger = createLogger('error');
    const registry = new TurnActivityRegistry({ logger });
    const provider: LLMProvider = { id: 'mock', chat: vi.fn(() => Promise.resolve(text('ok'))) };
    const { bus } = build(provider, registry);
    const event = task('hello', {
      channelId: 'internal',
      metadata: { originator: { contactId: CONTACT, channel: 'email', systemRole: null, tier: 'known' } },
    });
    await bus.publish('dispatch', event);
    const root = registry.rootOf(event.id)!;
    expect(root.originatorIsSystem).toBe(false);
    expect(root.originatorResolved).toBe(true);
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

  describe("turn-start note of the person's other turns", () => {
    // Signal authenticates its sender (it was SMS until GHSA-p49r-jqh2-v668 stopped counting SMS).
    const ORIGINATOR = { contactId: CONTACT, channel: 'signal', systemRole: null, tier: 'known', authenticated: true };
    const HEADING = '## Your other recent turns with this person';

    /** A running root of the same contact, registered as if another conversation's turn were live. */
    function seedOtherTurn(registry: TurnActivityRegistry): void {
      registry.taskStarted({
        taskEventId: 'other-root',
        agentId: 'coordinator',
        conversationId: 'conv-other',
        channelId: 'signal',
        parentEventId: undefined,
        // As the dispatcher stamps them: the sender's text, a clean scan and an authenticated sender.
        metadata: { inboundSenderText: 'book the 9am flight to Montreal', inboundScanFindingCount: 0, originator: ORIGINATOR },
        startedAt: Date.now() - 60_000,
        originatorContactId: CONTACT,
        originatorResolved: true,
        originatorIsSystem: false,
      });
    }

    /** Latest user message — where the other-turns note lives after #2774. */
    function turnContextOf(chat: ReturnType<typeof vi.fn>): string {
      const params = chat.mock.calls[0]![0] as { messages: { role: string; content: unknown }[] };
      const users = params.messages.filter((m) => m.role === 'user');
      const last = users[users.length - 1];
      return typeof last?.content === 'string' ? last.content : '';
    }

    function systemPromptOf(chat: ReturnType<typeof vi.fn>): string {
      const params = chat.mock.calls[0]![0] as { messages: { role: string; content: unknown }[] };
      const system = params.messages.find((m) => m.role === 'system');
      return typeof system?.content === 'string' ? system.content : '';
    }

    it("injects the block into the coordinator's turn context", async () => {
      const logger = createLogger('error');
      const registry = new TurnActivityRegistry({ logger });
      seedOtherTurn(registry);
      const chat = vi.fn(() => Promise.resolve(text('ok')));
      const { bus } = build({ id: 'mock', chat }, registry);
      await bus.publish('dispatch', task('the 9am flight', { channelId: 'signal', conversationId: 'signal:+15550001', metadata: { originator: ORIGINATOR } }));
      const user = turnContextOf(chat);
      expect(user).toContain('## Current turn context');
      expect(user).toContain(HEADING);
      expect(user).toContain('turn_id other-root');
      expect(user).toContain(JSON.stringify('book the 9am flight to Montreal'));
      expect(systemPromptOf(chat)).not.toContain(HEADING);
    });

    it('runtime injects the block only for the coordinator', async () => {
      const logger = createLogger('error');
      const registry = new TurnActivityRegistry({ logger });
      seedOtherTurn(registry);
      const chat = vi.fn(() => Promise.resolve(text('ok')));
      const { bus } = build({ id: 'mock', chat }, registry);
      // A delegated specialist task carrying the same originator.
      await bus.publish('dispatch', task('delegated', {
        channelId: 'sms',
        metadata: { originator: ORIGINATOR, delegationOrigin: { taskEventId: 'origin-x', conversationId: 'conv-1' } },
      }));
      expect(turnContextOf(chat)).not.toContain(HEADING);
    });

    it('injects nothing when the person has no other turns', async () => {
      const logger = createLogger('error');
      const registry = new TurnActivityRegistry({ logger });
      const chat = vi.fn(() => Promise.resolve(text('ok')));
      const { bus } = build({ id: 'mock', chat }, registry);
      await bus.publish('dispatch', task('hello', { channelId: 'signal', conversationId: 'signal:+15550001', metadata: { originator: ORIGINATOR } }));
      expect(turnContextOf(chat)).not.toContain(HEADING);
    });

    it('a block failure logs at error and the turn runs without it', async () => {
      const logger = createLogger('error');
      const registry = new TurnActivityRegistry({ logger });
      seedOtherTurn(registry);
      vi.spyOn(registry, 'otherRootsInWindow').mockImplementation(() => {
        throw new Error('registry down');
      });
      const chat = vi.fn(() => Promise.resolve(text('ok')));
      const { bus, errorSpy } = build({ id: 'mock', chat }, registry);
      const event = task('hello', { channelId: 'signal', conversationId: 'signal:+15550001', metadata: { originator: ORIGINATOR } });
      await bus.publish('dispatch', event);
      expect(chat).toHaveBeenCalled();
      expect(turnContextOf(chat)).not.toContain(HEADING);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskEventId: event.id }),
        expect.stringContaining('other turns'),
      );
    });
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
