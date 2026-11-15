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
import { createInboundMessage, type AgentResponseEvent } from '../../src/bus/events.js';
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

/** Each contact's email identity: a calendar attendee names a person by address. */
const CONTACT_EMAILS: Record<string, string> = {
  [CONTACT_B]: 'barbara@example.com',
  [CONTACT_C]: 'carol@example.com',
};

type ScriptStep = (messages: unknown) => LLMResponse | Promise<LLMResponse>;

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
    resolveByChannelIdentity: vi.fn(async (channel: string, identifier: string) => {
      const contactId = Object.keys(CONTACT_EMAILS).find((id) => CONTACT_EMAILS[id] === identifier.toLowerCase());
      return channel === 'email' && contactId ? { contactId, displayName: CONTACT_NAMES[contactId] } : null;
    }),
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
  const scripts = new Map<string, ScriptStep[]>();
  const provider: LLMProvider = {
    id: 'mock',
    chat: vi.fn(async (params: { messages: unknown[] }) => {
      const dump = JSON.stringify(params.messages);
      // A principal's turn also sees their other conversation's messages, so the turn's own
      // request is the marker that appears last.
      const marker = [...scripts.keys()]
        .filter((key) => dump.includes(key))
        .sort((a, b) => dump.lastIndexOf(b) - dump.lastIndexOf(a))[0];
      if (!marker) throw new Error('scripted provider: no script matches this turn');
      const seen = chatsByTurn.get(marker) ?? [];
      seen.push(params.messages);
      chatsByTurn.set(marker, seen);
      const step = scripts.get(marker)![seen.length - 1];
      if (!step) throw new Error(`scripted provider: ${marker} has no step ${seen.length - 1}`);
      return step(params.messages);
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

  // Each turn's agent.response, by conversation: what the scheduler and diagnostics read.
  const responses = new Map<string, AgentResponseEvent['payload']>();
  bus.subscribe('agent.response', 'system', async (event) => {
    if (event.type === 'agent.response') responses.set(event.payload.conversationId, event.payload);
  });

  function inbound(content: string, senderId: string, conversationId: string, channelId: string) {
    return createInboundMessage({ conversationId, channelId, senderId, content });
  }

  function script(marker: string, steps: ScriptStep[]) {
    scripts.set(marker, steps);
  }

  /** Everything the model was shown in the turn, as one string. */
  function transcript(marker: string): string {
    return JSON.stringify(chatsByTurn.get(marker) ?? []);
  }

  return { bus, booking, email, inbound, script, transcript, responses };
}

// The real tool's attendee shape (parseWritableAttendees): { email, name? }, so the booking
// names the person by address and the send names them by contact UUID.
const book = (attendee: string) => () =>
  toolUse('calendar-create-event', {
    attendees: [{ email: CONTACT_EMAILS[attendee]!, name: CONTACT_NAMES[attendee]! }],
    title: 'Sync',
    start: '2026-11-12T15:00:00-05:00',
  });
const mail = (recipient: string) => () =>
  toolUse('email-send', { recipient, subject: 'Sync', body: 'Booked for Thursday 3pm.' });
const say = (content: string) => () => text(content);

describe('cross-conversation backstop (#2588)', () => {
  /**
   * Two turns provably in flight at once. The email turn books, then parks on its next model
   * call until the Signal turn's booking attempt has come back and the Signal turn is on its
   * second model call; only then is it released. `overlap` records what the Signal turn saw
   * at that moment: the email turn parked and not finished.
   */
  async function runOverlapping(
    h: ReturnType<typeof harness>,
    opts: { emailSender: string; signalSender: string; emailTarget: string; signalTarget: string },
  ) {
    const release = deferred();
    const state = { emailParked: false, emailDone: false };
    const overlap: { emailParked: boolean; emailDone: boolean }[] = [];
    h.script('EMAIL-REQUEST', [
      book(opts.emailTarget),
      async () => {
        state.emailParked = true;
        await release.promise;
        return mail(opts.emailTarget)();
      },
      () => {
        state.emailDone = true;
        return text('Booked and sent.');
      },
    ]);
    // Signal books. If held it declines in text; if it ran, it emails too.
    h.script('SIGNAL-REQUEST', [
      book(opts.signalTarget),
      (messages) => {
        overlap.push({ ...state });
        release.resolve();
        return JSON.stringify(messages).includes(HOLD_TEXT)
          ? text('That was already handled, so I stopped.')
          : mail(opts.signalTarget)();
      },
      say('Booked and sent.'),
    ]);

    const emailTurn = h.bus.publish('channel', h.inbound('EMAIL-REQUEST set up a sync', opts.emailSender, 'email:thread-1', 'email'));
    try {
      await vi.waitFor(() => expect(state.emailParked).toBe(true));
      const signalTurn = h.bus.publish('channel', h.inbound('SIGNAL-REQUEST set up a sync', opts.signalSender, 'signal:+15550000001', 'signal'));
      await Promise.all([emailTurn, signalTurn]);
    } finally {
      // Never leave the email turn parked: a failed wait, or a Signal turn that throws before
      // its second model call, would otherwise strand it on `release` past the test.
      release.resolve();
      await Promise.allSettled([emailTurn]);
    }
    // The Signal turn's booking attempt came back while the email turn was still open.
    expect(overlap).toEqual([{ emailParked: true, emailDone: false }]);
  }

  it('same scheduling request on email and Signal yields one booking and one outbound email', async () => {
    const h = harness({
      'ada@example.com': person(CONTACT_A, 'principal', 'Ada Lovelace'),
      '+15550000001': person(CONTACT_A, 'principal', 'Ada Lovelace'),
    });
    await runOverlapping(h, { emailSender: 'ada@example.com', signalSender: '+15550000001', emailTarget: CONTACT_B, signalTarget: CONTACT_B });

    // soft: when the backstop is off, the RED run reports both counts and the missing hold.
    expect.soft(h.booking.execute).toHaveBeenCalledTimes(1);
    expect.soft(h.email.execute).toHaveBeenCalledTimes(1);
    expect(h.transcript('SIGNAL-REQUEST')).toContain(HOLD_TEXT);
    expect(h.transcript('EMAIL-REQUEST')).not.toContain(HOLD_TEXT);
    // The hold was the Signal turn's first tool result, and it did not count as an error
    // against the turn's consecutive-error budget.
    expect(h.transcript('SIGNAL-REQUEST')).toMatch(/<attempt>0 of \d+<\/attempt>/);
    // Nor is it reported as a failed skill: a re-issued call may well run, and the run's
    // failedSkills (scheduler last_run_context, diagnostics) must not say it failed.
    const signalResponse = h.responses.get('signal:+15550000001');
    expect(signalResponse).toBeDefined();
    expect(signalResponse!.failedSkills).toBeUndefined();
  });

  it('the same person on two channels acting on different people is never held', async () => {
    const h = harness({
      'ada@example.com': person(CONTACT_A, 'principal', 'Ada Lovelace'),
      '+15550000001': person(CONTACT_A, 'principal', 'Ada Lovelace'),
    });
    await runOverlapping(h, { emailSender: 'ada@example.com', signalSender: '+15550000001', emailTarget: CONTACT_B, signalTarget: CONTACT_C });

    expect(h.booking.execute).toHaveBeenCalledTimes(2);
    expect(h.email.execute).toHaveBeenCalledTimes(2);
    expect(h.transcript('EMAIL-REQUEST')).not.toContain(HOLD_TEXT);
    expect(h.transcript('SIGNAL-REQUEST')).not.toContain(HOLD_TEXT);
  });

  it('different people acting on the same target: the second is held', async () => {
    // Behavior as the code stands: the target match does not depend on who is asking, so a
    // resolved non-principal's turn is held by the principal's earlier action on that contact.
    const h = harness({
      'ada@example.com': person(CONTACT_A, 'principal', 'Ada Lovelace'),
      '+15550000001': person(CONTACT_G, null, 'Grace Hopper'),
    });
    await runOverlapping(h, { emailSender: 'ada@example.com', signalSender: '+15550000001', emailTarget: CONTACT_B, signalTarget: CONTACT_B });

    expect(h.booking.execute).toHaveBeenCalledTimes(1);
    expect(h.email.execute).toHaveBeenCalledTimes(1);
    expect(h.transcript('SIGNAL-REQUEST')).toContain(HOLD_TEXT);
  });
});
