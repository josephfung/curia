// Relayed-send attribution (#1972), end to end through the real ExecutionLayer.
//
// ceo-inbox has no send tools. To reach the principal it opens a bullpen thread
// asking the coordinator to send, and the coordinator's send registers the
// outbound-context entry that routes the principal's reply. This checks that the
// entry names ceo-inbox as owner whatever the coordinator wrote into
// context_bridge, including when it wrote nothing (the escalation formats).
// No database: the outbound-context service and transports are mocked, as in
// outbound-delivered-emission.test.ts.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { EventBus } from '../../src/bus/bus.js';
import { ToolRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer, type InvokeOptions } from '../../src/skills/execution.js';
import { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import type { ToolManifest } from '../../src/skills/types.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../src/dispatch/outbound-filter.js';
import type { OutboundContextService } from '../../src/dispatch/outbound-context.js';
import { SignalSendHandler } from '../../skills/signal-send/handler.js';
import signalSendManifest from '../../skills/signal-send/tool.json' with { type: 'json' };
import type { SignalRpcClient } from '../../src/channels/signal/signal-rpc-client.js';

const logger = pino({ level: 'silent' });

function setup() {
  const bus = new EventBus(logger);
  const signalClient = {
    send: vi.fn().mockResolvedValue('1700000000999'),
    listGroups: vi.fn().mockResolvedValue([]),
    isConnected: vi.fn().mockReturnValue(true),
  } as unknown as SignalRpcClient;
  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue({
      contactId: 'contact-principal', displayName: 'Principal', role: null,
      tier: 'known', kgNodeId: null, verified: true,
    }),
  } as unknown as ContactService;
  const contentFilter = {
    check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
  } as unknown as OutboundContentFilter;
  const register = vi.fn().mockResolvedValue('entry-1');
  const outboundContextService = {
    defaultExpiryHours: 6,
    explicitExpiryHours: 24,
    defaultExpiryHoursFor: () => 6,
    register,
    release: vi.fn().mockResolvedValue(undefined),
  } as unknown as OutboundContextService;
  const outboundGateway = new OutboundGateway({
    signalClient, signalPhoneNumber: '+15550001111', contactService, contentFilter, bus,
    principalIdentities: [], logger,
  });

  const agentRegistry = new AgentRegistry();
  agentRegistry.register('coordinator', { role: 'coordinator', description: 'router' });
  agentRegistry.register('ceo-inbox', { role: 'specialist', description: 'inbox' });

  const registry = new ToolRegistry();
  registry.register(signalSendManifest as ToolManifest, new SignalSendHandler());
  const executionLayer = new ExecutionLayer(registry, logger, {
    bus, outboundGateway, contactService, outboundContextService, agentRegistry,
  });
  return { executionLayer, register };
}

const relayWake: InvokeOptions = {
  agentId: 'coordinator',
  taskEventId: 'task-1',
  conversationId: 'thread-1',
  channelId: 'bullpen',
  taskMetadata: { taskOrigin: 'bullpen', threadId: 'thread-1', mentioned: true, threadCreatorAgentId: 'ceo-inbox' },
};

describe('relayed send attribution (#1972)', () => {
  it('attributes the entry to the specialist that asked for the send, replacing a free-text hint', async () => {
    const { executionLayer, register } = setup();
    const result = await executionLayer.invoke(
      'signal-send',
      {
        recipient_number: '+15555550199',
        message: 'Dana proposes Wednesday 2pm instead. Accept?',
        context_bridge: JSON.stringify({
          agent_id: 'coordinator',
          expected_reply: 'Decision or follow-up instruction',
          delegation_hint: 'Delegate replies to ceo-inbox',
        }),
      },
      undefined,
      relayWake,
    );
    expect(result.success).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toMatchObject({
      conversationId: 'thread-1',
      agentId: 'ceo-inbox',
      delegationHint: 'ceo-inbox',
      expectedReply: 'Decision or follow-up instruction',
    });
  });

  it('adds the owner when the relay carried no context_bridge at all', async () => {
    const { executionLayer, register } = setup();
    const result = await executionLayer.invoke(
      'signal-send',
      { recipient_number: '+15555550199', message: 'Scheduling reply could not be drafted for Partnership call.' },
      undefined,
      relayWake,
    );
    expect(result.success).toBe(true);
    expect(register.mock.calls[0]![0]).toMatchObject({ agentId: 'ceo-inbox', delegationHint: 'ceo-inbox' });
  });

  it('leaves the coordinator\'s own send unattributed, dropping a hint that names no specialist', async () => {
    const { executionLayer, register } = setup();
    const result = await executionLayer.invoke(
      'signal-send',
      {
        recipient_number: '+15555550199',
        message: 'Departure-day confirm for Friday.',
        context_bridge: JSON.stringify({ agent_id: 'coordinator', delegation_hint: 'calendar-specialist' }),
      },
      undefined,
      { agentId: 'coordinator', taskEventId: 'task-2', conversationId: 'scheduler:job-1', channelId: 'scheduler' },
    );
    expect(result.success).toBe(true);
    const registered = register.mock.calls[0]![0];
    expect(registered.agentId).toBe('coordinator');
    expect(registered).not.toHaveProperty('delegationHint');
  });
});
