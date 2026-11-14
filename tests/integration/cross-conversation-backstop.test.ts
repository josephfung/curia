// Cross-conversation backstop (#2588), reproducing the 2026-11-11 incident: the principal's
// email turn and Signal turn both booked the same meeting and both emailed the same third
// party. No database: in-memory bus and working memory, a real Dispatcher, TurnLanes,
// AgentRuntime and ExecutionLayer, and a scripted model. Only the two tool handlers are fakes.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { TurnLanes } from '../../src/dispatch/turn-lanes.js';
import { TurnActivityRegistry } from '../../src/dispatch/turn-activity.js';
import { EventBus } from '../../src/bus/bus.js';
import { createInboundMessage } from '../../src/bus/events.js';
import type { LLMProvider, LLMResponse } from '../../src/agents/llm/provider.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import { ToolRegistry } from '../../src/skills/registry.js';
import type { ToolHandler, ToolManifest } from '../../src/skills/types.js';
import type { ContactResolver } from '../../src/contacts/contact-resolver.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import type { ChannelIdentity } from '../../src/contacts/types.js';
import type { InboundScanner } from '../../src/dispatch/inbound-scanner.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { createLogger } from '../../src/logger.js';

const CONTACT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // the principal
const CONTACT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // the third party
const CONTACT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // another third party
const CONTACT_G = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // a second, unrelated sender
const USAGE = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock' } as const;
// The tool-error wrapper XML-escapes the apostrophe, so match the part after it.
const HOLD_TEXT = 'already acted on the same target';

function text(content: string): LLMResponse {
  return { type: 'text', content, usage: USAGE, provenance: PROVENANCE };
}

