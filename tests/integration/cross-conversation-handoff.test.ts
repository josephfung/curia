// Cross-conversation awareness and hand-off (#2588, PR 2). The same person writes on email
// and then on Signal while the email turn is still working. The Signal turn sees a note of
// the email turn ("## Your other recent turns with this person") and, when the email thread
// is one-to-one, can pass a correction into it with the real `turn-handoff` tool.
//
// Same harness as cross-conversation-backstop.test.ts: no database, an in-memory bus and
// working memory, a real Dispatcher, TurnLanes, AgentRuntime and ExecutionLayer, and a
// scripted model. The calendar tools are fakes; `turn-handoff` is the real skill.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { TurnLanes } from '../../src/dispatch/turn-lanes.js';
import { TurnActivityRegistry, type RootTurn } from '../../src/dispatch/turn-activity.js';
import { EventBus } from '../../src/bus/bus.js';
import { createInboundMessage } from '../../src/bus/events.js';
import type { LLMProvider, LLMResponse, Message, ToolDefinition, ToolResultContent } from '../../src/agents/llm/provider.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import { ToolRegistry } from '../../src/skills/registry.js';
import type { ToolHandler, ToolManifest } from '../../src/skills/types.js';
import type { ContactResolver } from '../../src/contacts/contact-resolver.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import type { ChannelIdentity } from '../../src/contacts/types.js';
import type { InboundScanner } from '../../src/dispatch/inbound-scanner.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { createLogger } from '../../src/logger.js';
import { TurnHandoffHandler } from '../../skills/turn-handoff/handler.js';

const CONTACT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // the principal
const CONTACT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // the third party they meet
const CONTACT_G = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // a second, unrelated sender
const USAGE = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock' } as const;

const CURIA_EMAIL = 'curia@example.com';
const ADA_EMAIL = 'ada@example.com';
const ADA_SIGNAL = '+15550000001';
const GRACE_SIGNAL = '+15550000002';

const HEADING = '## Your other recent turns with this person';
const HANDED_OVER = 'Handed over from';
const HANDOFF_LINE = 'use `turn-handoff` with that turn_id';
// Outcome copy (src/agents/turn-handoff.ts). Matched past any apostrophe, which a tool-result
// wrapper may XML-escape.
const PASSED_ON = 'Passed on to the turn already doing that work';
const NOT_ONE_TO_ONE = 'hand this over (that conversation includes other people)';
const NOT_VERIFIED = "hand this over (that turn's sender wasn't verified by its channel)";

const THURSDAY = '2026-11-19T15:00:00-05:00';
const FRIDAY = '2026-11-20T15:00:00-05:00';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

