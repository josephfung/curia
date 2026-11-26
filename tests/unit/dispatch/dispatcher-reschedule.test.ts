// reschedule turn guidance through the dispatcher (#2608): only the principal's own words
// select it, so a quoted line, a refusal or another sender's message does not.

import { describe, it, expect } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { createInboundMessage, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { createLogger } from '../../../src/logger.js';

function resolverFor(systemRole: 'principal' | null): ContactResolver {
  return {
    resolve: async () => ({
      resolved: true,
      contactId: systemRole === 'principal' ? 'principal-1' : 'contact-1',
      displayName: systemRole === 'principal' ? 'Principal' : 'Priya',
      role: null,
      systemRole,
      tier: systemRole === 'principal' ? 'principal' : 'known',
      kind: 'person',
      verified: true,
      kgNodeId: null,
      knowledgeSummary: '',
      authorization: null,
      contactConfidence: 0.9,
    }),
  } as unknown as ContactResolver;
}

async function guidanceFor(content: string, systemRole: 'principal' | null = 'principal'): Promise<readonly string[]> {
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  new Dispatcher({ bus, logger, contactResolver: resolverFor(systemRole) }).register();
  const tasks: AgentTaskEvent[] = [];
  bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });
  await bus.publish('channel', createInboundMessage({
    conversationId: 'signal:+15551234567',
    channelId: 'signal',
    senderId: '+15551234567',
    content,
    // A one-to-one Signal message: reschedule, like running-late, needs one.
    metadata: { isGroup: false },
  }));
  expect(tasks).toHaveLength(1);
  return tasks[0]!.payload.turnGuidance ?? [];
}

describe('Dispatcher — reschedule guidance (#2608)', () => {
  it('selects reschedule for the principal asking to move a meeting or get time', async () => {
    expect(await guidanceFor('I need to move my Thursday 2pm with Priya. Something came up.')).toContain('reschedule');
    expect(await guidanceFor('Find 30 minutes with Priya this week to go over the roadmap.')).toContain('reschedule');
  });

  it('ignores a quoted request above the principal\'s own reply', async () => {
    expect(await guidanceFor('> Can we move our 2pm?\nNo, leave it.')).not.toContain('reschedule');
  });

  it('does not select reschedule for a refusal', async () => {
    expect(await guidanceFor("Don't move my Thursday 2pm, I'll make it work.")).not.toContain('reschedule');
  });

  it('does not select reschedule in a group, where the people affected may already know', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    new Dispatcher({ bus, logger, contactResolver: resolverFor('principal') }).register();
    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });
    await bus.publish('channel', createInboundMessage({
      conversationId: 'signal:group:abc',
      channelId: 'signal',
      senderId: '+15551234567',
      content: 'I need to move my Thursday 2pm with Priya.',
      metadata: { isGroup: true, groupId: 'abc' },
    }));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.payload.turnGuidance ?? []).not.toContain('reschedule');
  });

  it('does not select reschedule for someone other than the principal', async () => {
    expect(await guidanceFor('Could we move our 2pm to Friday?', null)).not.toContain('reschedule');
  });
});