function toolUse(name: string, input: Record<string, unknown> = {}): LLMResponse {
  return {
    type: 'tool_use',
    toolCalls: [{ id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`, name, input }],
    content: '',
    usage: USAGE,
    provenance: PROVENANCE,
  };
}

function person(contactId: string, systemRole: 'principal' | null, displayName: string) {
  return {
    resolved: true as const,
    contactId,
    displayName,
    role: null,
    systemRole,
    tier: systemRole === 'principal' ? 'principal' as const : 'known' as const,
    kind: 'person' as const,
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence: 1,
  };
}

function manifest(name: string, actionRisk: 'medium' | 'high'): ToolManifest {
  return {
    name,
    description: `${name} description`,
    version: '1.0.0',
    sensitivity: 'normal',
    action_risk: actionRisk,
    inputs: {},
    outputs: {},
    permissions: [],
    secrets: [],
    timeout: 5000,
  };
}

const PRINCIPAL_IDENTITIES: ChannelIdentity[] = [
  {
    id: 'id-signal',
    contactId: CONTACT_A,
    channel: 'signal',
    channelIdentifier: '+15550000001',
    label: null,
    verified: true,
    verifiedAt: new Date(),
    status: 'active',
    source: 'ceo_stated',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const CONTACT_NAMES: Record<string, string> = {
  [CONTACT_A]: 'Ada Lovelace',
  [CONTACT_B]: 'Barbara Liskov',
  [CONTACT_C]: 'Carol Shaw',
  [CONTACT_G]: 'Grace Hopper',
};

function harness(contacts: Record<string, ReturnType<typeof person>>) {
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  const lanes = new TurnLanes({
    enabled: true,
    maxInjectionsPerTurn: 5,
    extraRoundsPerInjection: 2,
    laneWaitTimeoutMs: 60_000,
    logger: pino({ level: 'silent' }),
  });
  const resolver = {
    resolve: async (channel: string, senderId: string) =>
      contacts[senderId] ?? { resolved: false, channel, senderId },
  } as unknown as ContactResolver;
  const scanner = {
    scan: (raw: string) => ({ sanitizedContent: raw, riskScore: 0, findings: [] }),
  } as unknown as InboundScanner;

  const turnActivity = new TurnActivityRegistry({ logger });
  const toolRegistry = new ToolRegistry();
  const booking: ToolHandler & { execute: ReturnType<typeof vi.fn> } = {
    execute: vi.fn().mockResolvedValue({ success: true, data: { booked: true } }),
  };
  const email: ToolHandler & { execute: ReturnType<typeof vi.fn> } = {
    execute: vi.fn().mockResolvedValue({ success: true, data: { sent: true } }),
  };
  toolRegistry.register(manifest('calendar-create-event', 'high'), booking);
  toolRegistry.register(manifest('email-send', 'medium'), email);
  const contactService = {
    getContact: vi.fn(async (id: string) => (CONTACT_NAMES[id] ? { id, displayName: CONTACT_NAMES[id] } : undefined)),
    getContactWithIdentities: vi.fn(async (id: string) => (id === CONTACT_A
      ? { contact: { id, displayName: CONTACT_NAMES[id], primaryEmail: null, primaryPhone: null }, identities: PRINCIPAL_IDENTITIES }
      : undefined)),
    getIdentitiesForContact: vi.fn().mockResolvedValue([]),
  } as unknown as ContactService;
  const executionLayer = new ExecutionLayer(toolRegistry, logger, {
    contactService,
    principalIdentities: PRINCIPAL_IDENTITIES,
    timezone: 'America/Toronto',
    turnActivity,
  });

  // The script is per turn, found by the marker in the user's request, so the order in
  // which the two turns' model calls interleave does not matter.
  const chatsByTurn = new Map<string, unknown[][]>();
  const scripts = new Map<string, Array<(messages: unknown) => LLMResponse>>();
  const provider: LLMProvider = {
    id: 'mock',
    chat: vi.fn(async (params: { messages: unknown[] }) => {
      const dump = JSON.stringify(params.messages);
      // A principal's turn also sees their other conversation's messages, so the turn's own
      // request is the marker that appears last.
      const marker = [...scripts.keys()]
        .filter((key) => dump.includes(key))
        .sort((a, b) => dump.lastIndexOf(b) - dump.lastIndexOf(a))[0];
      if (!marker) return text('done');
      const seen = chatsByTurn.get(marker) ?? [];
      seen.push(params.messages);
      chatsByTurn.set(marker, seen);
      const step = scripts.get(marker)![seen.length - 1];
      return step ? step(params.messages) : text('done');
    }),
  };

  new Dispatcher({
    bus,
    logger,
    contactResolver: resolver,
    turnLanes: lanes,
    injectionScanner: scanner,
  }).register();
  new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'x',
    provider,
    resolvedModel: 'mock-model',
    bus,
    logger,
    turnLanes: lanes,
    memory: WorkingMemory.createInMemory(),
    timezone: 'America/Toronto',
    executionLayer,
    turnActivity,
  }).register();

  function inbound(content: string, senderId: string, conversationId: string, channelId: string) {
    return createInboundMessage({ conversationId, channelId, senderId, content });
  }

  function script(marker: string, steps: Array<(messages: unknown) => LLMResponse>) {
    scripts.set(marker, steps);
  }

  /** Everything the model was shown in the turn, as one string. */
  function transcript(marker: string): string {
    return JSON.stringify(chatsByTurn.get(marker) ?? []);
  }

  return { bus, booking, email, inbound, script, transcript };
}

const book = (attendee: string) => () =>
  toolUse('calendar-create-event', { attendees: [attendee], title: 'Sync', start: '2026-11-12T15:00:00-05:00' });
const mail = (recipient: string) => () =>
  toolUse('email-send', { recipient, subject: 'Sync', body: 'Booked for Thursday 3pm.' });
const say = (content: string) => () => text(content);

describe('cross-conversation backstop (#2588)', () => {
  it('same scheduling request on email and Signal yields one booking and one outbound email', async () => {
    const h = harness({
      'ada@example.com': person(CONTACT_A, 'principal', 'Ada Lovelace'),
      '+15550000001': person(CONTACT_A, 'principal', 'Ada Lovelace'),
    });
    h.script('EMAIL-REQUEST', [book(CONTACT_B), mail(CONTACT_B), say('Booked and sent.')]);
    // The Signal turn books. If the call is held it declines in text; if it ran, it emails too.
    h.script('SIGNAL-REQUEST', [
      book(CONTACT_B),
      (messages) => (JSON.stringify(messages).includes(HOLD_TEXT)
        ? text('That was already handled, so I stopped.')
        : mail(CONTACT_B)()),
      say('Booked and sent.'),
    ]);

    const emailTurn = h.bus.publish('channel', h.inbound('EMAIL-REQUEST set up a sync with Barbara', 'ada@example.com', 'email:thread-1', 'email'));
    await vi.waitFor(() => expect(h.booking.execute).toHaveBeenCalledTimes(1));
    const signalTurn = h.bus.publish('channel', h.inbound('SIGNAL-REQUEST set up a sync with Barbara', '+15550000001', 'signal:+15550000001', 'signal'));
    await Promise.all([emailTurn, signalTurn]);

    expect.soft(h.booking.execute).toHaveBeenCalledTimes(1);
    expect.soft(h.email.execute).toHaveBeenCalledTimes(1);
    expect(h.transcript('SIGNAL-REQUEST')).toContain(HOLD_TEXT);
    expect(h.transcript('EMAIL-REQUEST')).not.toContain(HOLD_TEXT);
  });

  it('two unrelated concurrent requests are never held', async () => {
    const h = harness({
      'ada@example.com': person(CONTACT_A, 'principal', 'Ada Lovelace'),
      'grace@example.com': person(CONTACT_G, null, 'Grace Hopper'),
    });
    h.script('FIRST-REQUEST', [book(CONTACT_B), mail(CONTACT_B), say('done one')]);
    h.script('SECOND-REQUEST', [book(CONTACT_C), mail(CONTACT_C), say('done two')]);

    const first = h.bus.publish('channel', h.inbound('FIRST-REQUEST sync with Barbara', 'ada@example.com', 'email:thread-1', 'email'));
    await vi.waitFor(() => expect(h.booking.execute).toHaveBeenCalledTimes(1));
    const second = h.bus.publish('channel', h.inbound('SECOND-REQUEST sync with Carol', 'grace@example.com', 'email:thread-2', 'email'));
    await Promise.all([first, second]);

    expect(h.booking.execute).toHaveBeenCalledTimes(2);
    expect(h.email.execute).toHaveBeenCalledTimes(2);
    expect(h.transcript('FIRST-REQUEST')).not.toContain(HOLD_TEXT);
    expect(h.transcript('SECOND-REQUEST')).not.toContain(HOLD_TEXT);
  });
});
