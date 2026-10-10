// A note for the principal cut out of a reply to someone else is emailed to the principal
// as a `principal_note` notification, whatever happens to the relay (prompt trim PR 5).
import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { Logger } from '../../../src/logger.js';
import type { ChannelIdentity, PrincipalEmailRef } from '../../../src/contacts/types.js';
import {
  createAgentResponse,
  createToolResult,
  type BusEvent,
  type OutboundMessageEvent,
  type OutboundNoReplyEvent,
  type OutboundNotificationEvent,
} from '../../../src/bus/events.js';

const PRINCIPAL_EMAIL = 'avery@example.test';
const SENDER = 'dana@vendor.example.test';
const CONVERSATION = 'email:thread-1';
const NOTE = 'Dana confirmed Thursday at 10 and asked whether the CFO will join.';

function identity(channel: string, channelIdentifier: string, verified = true): ChannelIdentity {
  return {
    id: `id-${channelIdentifier}`, contactId: 'principal-1', channel, channelIdentifier, label: null,
    verified, verifiedAt: null, status: 'active', source: 'ceo_stated', createdAt: new Date(), updatedAt: new Date(),
  };
}

function harness(opts: { principalEmail?: string | PrincipalEmailRef; principalIdentities?: ChannelIdentity[] } = {}) {
  const published: BusEvent[] = [];
  const handlers = new Map<string, (event: BusEvent) => void | Promise<void>>();
  const bus = {
    subscribe: vi.fn((type: string, _layer: string, handler: (e: BusEvent) => void | Promise<void>) => {
      handlers.set(type, handler);
    }),
    publish: vi.fn(async (_layer: string, event: BusEvent) => { published.push(event); }),
  } as unknown as EventBus;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const dispatcher = new Dispatcher({
    bus,
    logger,
    principalEmail: 'principalEmail' in opts ? opts.principalEmail : { current: PRINCIPAL_EMAIL },
    principalIdentities: opts.principalIdentities ?? [identity('email', PRINCIPAL_EMAIL), identity('signal', '+15550001111')],
  });
  dispatcher.register();
  return { dispatcher, handlers, published, logger };
}

function seedRouting(dispatcher: Dispatcher, taskId: string, extra: Record<string, unknown> = {}): void {
  (dispatcher as unknown as { taskRouting: Map<string, Record<string, unknown>> }).taskRouting.set(taskId, {
    channelId: 'email',
    conversationId: CONVERSATION,
    senderId: SENDER,
    humanReplySent: false,
    replySkillGateCBlocked: false,
    liveTurn: false,
    senderLabel: 'Dana Whitfield',
    ...extra,
  });
}

async function respond(
  handlers: Map<string, (event: BusEvent) => void | Promise<void>>,
  opts: { taskId: string; content?: string; principalNote?: string; suppressDelivery?: boolean },
): Promise<string> {
  const event = createAgentResponse({
    agentId: 'coordinator',
    conversationId: CONVERSATION,
    content: opts.content ?? 'Thursday at 10 works.',
    ...(opts.principalNote !== undefined && { principalNote: opts.principalNote }),
    ...(opts.suppressDelivery && { suppressDelivery: true }),
    parentEventId: opts.taskId,
  });
  await handlers.get('agent.response')!(event);
  return event.id;
}

async function sent(
  handlers: Map<string, (event: BusEvent) => void | Promise<void>>,
  opts: { taskId: string; toolName: string; data: Record<string, unknown> },
): Promise<void> {
  await handlers.get('tool.result')!(createToolResult({
    agentId: 'coordinator',
    conversationId: CONVERSATION,
    toolName: opts.toolName,
    result: { success: true, data: opts.data },
    durationMs: 10,
    routingTaskId: opts.taskId,
    parentEventId: 'invoke-1',
  }));
}

const notifications = (events: BusEvent[]) =>
  events.filter((e): e is OutboundNotificationEvent => e.type === 'outbound.notification');
const relays = (events: BusEvent[]) =>
  events.filter((e): e is OutboundMessageEvent => e.type === 'outbound.message');

