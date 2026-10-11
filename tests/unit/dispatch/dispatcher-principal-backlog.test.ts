// tests/unit/dispatch/dispatcher-principal-backlog.test.ts
//
// The backlog counts on principal turns (prompt trim PR 7): the dispatcher counts what is
// waiting on the principal and sets `principalBacklog` on the agent.task when anything is.
// Only on a live principal turn, never inside `content`, and a failed count costs only the
// line.

import { describe, it, expect, vi } from 'vitest';
import type { PrincipalBacklogCounts } from '../../../src/agents/prompts/backlog-line.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createInboundMessage, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import type { PrincipalBacklogSource } from '../../../src/dispatch/principal-backlog.js';
import { createLogger } from '../../../src/logger.js';

function resolverFor(principal: boolean): ContactResolver {
  return {
    resolve: async () => ({
      resolved: true,
      contactId: principal ? 'principal-1' : 'contact-other-1',
      displayName: principal ? 'Principal' : 'Other Contact',
      role: null,
      systemRole: principal ? 'principal' : null,
      tier: principal ? 'principal' : 'known',
      kind: 'person',
      verified: true,
      kgNodeId: null,
      knowledgeSummary: '',
      authorization: null,
      contactConfidence: 0.9,
    }),
  } as unknown as ContactResolver;
}

function buildHarness(principal: boolean, counts: () => Promise<PrincipalBacklogCounts>) {
  const logger = createLogger('error');
  const errorSpy = vi.spyOn(logger, 'error');
  const bus = new EventBus(logger);
  const tasks: AgentTaskEvent[] = [];
  const source = { counts: vi.fn(counts) } satisfies PrincipalBacklogSource;
  new Dispatcher({ bus, logger, contactResolver: resolverFor(principal), principalBacklog: source }).register();
  bus.subscribe('agent.task', 'agent', (e) => {
    tasks.push(e as AgentTaskEvent);
  });
  const send = () => bus.publish('channel', createInboundMessage({
    conversationId: 'signal:+15551234567',
    channelId: 'signal',
    senderId: '+15551234567',
    content: 'Can you book the usual table for Friday?',
  }));
  return { tasks, source, send, errorSpy };
}

describe('Dispatcher principal backlog (prompt trim PR 7)', () => {
  it('sets the counts on a principal turn with something waiting, beside the content', async () => {
    const counts = { decayWarnings: 1, pendingApprovals: 2, principalTasks: 0 };
    const { tasks, send } = buildHarness(true, async () => counts);
    await send();
    expect(tasks[0]!.payload.principalBacklog).toEqual(counts);
    expect(tasks[0]!.payload.content).toBe('Can you book the usual table for Friday?');
  });

  it('sets nothing when nothing is waiting', async () => {
    const { tasks, send } = buildHarness(true, async () => ({ decayWarnings: 0, pendingApprovals: 0, principalTasks: 0 }));
    await send();
    expect(tasks[0]!.payload).not.toHaveProperty('principalBacklog');
  });

  it('never counts on a turn from anyone else', async () => {
    const { tasks, source, send } = buildHarness(false, async () => ({ decayWarnings: 1, pendingApprovals: 1, principalTasks: 1 }));
    await send();
    expect(source.counts).not.toHaveBeenCalled();
    expect(tasks[0]!.payload).not.toHaveProperty('principalBacklog');
  });

  it('routes the turn without the counts when counting fails, and logs it', async () => {
    const { tasks, send, errorSpy } = buildHarness(true, async () => {
      throw new Error('connection reset');
    });
    await send();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.payload).not.toHaveProperty('principalBacklog');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('principal backlog'),
    );
  });
});
