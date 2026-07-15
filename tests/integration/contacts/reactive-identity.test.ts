// Reactive identity establishment (unknown-sender flow) — real Dispatcher + bus (#1382).
//
// Two real steps:
//   A) Channel adapters create tier='unknown' contacts (modeled here via ContactService
//      with source email_participant — the dispatcher itself does NOT create contacts).
//   B) Dispatcher routes unknown / unknown-tier senders per channelPolicies.

import { it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import {
  createInboundMessage,
  type ContactUnknownEvent,
  type ContactResolvedEvent,
  type MessageRejectedEvent,
  type AgentTaskEvent,
} from '../../../src/bus/events.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import {
  describeIf,
  makeRunId,
  createContactStack,
  type ContactTestStack,
} from './harness.js';

const MOCK_PROVENANCE = {
  requestedModel: 'mock-model',
  actualModel: 'mock-model',
  providerRequestId: 'msg_mock_reactive',
} as const;

describeIf('Contact resolution: reactive identity establishment', () => {
  let stack: ContactTestStack;
  const runId = makeRunId();

  beforeAll(async () => {
    stack = await createContactStack();
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  function wireDispatch(policies: Record<string, { trust: 'low' | 'medium' | 'high'; unknownSender: 'allow' | 'ignore'; threaded: boolean }>) {
    const bus = new EventBus(stack.logger);
    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'Acknowledged.',
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: MOCK_PROVENANCE,
      }),
    };
    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider: mockProvider,
      bus,
      logger: stack.logger,
    });
    coordinator.register();

    const dispatcher = new Dispatcher({
      bus,
      logger: stack.logger,
      contactResolver: stack.resolver,
      channelPolicies: policies,
    });
    dispatcher.register();

    const unknownEvents: ContactUnknownEvent[] = [];
    const resolvedEvents: ContactResolvedEvent[] = [];
    const rejectedEvents: MessageRejectedEvent[] = [];
    const taskEvents: AgentTaskEvent[] = [];

    bus.subscribe('contact.unknown', 'system', (e) => { unknownEvents.push(e as ContactUnknownEvent); });
    bus.subscribe('contact.resolved', 'system', (e) => { resolvedEvents.push(e as ContactResolvedEvent); });
    bus.subscribe('message.rejected', 'system', (e) => { rejectedEvents.push(e as MessageRejectedEvent); });
    bus.subscribe('agent.task', 'agent', (e) => { taskEvents.push(e as AgentTaskEvent); });

    return { bus, unknownEvents, resolvedEvents, rejectedEvents, taskEvents };
  }

  it('step A: unknown sender persisted as tier=unknown then resolves', async () => {
    // Models channel-adapter auto-create (email-adapter / signal-adapter), not the dispatcher.
    const email = `reactive-unknown-${runId}@example.com`;
    const contact = await stack.contactService.createContact({
      displayName: email,
      source: 'email_participant',
      tier: 'unknown',
    });
    stack.trackContact(contact.id, contact.kgNodeId);

    const identity = await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'email_participant',
    });
    expect(identity.verified).toBe(true); // email_participant is AUTO_VERIFIED

    const resolved = await stack.resolver.resolve('email', email);
    expect(resolved.resolved).toBe(true);
    if (!resolved.resolved) return;
    expect(resolved.tier).toBe('unknown');
    expect(resolved.verified).toBe(true);
  });

  it('truly-unknown sender with allow policy: contact.unknown + agent.task, no reject', async () => {
    const email = `truly-unknown-${runId}@example.com`;
    const { bus, unknownEvents, rejectedEvents, taskEvents } = wireDispatch({
      email: { trust: 'low', unknownSender: 'allow', threaded: true },
    });

    await bus.publish('channel', createInboundMessage({
      conversationId: `email:${email}:1`,
      channelId: 'email',
      senderId: email,
      content: 'Hello from a stranger',
    }));

    expect(unknownEvents).toHaveLength(1);
    expect(unknownEvents[0]!.payload.routingDecision).toBe('allow');
    expect(unknownEvents[0]!.payload.senderId).toBe(email);
    expect(taskEvents).toHaveLength(1);
    expect(rejectedEvents).toHaveLength(0);
  });

  it('resolved tier=unknown (non-automated) routes to coordinator; contact.resolved fires', async () => {
    const email = `unknown-tier-route-${runId}@example.com`;
    const contact = await stack.contactService.createContact({
      displayName: `Unknown Tier ${runId}`,
      source: 'email_participant',
      tier: 'unknown',
      kind: 'person',
    });
    stack.trackContact(contact.id, contact.kgNodeId);
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'email_participant',
    });

    const { bus, unknownEvents, resolvedEvents, rejectedEvents, taskEvents } = wireDispatch({
      email: { trust: 'low', unknownSender: 'allow', threaded: true },
    });

    await bus.publish('channel', createInboundMessage({
      conversationId: `email:${email}:1`,
      channelId: 'email',
      senderId: email,
      content: 'Following up',
    }));

    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]!.payload.contactId).toBe(contact.id);
    expect(unknownEvents).toHaveLength(0);
    expect(rejectedEvents).toHaveLength(0);
    expect(taskEvents).toHaveLength(1);
  });

  it('unknownSender=ignore rejects truly-unknown with reason unknown_sender, no agent.task', async () => {
    const email = `ignored-stranger-${runId}@example.com`;
    const { bus, unknownEvents, rejectedEvents, taskEvents } = wireDispatch({
      email: { trust: 'low', unknownSender: 'ignore', threaded: true },
    });

    await bus.publish('channel', createInboundMessage({
      conversationId: `email:${email}:1`,
      channelId: 'email',
      senderId: email,
      content: 'Please ignore me',
    }));

    expect(unknownEvents).toHaveLength(1);
    expect(unknownEvents[0]!.payload.routingDecision).toBe('ignore');
    expect(rejectedEvents).toHaveLength(1);
    expect(rejectedEvents[0]!.payload.reason).toBe('unknown_sender');
    expect(taskEvents).toHaveLength(0);
  });

  it('tier=blocked is dropped with message.rejected reason blocked_sender', async () => {
    const email = `blocked-${runId}@example.com`;
    const contact = await stack.contactService.createContact({
      displayName: `Blocked ${runId}`,
      source: 'email_participant',
      tier: 'known',
    });
    stack.trackContact(contact.id, contact.kgNodeId);
    await stack.contactService.setTier(contact.id, 'blocked');
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'email_participant',
    });

    const { bus, rejectedEvents, taskEvents } = wireDispatch({
      email: { trust: 'low', unknownSender: 'allow', threaded: true },
    });

    await bus.publish('channel', createInboundMessage({
      conversationId: `email:${email}:1`,
      channelId: 'email',
      senderId: email,
      content: 'Should be dropped',
    }));

    expect(rejectedEvents).toHaveLength(1);
    expect(rejectedEvents[0]!.payload.reason).toBe('blocked_sender');
    expect(taskEvents).toHaveLength(0);
  });

  it('kind=automated + tier=unknown bypasses the gate and routes normally', async () => {
    const email = `automated-${runId}@noreply.example.com`;
    const contact = await stack.contactService.createContact({
      displayName: `Automated ${runId}`,
      source: 'email_participant',
      tier: 'unknown',
      kind: 'automated',
    });
    stack.trackContact(contact.id, contact.kgNodeId);
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'email_participant',
    });

    // Even with ignore policy, automated unknown-tier bypasses the gate.
    const { bus, rejectedEvents, resolvedEvents, taskEvents } = wireDispatch({
      email: { trust: 'low', unknownSender: 'ignore', threaded: true },
    });

    await bus.publish('channel', createInboundMessage({
      conversationId: `email:${email}:1`,
      channelId: 'email',
      senderId: email,
      content: 'Calendar invite notification',
    }));

    expect(resolvedEvents).toHaveLength(1);
    expect(rejectedEvents).toHaveLength(0);
    expect(taskEvents).toHaveLength(1);
  });
});
