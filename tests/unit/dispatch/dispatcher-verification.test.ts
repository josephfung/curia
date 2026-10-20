// tests/unit/dispatch/dispatcher-verification.test.ts
//
// Delegated sign-in verification (#2017), design section 5: a code the principal relays
// in a live turn is tracked while an sms/app verification is open, and the dispatcher
// scrubs tracked codes out of the reply it relays. The coordinator's own task content is
// left alone: the live turn needs the code to type it.

import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import {
  createInboundMessage,
  createAgentResponse,
  type AgentTaskEvent,
  type OutboundMessageEvent,
} from '../../../src/bus/events.js';
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { createLogger } from '../../../src/logger.js';
import { CodeTracker } from '../../../src/verification/code-tracker.js';
import type { VerificationRuntime } from '../../../src/verification/index.js';
import type { Verification, VerificationDelivery, VerificationStatus } from '../../../src/verification/types.js';

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

function verificationRow(id: string, delivery: VerificationDelivery, status: VerificationStatus = 'pending'): Verification {
  return {
    id,
    purpose: 'sign_in',
    kind: 'code',
    delivery,
    site: 'example.com',
    pageDomain: 'login.example.com',
    browserSessionId: 'bs-1',
    taskId: null,
    conversationId: null,
    status,
    requestedAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
    resolvedAt: null,
    metadata: {},
  };
}

function buildHarness(opts: {
  principal?: boolean;
  active?: Verification[];
  listActive?: () => Promise<Verification[]>;
}) {
  const logger = createLogger('error');
  const warnSpy = vi.spyOn(logger, 'warn');
  const bus = new EventBus(logger);
  const tracker = new CodeTracker({ ttlMinutesAfterClose: 120 });
  const registerSpy = vi.spyOn(tracker, 'register');
  const listActive = vi.fn(opts.listActive ?? (async () => opts.active ?? []));
  const verification = { tracker, listActive } as unknown as VerificationRuntime;
  const dispatcher = new Dispatcher({
    bus,
    logger,
    contactResolver: resolverFor(opts.principal ?? true),
    verification,
  });
  dispatcher.register();

  const tasks: AgentTaskEvent[] = [];
  const outbound: OutboundMessageEvent[] = [];
  // How many codes were already registered when each task reached the coordinator.
  const registeredAtTask: number[] = [];
  bus.subscribe('agent.task', 'agent', (e) => {
    tasks.push(e as AgentTaskEvent);
    registeredAtTask.push(registerSpy.mock.calls.length);
  });
  bus.subscribe('outbound.message', 'channel', (e) => {
    outbound.push(e as OutboundMessageEvent);
  });

  const send = (content: string, channelId = 'signal', senderId = '+15551234567') =>
    bus.publish('channel', createInboundMessage({
      conversationId: `${channelId}:${senderId}`,
      channelId,
      senderId,
      content,
    }));

  const respond = async (task: AgentTaskEvent, content: string) => {
    await bus.publish('agent', createAgentResponse({
      agentId: 'coordinator',
      conversationId: task.payload.conversationId,
      content,
      parentEventId: task.id,
    }));
  };

  return { tasks, registeredAtTask, outbound, send, respond, tracker, registerSpy, listActive, warnSpy };
}