describe('Dispatcher — note for the principal (prompt trim PR 5)', () => {
  it('emails the note to the principal and relays the reply unchanged', async () => {
    const { dispatcher, handlers, published } = harness();
    seedRouting(dispatcher, 'task-1');
    const responseId = await respond(handlers, { taskId: 'task-1', principalNote: NOTE });

    const [notification] = notifications(published);
    expect(notification).toBeDefined();
    expect(notification!.payload).toMatchObject({
      notificationType: 'principal_note',
      ceoEmail: PRINCIPAL_EMAIL,
      subject: "Note about Dana Whitfield's email",
      originalChannel: 'email',
      originalRecipientId: SENDER,
    });
    expect(notification!.payload.body).toContain(NOTE);
    expect(notification!.payload.body).toContain(`an email from Dana Whitfield (${SENDER})`);
    expect(notification!.parentEventId).toBe(responseId);

    const [relay] = relays(published);
    expect(relay!.payload.content).toBe('Thursday at 10 works.');
    expect(relay!.payload.content).not.toContain(NOTE);
    // The note goes out before the relay, so the audit log reads in order.
    expect(published.indexOf(notification!)).toBeLessThan(published.indexOf(relay!));
  });

  it('still emails the note when the reply is a decline', async () => {
    const { dispatcher, handlers, published } = harness();
    seedRouting(dispatcher, 'task-1');
    await respond(handlers, { taskId: 'task-1', content: '', suppressDelivery: true, principalNote: NOTE });

    expect(notifications(published)).toHaveLength(1);
    expect(relays(published)).toHaveLength(0);
    expect(published.some((e): e is OutboundNoReplyEvent => e.type === 'outbound.no_reply')).toBe(true);
  });

  it('still emails the note when the reply-lock suppresses the relay', async () => {
    const { dispatcher, handlers, published } = harness();
    seedRouting(dispatcher, 'task-1', { humanReplySent: true });
    await respond(handlers, { taskId: 'task-1', principalNote: NOTE });

    expect(notifications(published)).toHaveLength(1);
    expect(relays(published)).toHaveLength(0);
  });

  it('does not email the note when a send already reached the principal on this turn', async () => {
    const { dispatcher, handlers, published, logger } = harness();
    seedRouting(dispatcher, 'task-1');
    await sent(handlers, { taskId: 'task-1', toolName: 'signal-send', data: { delivered_to: '+15550001111' } });
    await respond(handlers, { taskId: 'task-1', principalNote: NOTE });

    expect(notifications(published)).toHaveLength(0);
    expect(relays(published)).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ noteLength: NOTE.length }),
      expect.stringContaining('a send already reached the principal'),
    );
  });

  it('emails the note when the turn sent only to someone else, or to an unverified principal identity', async () => {
    const { dispatcher, handlers, published } = harness({
      principalIdentities: [identity('email', PRINCIPAL_EMAIL), identity('email', 'old@example.test', false)],
    });
    seedRouting(dispatcher, 'task-1');
    await sent(handlers, { taskId: 'task-1', toolName: 'email-send', data: { to: 'cfo@example.test, old@example.test' } });
    await respond(handlers, { taskId: 'task-1', principalNote: NOTE });

    expect(notifications(published)).toHaveLength(1);
  });

  it('marks only the turn whose send reached the principal', async () => {
    const { dispatcher, handlers, published } = harness();
    seedRouting(dispatcher, 'task-1');
    seedRouting(dispatcher, 'task-2');
    await sent(handlers, { taskId: 'task-1', toolName: 'email-send', data: { to: PRINCIPAL_EMAIL } });
    await respond(handlers, { taskId: 'task-2', principalNote: NOTE });

    expect(notifications(published)).toHaveLength(1);
  });

  it('logs and sends nothing when no principal email is bound', async () => {
    const { dispatcher, handlers, published, logger } = harness({ principalEmail: { current: '' } });
    seedRouting(dispatcher, 'task-1');
    await respond(handlers, { taskId: 'task-1', principalNote: NOTE });

    expect(notifications(published)).toHaveLength(0);
    expect(relays(published)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ noteLength: NOTE.length }),
      expect.stringContaining('no verified principal email'),
    );
    // Lengths only: the note can carry a sender's details.
    for (const call of vi.mocked(logger.warn).mock.calls) expect(JSON.stringify(call)).not.toContain('CFO');
  });

  it('names the sender by their identifier when they did not resolve', async () => {
    const { dispatcher, handlers, published } = harness();
    seedRouting(dispatcher, 'task-1', { senderLabel: undefined });
    await respond(handlers, { taskId: 'task-1', principalNote: NOTE });

    const [notification] = notifications(published);
    expect(notification!.payload.subject).toBe(`Note about ${SENDER}'s email`);
    expect(notification!.payload.body).toContain(`an email from ${SENDER}.`);
  });

  it('logs a failed note publish and still relays the reply', async () => {
    const { dispatcher, handlers, published, logger } = harness();
    const bus = (dispatcher as unknown as { bus: EventBus }).bus;
    const publish = vi.mocked(bus.publish);
    publish.mockImplementation(async (_layer, event) => {
      if (event.type === 'outbound.notification') throw new Error('bus down');
      published.push(event);
    });
    seedRouting(dispatcher, 'task-1');
    await respond(handlers, { taskId: 'task-1', principalNote: NOTE });

    expect(notifications(published)).toHaveLength(0);
    expect(relays(published)).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ noteLength: NOTE.length }),
      expect.stringContaining('Failed to publish the principal note notification'),
    );
  });

  it('sends nothing extra for a response without a note', async () => {
    const { dispatcher, handlers, published } = harness();
    seedRouting(dispatcher, 'task-1');
    await respond(handlers, { taskId: 'task-1' });
    expect(notifications(published)).toHaveLength(0);
  });

  it('warns about a note on a response with no routing entry, and sends nothing', async () => {
    const { handlers, published, logger } = harness();
    await respond(handlers, { taskId: 'no-such-task', principalNote: NOTE });
    expect(notifications(published)).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ noteLength: NOTE.length }),
      expect.stringContaining('no routing entry'),
    );
  });
});
