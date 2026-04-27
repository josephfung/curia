// Tests for EmailAdapter — focused on the outbound reply routing fix (issue #244).
//
// The bug: sendOutboundReply() fetches the most-recent thread message from Nylas
// (which returns newest-first). If Curia was the last sender, from[0].email is
// Curia's own address — the reply would be self-addressed and blocked by the content
// filter or silently delivered to Curia's inbox. The fix: detect when the latest
// message is ours and look at to[0].email instead.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailAdapter } from '../../../../src/channels/email/email-adapter.js';
import { createLogger } from '../../../../src/logger.js';
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { NylasMessage } from '../../../../src/channels/email/nylas-client.js';
import type { BusEvent } from '../../../../src/bus/events.js';
import { createOutboundMessage, createOutboundNotification } from '../../../../src/bus/events.js';

const SELF_EMAIL = 'curia@example.com';
const CEO_EMAIL = 'ceo@example.com';

function makeMockMessage(overrides: Partial<NylasMessage> = {}): NylasMessage {
  return {
    id: 'msg-1',
    threadId: 'thread-abc',
    subject: 'Hello',
    from: [{ email: CEO_EMAIL, name: 'CEO' }],
    to: [{ email: SELF_EMAIL, name: 'Curia' }],
    cc: [],
    bcc: [],
    body: '<p>Hi</p>',
    snippet: 'Hi',
    date: 1700000000,
    unread: true,
    folders: ['INBOX'],
    ...overrides,
  };
}

function createMocks() {
  const logger = createLogger('error');

  const bus = {
    subscribe: vi.fn(),
    publish: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventBus;

  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
    createContact: vi.fn(),
    linkIdentity: vi.fn(),
  } as unknown as ContactService;

  const outboundGateway = {
    send: vi.fn().mockResolvedValue({ success: true, messageId: 'sent-1' }),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    listEmailMessages: vi.fn().mockResolvedValue([]),
  } as unknown as OutboundGateway;

  return { logger, bus, contactService, outboundGateway };
}

function makeAdapter(mocks: ReturnType<typeof createMocks>) {
  return new EmailAdapter({
    accountId: 'curia',
    outboundPolicy: 'direct',
    bus: mocks.bus,
    logger: mocks.logger,
    outboundGateway: mocks.outboundGateway,
    contactService: mocks.contactService,
    pollingIntervalMs: 999999, // never fires in tests
    selfEmail: SELF_EMAIL,
    observationMode: false,
    excludedSenderEmails: [],
  });
}

/** Flush pending microtasks and macrotasks so an initial poll triggered by start() can complete. */
const flushPoll = () => new Promise<void>(resolve => setTimeout(resolve, 0));

// Trigger the outbound.message handler directly by capturing the subscriber
// registered during start() and calling it with a synthetic event.
function captureOutboundHandler(mocks: ReturnType<typeof createMocks>): (event: BusEvent) => Promise<void> {
  // start() calls bus.subscribe('outbound.message', ...). Capture that callback.
  let handler: ((event: BusEvent) => Promise<void>) | undefined;
  (mocks.bus.subscribe as ReturnType<typeof vi.fn>).mockImplementation(
    (eventType: string, _layer: string, cb: (event: BusEvent) => Promise<void>) => {
      if (eventType === 'outbound.message') {
        handler = cb;
      }
    },
  );
  return (...args) => {
    if (!handler) throw new Error('outbound.message handler not registered — did you call adapter.start()?');
    return handler(...args);
  };
}

function makeOutboundEvent(conversationId: string) {
  return createOutboundMessage({
    conversationId,
    channelId: 'email',
    content: 'Here is my reply.',
    parentEventId: 'task-1',
  });
}