describe('Dispatcher — principal-relayed sign-in codes (#2017)', () => {
  it("principal Signal \"it's 482 913\" with a pending sms verification registers 482913", async () => {
    const { send, tasks, tracker, registerSpy } = buildHarness({ active: [verificationRow('v-1', 'sms')] });
    await send("it's 482 913");

    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith('v-1', 'login.example.com', expect.any(String), 'bs-1');
    // The tracker holds the code in whichever written form: it is scrubbed from text.
    expect(tracker.scrubText('use 482913 now')).toBe('use [sign-in code] now');
    // The live turn still gets the code.
    expect(tasks[0]!.payload.content).toContain('482 913');
  });

  it('a bare 4-digit reply registers it for the pending sms verification and sets the guidance', async () => {
    const { send, tasks, tracker } = buildHarness({ active: [verificationRow('v-1', 'sms')] });
    await send('4821');

    expect(tracker.scrubText('typed 4821')).toBe('typed [sign-in code]');
    expect(tasks[0]!.payload.turnGuidance).toContain('verification-code-received');
  });

  it('a short code in an email reply is found under its Subject line', async () => {
    const { send, tracker } = buildHarness({ active: [verificationRow('v-1', 'app')] });
    await send('Subject: Re: sign-in\n\n48213', 'email', 'joseph@example.com');

    expect(tracker.scrubText('48213')).toBe('[sign-in code]');
  });

  it('a 4-digit time or year in a longer message is not registered', async () => {
    const { send, tracker } = buildHarness({ active: [verificationRow('v-1', 'sms')] });
    await send('see you at 1430 tomorrow');
    await send('back in 2026');

    expect(tracker.size()).toBe(0);
  });

  it('a short reply naming a time or amount neither registers nor raises the code guidance', async () => {
    const { send, tasks, tracker } = buildHarness({ active: [verificationRow('v-1', 'sms')] });
    for (const text of ['ok 1430?', 'is 1430 ok', "It's 1200", 'thanks 5000']) await send(text);

    expect(tracker.size()).toBe(0);
    for (const task of tasks) expect(task.payload.turnGuidance ?? []).not.toContain('verification-code-received');
  });

  it('registers against every pending, expired or abandoned sms/app verification, never a satisfied one', async () => {
    const { send, registerSpy } = buildHarness({
      active: [
        verificationRow('v-sms', 'sms'),
        verificationRow('v-app', 'app', 'expired'),
        verificationRow('v-gone', 'sms', 'abandoned'),
        verificationRow('v-done', 'app', 'satisfied'),
        verificationRow('v-mail', 'email'),
      ],
    });
    await send('code 482913');

    const ids = registerSpy.mock.calls.map((c) => c[0]).sort();
    expect(ids).toEqual(['v-app', 'v-gone', 'v-sms']);
  });

  it('starts the TTL clock for a non-pending row right after registering against it', async () => {
    const { send, tracker } = buildHarness({
      active: [verificationRow('v-sms', 'sms'), verificationRow('v-app', 'app', 'expired')],
    });
    const closedSpy = vi.spyOn(tracker, 'closed');
    await send('code 482913');
    expect(closedSpy.mock.calls.map((c) => c[0])).toEqual(['v-app']);
  });

  it('does not register when the only sms verification is already satisfied', async () => {
    const { send, registerSpy } = buildHarness({ active: [verificationRow('v-done', 'sms', 'satisfied')] });
    await send('code 482913');
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('ignores quoted history and phone/date shapes', async () => {
    const { send, registerSpy, tracker } = buildHarness({ active: [verificationRow('v-1', 'app')] });
    await send([
      '482913',
      '',
      '-- ',
      'Avery',
      '519-555-0199',
      '',
      'On Tue, Oct 7, 2026 at 3:00 PM Curia <curia@example.test> wrote:',
      '> code 111222',
    ].join('\n'), 'email', 'avery@example.test');

    const registered = registerSpy.mock.calls.map((c) => tracker.scrubText(c[2]));
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registered).toEqual(['[sign-in code]']);
    expect(tracker.scrubText('482913 / 111222 / 5195550199')).toBe('[sign-in code] / 111222 / 5195550199');
  });

  it('ignores >-quoted lines even with no reply header', async () => {
    const { send, tracker } = buildHarness({ active: [verificationRow('v-1', 'sms')] });
    await send('thanks\n> your code is 111222', 'email', 'avery@example.test');
    expect(tracker.scrubText('111222')).toBe('111222');
  });

  it('does not register when only an email-delivery verification is pending', async () => {
    const { send, registerSpy } = buildHarness({ active: [verificationRow('v-1', 'email')] });
    await send('it is 482913');
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('does not register when nothing is active', async () => {
    const { send, registerSpy } = buildHarness({ active: [] });
    await send('it is 482913');
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it('does not register or look anything up for a non-principal sender', async () => {
    const { send, registerSpy, listActive, tasks } = buildHarness({
      principal: false,
      active: [verificationRow('v-1', 'sms')],
    });
    await send('it is 482913');
    expect(listActive).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
  });

  it('registers before the coordinator task is published', async () => {
    const { send, registeredAtTask } = buildHarness({ active: [verificationRow('v-1', 'sms')] });
    await send('482913');
    expect(registeredAtTask).toEqual([1]);
  });

  it('routes the turn and logs a warning without content when listActive fails', async () => {
    const { send, tasks, registerSpy, warnSpy } = buildHarness({
      listActive: async () => {
        throw new Error('connection reset');
      },
    });
    await send('it is 482913');

    expect(tasks).toHaveLength(1);
    expect(registerSpy).not.toHaveBeenCalled();
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain('verification');
    expect(logged).not.toContain('482913');
  });
});

describe('Dispatcher — verification-code-received turn guidance (#2017)', () => {
  it('sets the key when the principal\'s message registered a code for an sms/app verification', async () => {
    const { send, tasks } = buildHarness({ active: [verificationRow('v-1', 'sms')] });
    await send('482913 — once you are in, send me the notice');
    expect(tasks[0]!.payload.turnGuidance).toContain('verification-code-received');
  });

  it('does not set it when only expired or abandoned rows took the value (still tracked for scrubbing)', async () => {
    for (const status of ['expired', 'abandoned'] as const) {
      const { send, tasks, registerSpy } = buildHarness({ active: [verificationRow('v-1', 'sms', status)] });
      // A postal code or booking reference in a later message, shaped like a code.
      await send('Ship it to M5H 1A1, booking 482913');
      expect(registerSpy).toHaveBeenCalled();
      expect(tasks[0]!.payload.turnGuidance ?? []).not.toContain('verification-code-received');
    }
  });

  it('sets it when a pending row took the value, even beside an expired one', async () => {
    const { send, tasks } = buildHarness({
      active: [verificationRow('v-old', 'sms', 'expired'), verificationRow('v-1', 'app')],
    });
    await send('482913');
    expect(tasks[0]!.payload.turnGuidance).toContain('verification-code-received');
  });

  it('does not set it without a code-shaped value, for an email-only verification, or with nothing active', async () => {
    for (const [active, text] of [
      [[verificationRow('v-1', 'sms')], 'thanks, go ahead'],
      [[verificationRow('v-1', 'email')], '482913'],
      [[verificationRow('v-1', 'sms', 'satisfied')], '482913'],
      [[], '482913'],
    ] as const) {
      const { send, tasks } = buildHarness({ active: [...active] });
      await send(text);
      expect(tasks[0]!.payload.turnGuidance ?? []).not.toContain('verification-code-received');
    }
  });

  it('does not set it for a non-principal sender', async () => {
    const { send, tasks } = buildHarness({ principal: false, active: [verificationRow('v-1', 'sms')] });
    await send('482913');
    expect(tasks[0]!.payload.turnGuidance ?? []).not.toContain('verification-code-received');
  });
});

describe('Dispatcher — reply scrub (#2017)', () => {
  it('sends "Done — I used 482913" out as "Done — I used [sign-in code]"', async () => {
    const { send, tasks, respond, outbound } = buildHarness({ active: [verificationRow('v-1', 'sms')] });
    await send("it's 482913");
    await respond(tasks[0]!, 'Done — I used 482913');

    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.payload.content).toBe('Done — I used [sign-in code]');
  });

  it('scrubs the spaced written form too', async () => {
    const { send, tasks, respond, outbound } = buildHarness({ active: [verificationRow('v-1', 'sms')] });
    await send("it's 482913");
    await respond(tasks[0]!, 'Entered 482 913.');

    expect(outbound[0]!.payload.content).toBe('Entered [sign-in code].');
  });

  it('leaves a reply with no tracked value untouched', async () => {
    const { send, tasks, respond, outbound } = buildHarness({ active: [] });
    await send('hello');
    await respond(tasks[0]!, 'Hi, order 482913 shipped.');

    expect(outbound[0]!.payload.content).toBe('Hi, order 482913 shipped.');
  });
});