function manifest(name: string, actionRisk: 'none' | 'high'): ToolManifest {
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

/** The shipped manifest of the real tool, as the loader reads it. */
function turnHandoffManifest(): ToolManifest {
  const file = path.resolve(import.meta.dirname, '../../skills/turn-handoff/tool.json');
  // The shipped tool.json; its shape is checked by the skill's own tests and the loader.
  return JSON.parse(readFileSync(file, 'utf8')) as unknown as ToolManifest;
}

const PRINCIPAL_IDENTITIES: ChannelIdentity[] = [
  {
    id: 'id-signal',
    contactId: CONTACT_A,
    channel: 'signal',
    channelIdentifier: ADA_SIGNAL,
    label: null,
    verified: true,
    verifiedAt: new Date(),
    status: 'active',
    source: 'ceo_stated',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'id-email',
    contactId: CONTACT_A,
    channel: 'email',
    channelIdentifier: ADA_EMAIL,
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
  [CONTACT_G]: 'Grace Hopper',
};

const CONTACT_EMAILS: Record<string, string> = {
  [CONTACT_B]: 'barbara@example.com',
};

/**
 * A two-party email to Curia, as the email adapter describes it: one-to-one, from a sender
 * the adapter verified (only an authenticated turn is listed or takes a hand-off).
 */
const ONE_TO_ONE_EMAIL = {
  senderVerified: true,
  senderSpfAligned: true,
  curiaRole: 'to',
  primaryRecipientEmails: [],
  participants: [
    { email: ADA_EMAIL, role: 'from' },
    { email: CURIA_EMAIL, role: 'to' },
  ],
};

/** The same email from a sender the adapter could not verify: a From anyone could forge. */
const UNVERIFIED_EMAIL = { ...ONE_TO_ONE_EMAIL, senderVerified: false };

/** The same email with a third party cc'd: not one-to-one. */
const CC_EMAIL = {
  senderVerified: true,
  senderSpfAligned: true,
  curiaRole: 'to',
  primaryRecipientEmails: [],
  participants: [
    { email: ADA_EMAIL, role: 'from' },
    { email: CURIA_EMAIL, role: 'to' },
    { email: 'carol@example.com', role: 'cc' },
  ],
};

type ScriptStep = (messages: Message[]) => LLMResponse | Promise<LLMResponse>;

function harness() {
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  const lanes = new TurnLanes({
    enabled: true,
    maxInjectionsPerTurn: 5,
    extraRoundsPerInjection: 2,
    laneWaitTimeoutMs: 60_000,
    logger: pino({ level: 'silent' }),
  });
  const contacts: Record<string, ReturnType<typeof person>> = {
    [ADA_EMAIL]: person(CONTACT_A, 'principal', 'Ada Lovelace'),
    [ADA_SIGNAL]: person(CONTACT_A, 'principal', 'Ada Lovelace'),
    [GRACE_SIGNAL]: person(CONTACT_G, null, 'Grace Hopper'),
  };
  const resolver = {
    resolve: async (channel: string, senderId: string) =>
      contacts[senderId] ?? { resolved: false, channel, senderId },
  } as unknown as ContactResolver;
  // A completed scan with no findings: the dispatcher stamps the sender's text and a
  // finding count of 0 only then, and both the note and the hand-off need them.
  const scanner = {
    scan: (raw: string) => ({ sanitizedContent: raw, riskScore: 0, findings: [] }),
  } as unknown as InboundScanner;

  const turnActivity = new TurnActivityRegistry({ logger, selfEmails: [CURIA_EMAIL] });
  const toolRegistry = new ToolRegistry();
  const booking: ToolHandler & { execute: ReturnType<typeof vi.fn> } = {
    execute: vi.fn().mockResolvedValue({ success: true, data: { booked: true } }),
  };
  const availability: ToolHandler & { execute: ReturnType<typeof vi.fn> } = {
    execute: vi.fn().mockResolvedValue({ success: true, data: { free: true } }),
  };
  toolRegistry.register(manifest('calendar-create-event', 'high'), booking);
  toolRegistry.register(manifest('calendar-check-availability', 'none'), availability);
  toolRegistry.register(turnHandoffManifest(), new TurnHandoffHandler());
  const contactService = {
    getContact: vi.fn(async (id: string) => (CONTACT_NAMES[id] ? { id, displayName: CONTACT_NAMES[id] } : undefined)),
    getContactWithIdentities: vi.fn(async (id: string) => (id === CONTACT_A
      ? { contact: { id, displayName: CONTACT_NAMES[id], primaryEmail: ADA_EMAIL, primaryPhone: null }, identities: PRINCIPAL_IDENTITIES }
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
    selfEmails: [CURIA_EMAIL],
  });

  // Each turn's script is found by its marker. The turn's own request is the marker that
  // appears last, outside system messages (the Signal turn's note quotes the email request)
  // and outside handed-over messages (the email turn is handed the Signal request).
  const chatsByTurn = new Map<string, { messages: Message[]; tools: string[] }[]>();
  const scripts = new Map<string, ScriptStep[]>();
  const provider: LLMProvider = {
    id: 'mock',
    chat: vi.fn(async (params: { messages: Message[]; tools?: ToolDefinition[] }) => {
      const own = params.messages
        .filter((m) => m.role !== 'system')
        .map((m) => JSON.stringify(m))
        .filter((m) => !m.includes(HANDED_OVER))
        .join('\n');
      const marker = [...scripts.keys()]
        .filter((key) => own.includes(key))
        .sort((a, b) => own.lastIndexOf(b) - own.lastIndexOf(a))[0];
      if (!marker) throw new Error('scripted provider: no script matches this turn');
      const seen = chatsByTurn.get(marker) ?? [];
      seen.push({ messages: params.messages, tools: (params.tools ?? []).map((t) => t.name) });
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
    selfEmails: [CURIA_EMAIL],
    principalIdentities: PRINCIPAL_IDENTITIES,
  }).register();

  function email(content: string, metadata: Record<string, unknown>) {
    return bus.publish('channel', createInboundMessage({
      conversationId: 'email:thread-1',
      channelId: 'email',
      senderId: ADA_EMAIL,
      content,
      metadata,
    }));
  }

  function signal(content: string, sender = ADA_SIGNAL) {
    return bus.publish('channel', createInboundMessage({
      conversationId: `signal:${sender}`,
      channelId: 'signal',
      senderId: sender,
      content,
      metadata: { isGroup: false },
    }));
  }

  function script(marker: string, steps: ScriptStep[]) {
    scripts.set(marker, steps);
  }

  /** Everything the model was shown in the turn, as one string. */
  function transcript(marker: string): string {
    return JSON.stringify((chatsByTurn.get(marker) ?? []).map((c) => c.messages));
  }

  /**
   * Prompt text of the turn's first model call (#2774): system messages plus user
   * messages (other-turns / hand-off guidance ride on the latest user message).
   */
  function systemPrompt(marker: string): string {
    const first = chatsByTurn.get(marker)?.[0];
    if (!first) return '';
    return first.messages
      .filter((m) => m.role === 'system' || m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
  }

  /** The tool names offered on the turn's first model call. */
  function toolsOffered(marker: string): string[] {
    return chatsByTurn.get(marker)?.[0]?.tools ?? [];
  }

  /** The content of every tool_result block the turn's last model call was shown. */
  function toolResults(marker: string): string[] {
    const calls = chatsByTurn.get(marker) ?? [];
    const last = calls[calls.length - 1];
    if (!last) return [];
    return last.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((block): block is ToolResultContent => block.type === 'tool_result')
      .map((block) => block.content);
  }

  return { lanes, turnActivity, booking, email, signal, script, transcript, systemPrompt, toolsOffered, toolResults };
}

/** The email turn's turn_id, read from the note the way the model reads it. */
function emailTurnId(messages: Message[]): string {
  const prompt = messages
    .filter((m) => m.role === 'system' || m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');
  const match = /- turn_id (\S+), on email,/.exec(prompt);
  if (!match) throw new Error('scripted provider: no email turn in the other-turns note');
  return match[1]!;
}

const book = (start: string) => () =>
  toolUse('calendar-create-event', {
    attendees: [{ email: CONTACT_EMAILS[CONTACT_B]!, name: CONTACT_NAMES[CONTACT_B]! }],
    title: 'Sync with Barbara',
    start,
  });

describe('cross-conversation hand-off (#2588)', () => {
  const EMAIL_TEXT = 'EMAIL-REQUEST please book a sync with Barbara on Thursday at 3pm';

  // The one-booking count follows from the scripted text-only Signal reply; what this proves
  // is the note's content.
  it("a Signal turn started while the email turn works gets a note of the email turn's request, actions and hand-off", async () => {
    const h = harness();
    const release = deferred();
    const state = { emailParked: false };
    h.script('EMAIL-REQUEST', [
      book(THURSDAY),
      async () => {
        state.emailParked = true;
        await release.promise;
        return text('Booked Thursday at 3pm.');
      },
    ]);
    h.script('SIGNAL-REQUEST', [
      () => {
        release.resolve();
        return text("Noted: that's already in hand on your email, I won't book it twice.");
      },
    ]);

    const emailTurn = h.email(EMAIL_TEXT, ONE_TO_ONE_EMAIL);
    try {
      await vi.waitFor(() => expect(state.emailParked).toBe(true));
      await h.signal('SIGNAL-REQUEST heads up, I just emailed you about the sync with Barbara');
      await emailTurn;
    } finally {
      release.resolve();
      await Promise.allSettled([emailTurn]);
    }

    const note = h.systemPrompt('SIGNAL-REQUEST');
    expect(note).toContain(HEADING);
    // The person's words, JSON-quoted.
    expect(note).toContain(JSON.stringify(EMAIL_TEXT));
    expect(note).toMatch(/- turn_id \S+, on email, running since/);
    expect(note).toContain('"calendar-create-event" on a contact');
    expect(note).toContain('hand-off: available');
    expect(h.booking.execute).toHaveBeenCalledTimes(1);
    // The email turn's own note is empty: the Signal turn had not started when it began.
    expect(h.systemPrompt('EMAIL-REQUEST')).not.toContain(HEADING);
  });

  it('a correction is handed into the running email turn and only one booking results', async () => {
    const h = harness();
    const release = deferred();
    const state = { emailParked: false };
    // The email turn is released once the hand-off has queued the message into its lane:
    // the Signal turn's turn-handoff call waits for the email turn to drain it.
    const inject = h.lanes.tryInjectIntoTask.bind(h.lanes);
    const injectSpy = vi.spyOn(h.lanes, 'tryInjectIntoTask').mockImplementation((taskEventId, input) => {
      const result = inject(taskEventId, input);
      release.resolve();
      return result;
    });
    h.script('EMAIL-REQUEST', [
      async () => {
        state.emailParked = true;
        await release.promise;
        return toolUse('calendar-check-availability', { date: '2026-11-19' });
      },
      // Books the day the latest word from the person says.
      (messages) => (JSON.stringify(messages).includes(HANDED_OVER) ? book(FRIDAY)() : book(THURSDAY)()),
      () => text('Booked.'),
    ]);
    h.script('SIGNAL-REQUEST', [
      (messages) => toolUse('turn-handoff', { turn_id: emailTurnId(messages) }),
      () => {
        // Releases the email turn if no hand-off did (a failing run must not hang).
        release.resolve();
        return text("Passed it on: it'll be Friday.");
      },
    ]);

    const emailTurn = h.email(EMAIL_TEXT, ONE_TO_ONE_EMAIL);
    try {
      await vi.waitFor(() => expect(state.emailParked).toBe(true));
      await h.signal('SIGNAL-REQUEST actually, make the sync with Barbara Friday instead');
      await emailTurn;
    } finally {
      release.resolve();
      await Promise.allSettled([emailTurn]);
    }

    // The tool was offered because the note shows the hand-off line.
    expect(h.toolsOffered('SIGNAL-REQUEST')).toContain('turn-handoff');
    expect(h.systemPrompt('SIGNAL-REQUEST')).toContain(HANDOFF_LINE);
    expect.soft(injectSpy).toHaveBeenCalledTimes(1);
    // The email turn's next round saw the Signal message, framed as handed over.
    const emailSeen = h.transcript('EMAIL-REQUEST');
    expect.soft(emailSeen).toContain(HANDED_OVER);
    expect.soft(emailSeen).toContain('make the sync with Barbara Friday instead');
    // One booking, on the corrected day.
    expect.soft(h.booking.execute).toHaveBeenCalledTimes(1);
    const bookedInput = (h.booking.execute.mock.calls[0]?.[0] as { input?: Record<string, unknown> } | undefined)?.input;
    expect.soft(bookedInput?.['start']).toBe(FRIDAY);
    // The Signal turn was told it was passed on, not to do the work itself.
    expect(h.toolResults('SIGNAL-REQUEST').some((r) => r.includes(PASSED_ON))).toBe(true);
  });

  it('a multi-participant email thread refuses the hand-off', async () => {
    const h = harness();
    const release = deferred();
    const state = { emailParked: false };
    h.script('EMAIL-REQUEST', [
      async () => {
        state.emailParked = true;
        await release.promise;
        return text('Booked.');
      },
    ]);
    h.script('SIGNAL-REQUEST', [
      // Not offered, but the model names it anyway (as discovery could surface it).
      (messages) => toolUse('turn-handoff', { turn_id: emailTurnId(messages) }),
      () => {
        release.resolve();
        return text("I'll handle the change here.");
      },
    ]);

    const emailTurn = h.email(EMAIL_TEXT, CC_EMAIL);
    try {
      await vi.waitFor(() => expect(state.emailParked).toBe(true));
      await h.signal('SIGNAL-REQUEST actually, make the sync with Barbara Friday instead');
      await emailTurn;
    } finally {
      release.resolve();
      await Promise.allSettled([emailTurn]);
    }

    const note = h.systemPrompt('SIGNAL-REQUEST');
    expect(note).toContain(HEADING);
    expect(note).toContain('hand-off: not available');
    expect(note).not.toContain(HANDOFF_LINE);
    expect(h.toolsOffered('SIGNAL-REQUEST')).not.toContain('turn-handoff');
    // Called anyway: the runtime refuses it, and nothing reaches the email turn.
    expect(h.toolResults('SIGNAL-REQUEST').some((r) => r.includes(NOT_ONE_TO_ONE))).toBe(true);
    expect(h.transcript('EMAIL-REQUEST')).not.toContain(HANDED_OVER);
  });

  it("an unverified email turn (a forgeable From) is not in the Signal turn's note and refuses a hand-off", async () => {
    const h = harness();
    const release = deferred();
    const state = { emailParked: false };
    h.script('EMAIL-REQUEST', [
      async () => {
        state.emailParked = true;
        await release.promise;
        return text('Booked.');
      },
    ]);
    let namedTurnId = '';
    h.script('SIGNAL-REQUEST', [
      // The note does not list it, so the id comes from elsewhere (a guess, or discovery).
      () => toolUse('turn-handoff', { turn_id: namedTurnId }),
      () => {
        release.resolve();
        return text("I'll handle the change here.");
      },
    ]);
    const started = vi.spyOn(h.turnActivity, 'taskStarted');

    const emailTurn = h.email(EMAIL_TEXT, UNVERIFIED_EMAIL);
    try {
      await vi.waitFor(() => expect(state.emailParked).toBe(true));
      const emailRoot = started.mock.results.map((r) => r.value as RootTurn).find((r) => r.channelId === 'email');
      // Resolved to the principal, but the adapter did not verify the sender.
      expect(emailRoot?.originatorContactId).toBe(CONTACT_A);
      expect(emailRoot?.originatorAuthenticated).toBe(false);
      namedTurnId = emailRoot!.rootId;
      await h.signal('SIGNAL-REQUEST actually, make the sync with Barbara Friday instead');
      await emailTurn;
    } finally {
      release.resolve();
      await Promise.allSettled([emailTurn]);
    }

    const note = h.systemPrompt('SIGNAL-REQUEST');
    expect(note).not.toContain(HEADING);
    expect(note).not.toContain('asked (their own words');
    expect(note).not.toContain(namedTurnId);
    expect(h.toolsOffered('SIGNAL-REQUEST')).not.toContain('turn-handoff');
    expect(h.toolResults('SIGNAL-REQUEST').some((r) => r.includes(NOT_VERIFIED))).toBe(true);
    expect(h.transcript('EMAIL-REQUEST')).not.toContain(HANDED_OVER);
  });

  it('unrelated concurrent requests from different people get no note', async () => {
    const h = harness();
    const release = deferred();
    const state = { emailParked: false };
    h.script('EMAIL-REQUEST', [
      async () => {
        state.emailParked = true;
        await release.promise;
        return text('Booked.');
      },
    ]);
    h.script('SIGNAL-REQUEST', [
      () => {
        release.resolve();
        return text('Sure, here is the agenda.');
      },
    ]);

    const emailTurn = h.email(EMAIL_TEXT, ONE_TO_ONE_EMAIL);
    try {
      await vi.waitFor(() => expect(state.emailParked).toBe(true));
      await h.signal('SIGNAL-REQUEST can you send me the agenda for tomorrow?', GRACE_SIGNAL);
      await emailTurn;
    } finally {
      release.resolve();
      await Promise.allSettled([emailTurn]);
    }

    // Both turns ran their model calls (the scripts are routed by marker).
    expect(h.systemPrompt('EMAIL-REQUEST')).not.toBe('');
    expect(h.systemPrompt('SIGNAL-REQUEST')).not.toBe('');
    expect(h.systemPrompt('EMAIL-REQUEST')).not.toContain(HEADING);
    expect(h.systemPrompt('SIGNAL-REQUEST')).not.toContain(HEADING);
    expect(h.toolsOffered('SIGNAL-REQUEST')).not.toContain('turn-handoff');
  });
});