describe('EmailAdapter — sendOutboundReply', () => {
  let mocks: ReturnType<typeof createMocks>;
  let adapter: EmailAdapter;
  let triggerOutbound: (event: BusEvent) => Promise<void>;

  beforeEach(() => {
    mocks = createMocks();
    triggerOutbound = captureOutboundHandler(mocks);
    adapter = makeAdapter(mocks);
    // start() registers the bus subscriber without starting the poll timer
    // (pollingIntervalMs is huge, and we don't await the initial poll)
    void adapter.start();
  });

  it('sends reply to from address when the latest thread message is from the human', async () => {
    // Latest message is from the human — normal first-reply scenario
    const humanMessage = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      to: [{ email: SELF_EMAIL }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([humanMessage]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    expect(mocks.outboundGateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: CEO_EMAIL }),
    );
  });

  it('sends reply to the to address when the latest thread message is from Curia (self)', async () => {
    // Latest message is FROM Curia (we sent the last reply) — the human's address
    // is in the to field, not the from field.
    const curiaMessage = makeMockMessage({
      from: [{ email: SELF_EMAIL }],
      to: [{ email: CEO_EMAIL }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([curiaMessage]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    // Must NOT send to ourselves — must send to the human
    expect(mocks.outboundGateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: CEO_EMAIL }),
    );
    const callArg = (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.to).not.toBe(SELF_EMAIL);
  });

  it('self-address detection is case-insensitive', async () => {
    // Mail servers can return addresses in different casing
    const curiaMessage = makeMockMessage({
      from: [{ email: SELF_EMAIL.toUpperCase() }],
      to: [{ email: CEO_EMAIL }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([curiaMessage]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    expect(mocks.outboundGateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: CEO_EMAIL }),
    );
  });

  it('skips send and logs a warning when no thread messages are found', async () => {
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    expect(mocks.outboundGateway.send).not.toHaveBeenCalled();
  });

  it('skips send when latest message is ours and to field is empty', async () => {
    const curiaMessageNoTo = makeMockMessage({
      from: [{ email: SELF_EMAIL }],
      to: [],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([curiaMessageNoTo]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    expect(mocks.outboundGateway.send).not.toHaveBeenCalled();
  });

  it('skips send when the resolved recipient from to[] is still selfEmail', async () => {
    // Edge case: a self-addressed thread where both from and to are Curia.
    // Must bail out rather than delivering the reply to our own inbox.
    const selfAddressedMessage = makeMockMessage({
      from: [{ email: SELF_EMAIL }],
      to: [{ email: SELF_EMAIL }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([selfAddressedMessage]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    expect(mocks.outboundGateway.send).not.toHaveBeenCalled();
  });

  it('ignores outbound events for non-email channels', async () => {
    const event = createOutboundMessage({
      conversationId: 'signal:convo-1',
      channelId: 'signal',
      content: 'hello',
      parentEventId: 'task-1',
    });

    await triggerOutbound(event);

    // The send path must not be reached for non-email channels.
    // (listEmailMessages may be called by the background poll — that's fine.)
    expect(mocks.outboundGateway.send).not.toHaveBeenCalled();
  });

  it('passes the most recent message id as replyToMessageId for correct threading', async () => {
    const latestMessage = makeMockMessage({
      id: 'msg-latest',
      from: [{ email: CEO_EMAIL }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([latestMessage]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    expect(mocks.outboundGateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: 'msg-latest' }),
    );
  });
});

// ── Inbound poll — excludedSenderEmails and observationMode ──────────────────

describe('EmailAdapter — inbound poll: excludedSenderEmails', () => {
  it('suppresses emails from an excluded sender address', async () => {
    const mocks = createMocks();
    const adapter = new EmailAdapter({
      accountId: 'joseph',
      outboundPolicy: 'draft_gate',
      bus: mocks.bus,
      logger: mocks.logger,
      outboundGateway: mocks.outboundGateway,
      contactService: mocks.contactService,
      pollingIntervalMs: 999999,
      selfEmail: 'joseph@example.com',
      observationMode: false,
      excludedSenderEmails: ['curia@example.com'],
    });

    const msg = makeMockMessage({ from: [{ email: 'curia@example.com' }] });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg]);

    await adapter.start();
    await flushPoll();

    // Suppressed — bus must not publish an inbound event for this message
    const inboundPublish = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .find(([, ev]) => ev?.type === 'inbound.message');
    expect(inboundPublish).toBeUndefined();

    await adapter.stop();
  });

  it('excluded sender check is case-insensitive', async () => {
    const mocks = createMocks();
    const adapter = new EmailAdapter({
      accountId: 'joseph',
      outboundPolicy: 'draft_gate',
      bus: mocks.bus,
      logger: mocks.logger,
      outboundGateway: mocks.outboundGateway,
      contactService: mocks.contactService,
      pollingIntervalMs: 999999,
      selfEmail: 'joseph@example.com',
      observationMode: false,
      excludedSenderEmails: ['CURIA@EXAMPLE.COM'],
    });

    // Sender address uses different casing than the exclusion list entry
    const msg = makeMockMessage({ from: [{ email: 'curia@example.com' }] });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg]);

    await adapter.start();
    await flushPoll();

    const inboundPublish = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .find(([, ev]) => ev?.type === 'inbound.message');
    expect(inboundPublish).toBeUndefined();

    await adapter.stop();
  });

  it('does not suppress emails from non-excluded senders', async () => {
    const mocks = createMocks();
    const adapter = new EmailAdapter({
      accountId: 'joseph',
      outboundPolicy: 'draft_gate',
      bus: mocks.bus,
      logger: mocks.logger,
      outboundGateway: mocks.outboundGateway,
      contactService: mocks.contactService,
      pollingIntervalMs: 999999,
      selfEmail: 'joseph@example.com',
      observationMode: false,
      excludedSenderEmails: ['curia@example.com'],
    });

    // Different sender — should not be suppressed
    const msg = makeMockMessage({ from: [{ email: 'someone@example.com' }] });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg]);

    await adapter.start();
    await flushPoll();

    const inboundPublish = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .find(([, ev]) => ev?.type === 'inbound.message');
    expect(inboundPublish).toBeDefined();

    await adapter.stop();
  });
});

describe('EmailAdapter — inbound poll: observationMode', () => {
  it('stamps observationMode: true in event metadata and skips contact auto-creation', async () => {
    const mocks = createMocks();
    const adapter = new EmailAdapter({
      accountId: 'joseph',
      outboundPolicy: 'draft_gate',
      bus: mocks.bus,
      logger: mocks.logger,
      outboundGateway: mocks.outboundGateway,
      contactService: mocks.contactService,
      pollingIntervalMs: 999999,
      selfEmail: 'joseph@example.com',
      observationMode: true,
      excludedSenderEmails: [],
    });

    const msg = makeMockMessage({
      from: [{ email: 'sender@example.com', name: 'Sender' }],
      to: [{ email: 'joseph@example.com' }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg]);

    await adapter.start();
    await flushPoll();

    // Contact auto-creation must be skipped entirely in observation mode
    expect(mocks.contactService.resolveByChannelIdentity).not.toHaveBeenCalled();
    expect(mocks.contactService.createContact).not.toHaveBeenCalled();

    // Published event must carry observationMode: true in metadata
    const inboundCall = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .find(([, ev]) => ev?.type === 'inbound.message');
    expect(inboundCall).toBeDefined();
    expect(inboundCall![1].payload.metadata.observationMode).toBe(true);

    await adapter.stop();
  });

  it('standard mode runs contact auto-creation and does not stamp observationMode', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks); // observationMode: false

    const msg = makeMockMessage({ from: [{ email: CEO_EMAIL, name: 'CEO' }] });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg]);

    await adapter.start();
    await flushPoll();

    // Contact resolution IS called in standard mode
    expect(mocks.contactService.resolveByChannelIdentity).toHaveBeenCalled();

    // Published event must NOT have observationMode set
    const inboundCall = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .find(([, ev]) => ev?.type === 'inbound.message');
    expect(inboundCall).toBeDefined();
    expect(inboundCall![1].payload.metadata.observationMode).toBeUndefined();

    await adapter.stop();
  });
});

// ---------------------------------------------------------------------------
// outbound.notification subscriber (#206)
// ---------------------------------------------------------------------------

// Capture the outbound.notification handler registered during start().
function captureNotificationHandler(mocks: ReturnType<typeof createMocks>): (event: BusEvent) => Promise<void> {
  let handler: ((event: BusEvent) => Promise<void>) | undefined;
  (mocks.bus.subscribe as ReturnType<typeof vi.fn>).mockImplementation(
    (eventType: string, _layer: string, cb: (event: BusEvent) => Promise<void>) => {
      if (eventType === 'outbound.notification') {
        handler = cb;
      }
    },
  );
  return (...args) => {
    if (!handler) throw new Error('outbound.notification handler not registered — did you call adapter.start()?');
    return handler(...args);
  };
}

describe('EmailAdapter — outbound.notification subscriber', () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
  });

  it('delivers a notification via outboundGateway.send() with skipNotificationOnBlock', async () => {
    const handleNotification = captureNotificationHandler(mocks);
    const adapter = makeAdapter(mocks);
    await adapter.start();

    const event = createOutboundNotification({
      notificationType: 'blocked_content',
      ceoEmail: CEO_EMAIL,
      subject: 'Action needed — blocked outbound reply',
      body: 'Block ID: block_test123',
      blockId: 'block_test123',
      originalChannel: 'email',
      originalRecipientId: 'target@example.com',
    });

    await handleNotification(event);

    expect(mocks.outboundGateway.send).toHaveBeenCalledOnce();
    // Verify skipNotificationOnBlock is passed as the second argument
    const sendCall = (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sendCall[0]).toEqual(expect.objectContaining({
      channel: 'email',
      to: CEO_EMAIL,
      subject: 'Action needed — blocked outbound reply',
    }));
    expect(sendCall[1]).toEqual({ skipNotificationOnBlock: true });

    await adapter.stop();
  });

  it('only the primary account (curia) handles notifications', async () => {
    const handleNotification = captureNotificationHandler(mocks);
    // Create adapter with non-primary accountId
    const adapter = new EmailAdapter({
      accountId: 'joseph',
      outboundPolicy: 'direct',
      bus: mocks.bus,
      logger: mocks.logger,
      outboundGateway: mocks.outboundGateway,
      contactService: mocks.contactService,
      pollingIntervalMs: 999999,
      selfEmail: 'joseph@example.com',
      observationMode: false,
      excludedSenderEmails: [],
    });
    await adapter.start();

    const event = createOutboundNotification({
      notificationType: 'blocked_content',
      ceoEmail: CEO_EMAIL,
      subject: 'Test',
      body: 'Test body',
    });

    await handleNotification(event);

    // Non-primary adapter should not call send
    expect(mocks.outboundGateway.send).not.toHaveBeenCalled();

    await adapter.stop();
  });

  it('logs error when notification delivery fails (send returns success: false)', async () => {
    (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      blockedReason: 'Content blocked by filter',
    });

    const handleNotification = captureNotificationHandler(mocks);
    const adapter = makeAdapter(mocks);
    await adapter.start();

    const event = createOutboundNotification({
      notificationType: 'blocked_content',
      ceoEmail: CEO_EMAIL,
      subject: 'Test',
      body: 'Test body',
      blockId: 'block_test456',
      originalChannel: 'email',
    });

    // Should not throw — errors are caught and logged
    await handleNotification(event);

    expect(mocks.outboundGateway.send).toHaveBeenCalledOnce();
    await adapter.stop();
  });
});
