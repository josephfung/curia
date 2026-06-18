import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/bus/bus.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { createInboundMessage, type OutboundMessageEvent, type ContactUnknownEvent, type AgentTaskEvent } from '../../src/bus/events.js';
import type { LLMProvider } from '../../src/agents/llm/provider.js';
const MOCK_PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock_000' } as const;
import { createLogger } from '../../src/logger.js';
import type { ContactResolver } from '../../src/contacts/contact-resolver.js';

describe('Vertical Slice: CLI → Dispatch → Coordinator → Response', () => {
  it('routes an inbound message through the full pipeline', async () => {
    // Silence logs during the test — 'error' level only so test output stays clean.
    const logger = createLogger('error');

    // Capture every event that transits the bus in the order it was published.
    // This simulates the write-ahead audit logger: the onEvent hook fires BEFORE
    // subscriber delivery, so the log order equals the true causal order.
    const auditLog: Array<{ type: string; id: string }> = [];
    const bus = new EventBus(logger, async (event) => {
      auditLog.push({ type: event.type, id: event.id });
    });

    // Mock LLM — returns a fixed response so we can assert the exact content
    // that flows all the way to outbound.message without hitting a real API.
    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'Hello! How can I help you today?',
        usage: { inputTokens: 20, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: MOCK_PROVENANCE,
      }),
    };

    // Wire up the coordinator agent.
    // register() subscribes to agent.task; when a task arrives the runtime calls
    // the LLM and publishes agent.response.
    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider: mockProvider,
      bus,
      logger,
    });
    coordinator.register();

    // Wire up the dispatcher.
    // register() subscribes to inbound.message AND agent.response.
    // It converts inbound.message → agent.task, and agent.response → outbound.message.
    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();

    // Capture outbound messages.
    // In a real deployment the channel adapter (e.g. CLI) would subscribe here.
    // We subscribe from the 'channel' layer because that is the layer allowed to
    // receive outbound.message events per the bus permission map.
    const outbound: OutboundMessageEvent[] = [];
    bus.subscribe('outbound.message', 'channel', (event) => {
      outbound.push(event as OutboundMessageEvent);
    });

    // Simulate the CLI channel adapter publishing user input.
    // createInboundMessage() assigns a UUID and timestamp so the event is fully formed.
    const inbound = createInboundMessage({
      conversationId: 'cli:local:default',
      channelId: 'cli',
      senderId: 'local-user',
      content: 'Good morning!',
    });

    // bus.publish() awaits each subscriber sequentially, so by the time this line
    // resolves the full 4-step chain has run to completion — no setTimeout needed.
    await bus.publish('channel', inbound);

    // -- Assert the response reached the channel --

    // Exactly one outbound message should have been produced.
    expect(outbound).toHaveLength(1);

    // The content should be the mock LLM's verbatim response.
    expect(outbound[0]?.payload.content).toBe('Hello! How can I help you today?');

    // The channel and conversation identifiers must be preserved through the chain
    // so the CLI adapter knows which session to write the reply to.
    expect(outbound[0]?.payload.channelId).toBe('cli');
    expect(outbound[0]?.payload.conversationId).toBe('cli:local:default');

    // -- Assert the complete 6-event audit trail --
    // This sequence is the spec-mandated message flow from 00-overview.md.
    // The order is guaranteed because the bus awaits each publish before returning.
    // context.budget is published after assembly, before the LLM call (#24).
    // llm.call is published inside agent task processing (between agent.task and agent.response).
    expect(auditLog).toHaveLength(6);
    expect(auditLog.map((e) => e.type)).toEqual([
      'inbound.message',  // 1. Channel publishes user input
      'agent.task',       // 2. Dispatcher converts inbound.message to a task for the coordinator
      'context.budget',   // 3. Runtime publishes context budget telemetry after assembly (#24)
      'llm.call',         // 4. Runtime publishes LLM provenance after the API call (spec 10)
      'agent.response',   // 5. Coordinator publishes the LLM result
      'outbound.message', // 6. Dispatcher converts agent.response back to a channel message
    ]);

    // -- Assert the causal chain is intact --
    // outbound.message.parentEventId points to the agent.response that generated it,
    // which in turn points to the agent.task, which points to the inbound.message.
    // If parentEventId is missing the audit trail cannot be reconstructed.
    expect(outbound[0]?.parentEventId).toBeDefined();

    // -- Assert the LLM was called with the correct message list --
    // The coordinator must include the system prompt and user content.
    // Use arrayContaining since the runtime may inject additional system messages
    // (e.g. sender context for unknown senders). This test verifies the pipeline
    // shape, not the exact system message count.
    expect(mockProvider.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: 'system', content: expect.stringContaining('You are a helpful assistant.') },
          { role: 'user', content: 'Good morning!' },
        ]),
      }),
    );

    // Verify turn budget block is wired into the system prompt at runtime.
    const firstCall = (mockProvider.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(firstCall.messages[0]!.content).toContain('## Turn budget');
  });
});

describe('Vertical Slice: Unknown sender email → low-trust routing', () => {
  it('routes unknown sender to coordinator in low-trust mode, fires contact.unknown with routingDecision=allow', async () => {
    // #947: unknown senders are no longer held. They route to the coordinator with
    // a LOW-TRUST SENDER authorization block injected by runtime.ts.
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    // Mock resolver: always returns unknown sender.
    const mockResolver: ContactResolver = {
      resolve: vi.fn().mockResolvedValue({
        resolved: false,
        channel: 'email',
        senderId: 'stranger@example.com',
      }),
    } as unknown as ContactResolver;

    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: mockResolver,
      channelPolicies: { email: { trust: 'low', unknownSender: 'allow', threaded: true } },
    });
    dispatcher.register();

    const unknownEvents: ContactUnknownEvent[] = [];
    const taskEvents: AgentTaskEvent[] = [];
    bus.subscribe('contact.unknown', 'system', (e) => { unknownEvents.push(e as ContactUnknownEvent); });
    bus.subscribe('agent.task', 'agent', (e) => { taskEvents.push(e as AgentTaskEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'email:stranger:1',
      channelId: 'email',
      senderId: 'stranger@example.com',
      content: 'Hey, can we talk?',
    }));

    // Message routes to the coordinator (low-trust mode), not held
    expect(taskEvents).toHaveLength(1);

    // contact.unknown event fires with audit fields and routingDecision=allow
    expect(unknownEvents).toHaveLength(1);
    expect(unknownEvents[0]!.payload.channel).toBe('email');
    expect(unknownEvents[0]!.payload.senderId).toBe('stranger@example.com');
    expect(unknownEvents[0]!.payload.channelTrustLevel).toBe('low');
    // email low channel (0.3 * 0.4 = 0.12) + unknown sender (0.0 * 0.4 = 0.0) = 0.12
    expect(unknownEvents[0]!.payload.messageTrustScore).toBeCloseTo(0.12);
    expect(unknownEvents[0]!.payload.routingDecision).toBe('allow');
  });
});
