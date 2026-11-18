// running-late turn guidance through the dispatcher (#2612): the principal's own words that
// they are behind schedule select it, and a genuine reply still gets the reply-shaped note.

import { describe, it, expect } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { createInboundMessage, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { createLogger } from '../../../src/logger.js';

function resolverFor(tier: 'principal' | 'external'): ContactResolver {
  return {
    resolve: async () => ({
      resolved: true,
      contactId: tier === 'principal' ? 'principal-1' : 'contact-1',
      displayName: tier === 'principal' ? 'Principal' : 'Someone',
      role: null,
      systemRole: tier,
      tier,
      kind: 'person',
      verified: tier === 'principal',
      kgNodeId: null,
      knowledgeSummary: '',
      authorization: null,
      contactConfidence: 0.9,
    }),
  } as unknown as ContactResolver;
}

interface SendOptions {
  tier?: 'principal' | 'external';
  channelId?: 'signal' | 'email';
}

async function guidanceFor(content: string, opts: SendOptions = {}): Promise<readonly string[]> {
  const { tier = 'principal', channelId = 'signal' } = opts;
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  new Dispatcher({ bus, logger, contactResolver: resolverFor(tier) }).register();
  const tasks: AgentTaskEvent[] = [];
  bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });
  const email = channelId === 'email';
  await bus.publish('channel', createInboundMessage({
    conversationId: email ? 'email:thread-1' : 'signal:+15551234567',
    channelId,
    senderId: email ? 'principal@example.test' : '+15551234567',
    content,
    ...(email ? { metadata: { senderVerified: true } } : {}),
  }));
  expect(tasks).toHaveLength(1);
  return tasks[0]!.payload.turnGuidance ?? [];
}

describe('Dispatcher — running-late guidance (#2612)', () => {
  it('selects running-late instead of the reply-shaped note for the principal on Signal', async () => {
    const keys = await guidanceFor("I'm running about ten minutes behind");
    expect(keys).toContain('running-late');
    expect(keys).not.toContain('principal-reply-shaped');
  });

  it("selects it for an email whose own Subject carries the status", async () => {
    const keys = await guidanceFor('Subject: Running late\n\nThanks', { channelId: 'email' });
    expect(keys).toContain('running-late');
    expect(keys).toContain('email-direct-reply');
    expect(keys).not.toContain('principal-reply-shaped');
  });

  it('keeps the reply-shaped note for a genuine reply', async () => {
    const keys = await guidanceFor('The second one');
    expect(keys).toContain('principal-reply-shaped');
    expect(keys).not.toContain('running-late');
  });

  it("ignores lateness quoted from someone else", async () => {
    const keys = await guidanceFor("> I'm running late\nNo, I'm on time.");
    expect(keys).not.toContain('running-late');
    expect(keys).toContain('principal-reply-shaped');
  });

  it("ignores someone else's delay", async () => {
    const keys = await guidanceFor('Dana is stuck in traffic, start without her.');
    expect(keys).not.toContain('running-late');
    expect(keys).toContain('principal-reply-shaped');
  });

  it('does not select running-late for anyone but the principal', async () => {
    const keys = await guidanceFor("I'm running ten minutes behind", { tier: 'external' });
    expect(keys).not.toContain('running-late');
    expect(keys).toContain('non-principal-reply-shaped');
  });
});
