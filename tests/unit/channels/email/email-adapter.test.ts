// Tests for EmailAdapter — focused on the outbound reply routing fix (issue #244).
//
// The bug: sendOutboundReply() fetches the most-recent thread message from Nylas
// (which returns newest-first). If Curia was the last sender, from[0].email is
// Curia's own address — the reply would be self-addressed and blocked by the content
// filter or silently delivered to Curia's inbox. The fix: detect when the latest
// message is ours and look at to[0].email instead.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    attachments: [],
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
    createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'draft-1' }),
    linkGatedAction: vi.fn().mockResolvedValue(undefined),
    listEmailMessages: vi.fn().mockResolvedValue([]),
    sendNotification: vi.fn().mockResolvedValue(undefined),
  } as unknown as OutboundGateway;

  return { logger, bus, contactService, outboundGateway };
}

function makeAdapter(mocks: ReturnType<typeof createMocks>, overrides: Partial<{
  contactCreationMaxPerMessage: number;
  contactCreationMaxPerHour: number;
  ceoEmail: string;
  timezone: string;
}> = {}) {
  return new EmailAdapter({
    accountId: 'curia',
    bus: mocks.bus,
    logger: mocks.logger,
    outboundGateway: mocks.outboundGateway,
    contactService: mocks.contactService,
    pollingIntervalMs: 7_200_000, // 2 hours — never fires in tests, even under vi.advanceTimersByTime(3_600_001)
    selfEmail: SELF_EMAIL,
    excludedSenderEmails: [],
    contactCreationMaxPerMessage: overrides.contactCreationMaxPerMessage ?? 10,
    contactCreationMaxPerHour: overrides.contactCreationMaxPerHour ?? 100,
    ceoEmail: overrides.ceoEmail ?? CEO_EMAIL,
    timezone: overrides.timezone ?? 'America/Toronto',
  });
}

/** Flush pending microtasks and macrotasks so an initial poll triggered by start() can complete. */
const flushPoll = () => new Promise<void>(resolve => setTimeout(resolve, 0));

// Capture the bus.subscribe handler for a given event type by intercepting the
// subscribe call during start(). Supports multiple event types simultaneously
// by storing handlers in a shared map keyed by eventType.
function captureHandler(
  eventType: string,
  mocks: ReturnType<typeof createMocks>,
): (event: BusEvent) => Promise<void> {
  const handlers = ((mocks.bus.subscribe as ReturnType<typeof vi.fn>).__handlerMap ??= {}) as
    Record<string, (event: BusEvent) => Promise<void>>;
  (mocks.bus.subscribe as ReturnType<typeof vi.fn>).mockImplementation(
    (et: string, _layer: string, cb: (event: BusEvent) => Promise<void>) => {
      handlers[et] = cb;
    },
  );
  return (...args) => {
    const handler = handlers[eventType];
    if (!handler) throw new Error(`${eventType} handler not registered — did you call adapter.start()?`);
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
    triggerOutbound = captureHandler('outbound.message', mocks);
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
      expect.any(Object),
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
      expect.any(Object),
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
      expect.any(Object),
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
      expect.any(Object),
    );
  });

  // ── Reply-quote behavior (issue #720) ──────────────────────────────────────
  // The natural agent-response path (this path) was missed when buildReplyQuote
  // was wired into the skill handlers. Quote block must match the format used by
  // the email-send / email-reply skills.

  it('appends a quoted original message block to the reply body', async () => {
    const humanMessage = makeMockMessage({
      from: [{ email: CEO_EMAIL, name: 'CEO' }],
      to: [{ email: SELF_EMAIL }],
      subject: 'Q2 planning',
      body: '<p>Hi Curia, can we sync on Q2?</p>',
      date: 1700000000,
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([humanMessage]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    const callArg = (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // Reply body stays as markdown in body field; gateway converts it to HTML
    expect(callArg.body).toContain('Here is my reply.');
    // HTML quote is passed separately so it is not re-escaped by markdownToHtml
    expect(callArg.htmlQuote).toContain('<strong>From:</strong>');
    expect(callArg.htmlQuote).toContain('CEO');
    expect(callArg.htmlQuote).toContain('ceo@example.com');
    expect(callArg.htmlQuote).toContain('Q2 planning');
    // Original HTML body is preserved inside the blockquote (not stripped to plain text)
    expect(callArg.htmlQuote).toContain('<blockquote');
    expect(callArg.htmlQuote).toContain('Hi Curia, can we sync on Q2?');
  });

  it('uses the configured timezone when rendering the quoted Date line', async () => {
    // date: 1700000000 = 2023-11-14T22:13:20Z; in America/Toronto that is 5:13 PM EST
    const humanMessage = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      to: [{ email: SELF_EMAIL }],
      date: 1700000000,
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([humanMessage]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    const callArg = (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.htmlQuote).toMatch(/2023-11-14, 5:13 PM EST/);
  });

  it('sends with quote headers (bodyless) when original body is undefined', async () => {
    // htmlToText(undefined) returns '' gracefully, so buildReplyQuote succeeds and
    // produces a quote block with headers but no body section. The recipient-
    // resolution code only touches from/to, so it still resolves cleanly.
    const brokenMessage = {
      ...makeMockMessage({
        from: [{ email: CEO_EMAIL }],
        to: [{ email: SELF_EMAIL }],
      }),
      body: undefined as unknown as string,
    };
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([brokenMessage]);
    const warnSpy = vi.spyOn(mocks.logger, 'warn');

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    // Send still happens — quoted headers are included, no blockquote (empty body)
    expect(mocks.outboundGateway.send).toHaveBeenCalledOnce();
    const callArg = (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.body).toContain('Here is my reply.');
    expect(callArg.htmlQuote).toContain('<strong>From:</strong>');
    expect(callArg.htmlQuote).toContain('<strong>Subject:</strong>');
    // No blockquote when the original body is empty
    expect(callArg.htmlQuote).not.toContain('<blockquote');
    // No warning — buildReplyQuote succeeded
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('sends without quote and logs warning when buildReplyQuote throws', async () => {
    // Force buildReplyQuote to throw by providing a null `to` field (null.map() throws
    // TypeError inside buildReplyQuote). The adapter only accesses `to` when the latest
    // message is ours; since `from` here is the human's address, `latestIsOurs` is false
    // and recipient resolution succeeds — the throw happens inside buildReplyQuote itself.
    // This exercises the try/catch at email-adapter.ts:486-496.
    const throwingMessage = {
      ...makeMockMessage({
        from: [{ email: CEO_EMAIL }],
        to: [{ email: SELF_EMAIL }],
      }),
      to: null as unknown as Array<{ email: string }>,
    };
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([throwingMessage]);
    const warnSpy = vi.spyOn(mocks.logger, 'warn');

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    // Send still happens — unquoted
    expect(mocks.outboundGateway.send).toHaveBeenCalledOnce();
    const callArg = (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.body).toBe('Here is my reply.');
    expect(callArg.body).not.toContain('---------- Original Message ----------');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-abc' }),
      expect.stringContaining('failed to build reply quote'),
    );
  });

  it('omits quote when body + quote would exceed MAX_BODY_LENGTH', async () => {
    // Build a message whose body alone is just under the 50000 limit; appending
    // any quote header tips it over.
    const hugeBody = '<p>' + 'x'.repeat(49_900) + '</p>';
    const humanMessage = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      to: [{ email: SELF_EMAIL }],
      body: hugeBody,
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([humanMessage]);

    // The agent's own reply is short — the *quote* is what would tip it over.
    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    const callArg = (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(callArg.body).toBe('Here is my reply.');
    expect(callArg.body).not.toContain('---------- Original Message ----------');
  });
});

// ── Inbound poll — excludedSenderEmails ──────────────────

describe('EmailAdapter — inbound poll: excludedSenderEmails', () => {
  it('suppresses emails from an excluded sender address', async () => {
    const mocks = createMocks();
    const adapter = new EmailAdapter({
      accountId: 'joseph',
      bus: mocks.bus,
      logger: mocks.logger,
      outboundGateway: mocks.outboundGateway,
      contactService: mocks.contactService,
      pollingIntervalMs: 999999,
      selfEmail: 'joseph@example.com',
      excludedSenderEmails: ['curia@example.com'],
      contactCreationMaxPerMessage: 10,
      contactCreationMaxPerHour: 100,
      ceoEmail: CEO_EMAIL,
      timezone: 'America/Toronto',
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
      bus: mocks.bus,
      logger: mocks.logger,
      outboundGateway: mocks.outboundGateway,
      contactService: mocks.contactService,
      pollingIntervalMs: 999999,
      selfEmail: 'joseph@example.com',
      excludedSenderEmails: ['CURIA@EXAMPLE.COM'],
      contactCreationMaxPerMessage: 10,
      contactCreationMaxPerHour: 100,
      ceoEmail: CEO_EMAIL,
      timezone: 'America/Toronto',
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
      bus: mocks.bus,
      logger: mocks.logger,
      outboundGateway: mocks.outboundGateway,
      contactService: mocks.contactService,
      pollingIntervalMs: 999999,
      selfEmail: 'joseph@example.com',
      excludedSenderEmails: ['curia@example.com'],
      contactCreationMaxPerMessage: 10,
      contactCreationMaxPerHour: 100,
      ceoEmail: CEO_EMAIL,
      timezone: 'America/Toronto',
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

// ---------------------------------------------------------------------------
// outbound.notification subscriber (#206)
// ---------------------------------------------------------------------------

describe('EmailAdapter — outbound.notification subscriber', () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
  });

  it('delivers a notification via outboundGateway.send() with skipNotificationOnBlock', async () => {
    const handleNotification = captureHandler('outbound.notification', mocks);
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
    expect(sendCall[1]).toEqual({ skipNotificationOnBlock: true, isSystemNotification: true });

    await adapter.stop();
  });

  it('only the primary account (curia) handles notifications', async () => {
    const handleNotification = captureHandler('outbound.notification', mocks);
    // Create adapter with non-primary accountId
    const adapter = new EmailAdapter({
      accountId: 'joseph',
      bus: mocks.bus,
      logger: mocks.logger,
      outboundGateway: mocks.outboundGateway,
      contactService: mocks.contactService,
      pollingIntervalMs: 999999,
      selfEmail: 'joseph@example.com',
      excludedSenderEmails: [],
      contactCreationMaxPerMessage: 10,
      contactCreationMaxPerHour: 100,
      ceoEmail: CEO_EMAIL,
      timezone: 'America/Toronto',
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
    const errorSpy = vi.spyOn(mocks.logger, 'error');

    const handleNotification = captureHandler('outbound.notification', mocks);
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
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationType: 'blocked_content',
        reason: 'Content blocked by filter',
      }),
      expect.stringContaining('failed to deliver outbound.notification'),
    );
    await adapter.stop();
  });
});

// ---------------------------------------------------------------------------
// Contact auto-creation rate limiting (#36)
// ---------------------------------------------------------------------------

describe('EmailAdapter — contact auto-creation rate limiting', () => {
  // Ensure fake timers are always restored after each test in this block, even
  // when a test times out (a try/finally in the test body is not reliable on
  // timeout because Vitest abandons the async stack). This prevents fake-timer
  // state from leaking into subsequent tests.
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Build an email with N unique CC participants (+ the from sender). */
  function makeMockMessageWithParticipants(ccCount: number): NylasMessage {
    const ccList = Array.from({ length: ccCount }, (_, i) => ({
      email: `cc${i}@example.com`,
      name: `CC User ${i}`,
    }));
    return makeMockMessage({
      from: [{ email: 'sender@example.com', name: 'Sender' }],
      to: [{ email: SELF_EMAIL }],
      cc: ccList,
    });
  }

  it('enforces per-message cap — only creates max_per_message new contacts', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { contactCreationMaxPerMessage: 3 });

    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // 6 non-self participants (1 from + 5 CC)
    const msg = makeMockMessageWithParticipants(5);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg]);

    await adapter.start();
    await flushPoll();

    // Only 3 contacts should be created (per-message cap of 3)
    expect(mocks.contactService.createContact).toHaveBeenCalledTimes(3);

    await adapter.stop();
  });

  it('enforces per-hour cap across multiple emails', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { contactCreationMaxPerHour: 2, contactCreationMaxPerMessage: 100 });

    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // First email: 2 new participants (from + 1 CC) — creates 2, hits hourly cap
    const msg1 = makeMockMessage({
      id: 'msg-a', date: 1700000001,
      from: [{ email: 'a@example.com' }],
      to: [{ email: SELF_EMAIL }],
      cc: [{ email: 'b@example.com' }],
    });
    // Second email: 1 new participant — should be skipped (hourly cap already hit)
    const msg2 = makeMockMessage({
      id: 'msg-b', date: 1700000002,
      from: [{ email: 'c@example.com' }],
      to: [{ email: SELF_EMAIL }],
      cc: [],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg1, msg2]);

    await adapter.start();
    await flushPoll();

    // Only 2 contacts created total (hourly cap of 2), not 3
    expect(mocks.contactService.createContact).toHaveBeenCalledTimes(2);

    await adapter.stop();
  });

  it('resets hourly window after 1 hour', async () => {
    vi.useFakeTimers();
    try {
      const mocks = createMocks();
      const adapter = makeAdapter(mocks, { contactCreationMaxPerHour: 1, contactCreationMaxPerMessage: 100 });

      (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
      (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      // First poll: 1 new participant — hits hourly cap of 1
      const msg1 = makeMockMessage({
        id: 'msg-a', date: 1700000001,
        from: [{ email: 'first@example.com' }],
        to: [{ email: SELF_EMAIL }],
      });
      (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg1]);

      // start() awaits the initial poll, so by the time start() resolves the
      // first poll has already completed. flushPoll() would hang here because
      // setTimeout is fake — skip it and assert directly.
      await adapter.start();

      expect(mocks.contactService.createContact).toHaveBeenCalledTimes(1);

      // Advance time by 1 hour + 1ms so the window resets
      vi.advanceTimersByTime(3_600_001);

      // Second poll: 1 new participant — window should have reset, creation succeeds
      const msg2 = makeMockMessage({
        id: 'msg-b', date: 1700003602,
        from: [{ email: 'second@example.com' }],
        to: [{ email: SELF_EMAIL }],
      });
      (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg2]);

      await (adapter as unknown as { poll(): Promise<void> }).poll();

      expect(mocks.contactService.createContact).toHaveBeenCalledTimes(2);

      await adapter.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('existing contacts do not count toward the per-message cap', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { contactCreationMaxPerMessage: 2 });

    // First 3 participants already exist, last 2 are new
    let resolveCallCount = 0;
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockImplementation(() => {
      resolveCallCount++;
      return Promise.resolve(resolveCallCount <= 3 ? { id: 'existing' } : null);
    });
    (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // 5 non-self participants (1 from + 4 CC)
    const msg = makeMockMessageWithParticipants(4);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg]);

    await adapter.start();
    await flushPoll();

    // 3 existed, 2 are new — both new ones created (under the cap of 2)
    expect(mocks.contactService.createContact).toHaveBeenCalledTimes(2);

    await adapter.stop();
  });

  it('sends outbound.notification when per-message cap is hit', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { contactCreationMaxPerMessage: 1 });

    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // 3 non-self participants (from + 2 CC), cap is 1 — 2 will be skipped
    const msg = makeMockMessage({
      from: [{ email: 'a@example.com' }],
      to: [{ email: SELF_EMAIL }],
      cc: [{ email: 'b@example.com' }, { email: 'c@example.com' }],
      subject: 'Board meeting notes',
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg]);

    await adapter.start();
    await flushPoll();

    expect(mocks.outboundGateway.sendNotification).toHaveBeenCalledOnce();
    const notifPayload = (mocks.outboundGateway.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(notifPayload.notificationType).toBe('contact_rate_limited');
    expect(notifPayload.ceoEmail).toBe(CEO_EMAIL);
    expect(notifPayload.subject).toContain('rate limit');

    await adapter.stop();
  });

  it('deduplicates notifications — only one per limit type per hour', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { contactCreationMaxPerMessage: 1 });

    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // Two emails that both trigger the per-message limit
    const msg1 = makeMockMessage({
      id: 'msg-a', date: 1700000001,
      from: [{ email: 'a@example.com' }],
      to: [{ email: SELF_EMAIL }],
      cc: [{ email: 'b@example.com' }],
    });
    const msg2 = makeMockMessage({
      id: 'msg-b', date: 1700000002,
      from: [{ email: 'c@example.com' }],
      to: [{ email: SELF_EMAIL }],
      cc: [{ email: 'd@example.com' }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg1, msg2]);

    await adapter.start();
    await flushPoll();

    // Only one notification despite two rate-limit hits in the same hour
    expect(mocks.outboundGateway.sendNotification).toHaveBeenCalledOnce();

    await adapter.stop();
  });

  it('respects custom config overrides for limits', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { contactCreationMaxPerMessage: 2, contactCreationMaxPerHour: 5 });

    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (mocks.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c1' });
    (mocks.contactService.linkIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    // 4 non-self participants (1 from + 3 CC) — per-message cap of 2 should apply
    const msg = makeMockMessageWithParticipants(3);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([msg]);

    await adapter.start();
    await flushPoll();

    expect(mocks.contactService.createContact).toHaveBeenCalledTimes(2);

    await adapter.stop();
  });
});

// ---------------------------------------------------------------------------
// sendWithGatedDraftFallback — gated fallback (#435)
// ---------------------------------------------------------------------------

describe('EmailAdapter — sendWithGatedDraftFallback gated-fallback', () => {
  let mocks: ReturnType<typeof createMocks>;
  let triggerOutbound: (event: BusEvent) => Promise<void>;

  beforeEach(() => {
    mocks = createMocks();
    triggerOutbound = captureHandler('outbound.message', mocks);
  });

  function makeOutboundEventWithTask(conversationId: string, taskEventId?: string) {
    return createOutboundMessage({
      conversationId,
      channelId: 'email',
      content: 'Here is my reply.',
      parentEventId: 'response-1',
      taskEventId,
    });
  }

  it('calls gateway.send() with context for direct policy', async () => {
    const adapter = makeAdapter(mocks);
    await adapter.start();

    const humanMessage = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      to: [{ email: SELF_EMAIL }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([humanMessage]);

    await triggerOutbound(makeOutboundEventWithTask('email:thread-abc', 'task-evt-1'));

    expect(mocks.outboundGateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: CEO_EMAIL }),
      expect.objectContaining({ taskEventId: 'task-evt-1', conversationId: 'email:thread-abc' }),
    );

    await adapter.stop();
  });

  it('creates draft and links action when gateway returns gated', async () => {
    // Gateway returns gated result
    (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      gated: true,
      actionRef: 'email-42',
    });
    (mocks.outboundGateway.createEmailDraft as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      draftId: 'draft-abc',
    });

    const adapter = makeAdapter(mocks);
    await adapter.start();

    const humanMessage = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      to: [{ email: SELF_EMAIL }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([humanMessage]);

    await triggerOutbound(makeOutboundEventWithTask('email:thread-abc', 'task-evt-2'));

    // Draft should be created as fallback
    expect(mocks.outboundGateway.createEmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({ to: CEO_EMAIL, channel: 'email' }),
    );

    // linkGatedAction should be called with the actionRef, taskEventId, and just the draft_id.
    // account is already in the partialPayload stored at gate time — no need to repeat it here.
    expect(mocks.outboundGateway.linkGatedAction).toHaveBeenCalledWith(
      'email-42',
      'task-evt-2',
      { draft_id: 'draft-abc' },
    );

    await adapter.stop();
  });

  it('does not link action when draft creation fails', async () => {
    (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      gated: true,
      actionRef: 'email-99',
    });
    (mocks.outboundGateway.createEmailDraft as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      blockedReason: 'Recipient is blocked',
    });

    const adapter = makeAdapter(mocks);
    await adapter.start();

    const humanMessage = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      to: [{ email: SELF_EMAIL }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([humanMessage]);

    await triggerOutbound(makeOutboundEventWithTask('email:thread-abc'));

    // Draft creation attempted
    expect(mocks.outboundGateway.createEmailDraft).toHaveBeenCalled();
    // But linkGatedAction should NOT be called because draft failed
    expect(mocks.outboundGateway.linkGatedAction).not.toHaveBeenCalled();

    await adapter.stop();
  });

});

// ---------------------------------------------------------------------------
// Inbound poll — self-loop hardening (#37)
// Three-layer defense: folder detection, sent-ID tracking, plus-address normalization
// ---------------------------------------------------------------------------

describe('EmailAdapter — inbound poll: self-loop hardening', () => {
  // Helper to create an adapter with a single-shot poll and start it.
  async function startWithMessages(msgs: NylasMessage[]) {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce(msgs);
    await adapter.start();
    await flushPoll();
    return { mocks, adapter };
  }

  function wasPublished(mocks: ReturnType<typeof createMocks>) {
    return (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .find(([, ev]) => ev?.type === 'inbound.message') !== undefined;
  }

  // ── Layer 1: folder-based detection ───────────────────────────────────────

  it('skips message in SENT folder regardless of From address', async () => {
    const msg = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      folders: ['SENT'],
    });
    const { mocks, adapter } = await startWithMessages([msg]);
    expect(wasPublished(mocks)).toBe(false);
    await adapter.stop();
  });

  it('skips message in DRAFTS folder', async () => {
    const msg = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      folders: ['DRAFTS'],
    });
    const { mocks, adapter } = await startWithMessages([msg]);
    expect(wasPublished(mocks)).toBe(false);
    await adapter.stop();
  });

  it('skips message with mixed folders when one is SENT', async () => {
    // Some providers tag messages with both INBOX and SENT simultaneously
    const msg = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      folders: ['INBOX', 'SENT'],
    });
    const { mocks, adapter } = await startWithMessages([msg]);
    expect(wasPublished(mocks)).toBe(false);
    await adapter.stop();
  });

  it('does not skip a normal INBOX message', async () => {
    // Sanity check — regular inbound from CEO must still be published
    const msg = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      folders: ['INBOX'],
    });
    const { mocks, adapter } = await startWithMessages([msg]);
    expect(wasPublished(mocks)).toBe(true);
    await adapter.stop();
  });

  it('skips message with Gmail-style folder name ([Gmail]/Sent Mail)', async () => {
    const msg = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      folders: ['[Gmail]/Sent Mail'],
    });
    const { mocks, adapter } = await startWithMessages([msg]);
    expect(wasPublished(mocks)).toBe(false);
    await adapter.stop();
  });

  it('skips message with Outlook-style folder name (Sent Items)', async () => {
    const msg = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      folders: ['Sent Items'],
    });
    const { mocks, adapter } = await startWithMessages([msg]);
    expect(wasPublished(mocks)).toBe(false);
    await adapter.stop();
  });

  it('skips message with suffixed draft folder name (Drafts_Old)', async () => {
    const msg = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      folders: ['Drafts_Old'],
    });
    const { mocks, adapter } = await startWithMessages([msg]);
    expect(wasPublished(mocks)).toBe(false);
    await adapter.stop();
  });

  // ── Layer 2: recently-sent message ID tracking ────────────────────────────

  it('skips inbound message whose ID matches a recently-sent message', async () => {
    const mocks = createMocks();
    const triggerOutbound = captureHandler('outbound.message', mocks);
    const adapter = makeAdapter(mocks);

    // Outbound reply succeeds — gateway returns a messageId
    (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      messageId: 'sent-loop-id',
    });
    const threadMsg = makeMockMessage({
      id: 'thread-msg-1',
      from: [{ email: CEO_EMAIL }],
      to: [{ email: SELF_EMAIL }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([threadMsg]);

    await adapter.start();
    await flushPoll();

    // Trigger an outbound reply — this causes the adapter to call gateway.send()
    // and track the returned 'sent-loop-id'
    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    // Simulate the next inbound poll returning the sent message (ID = 'sent-loop-id')
    const sentMsgAsInbound = makeMockMessage({
      id: 'sent-loop-id',
      from: [{ email: SELF_EMAIL }], // From would match selfEmail — but folder + ID checks run first
      folders: ['INBOX'], // Not in SENT — only the ID check would catch it
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([sentMsgAsInbound]);

    // Reset publish spy so we only see events from this poll
    (mocks.bus.publish as ReturnType<typeof vi.fn>).mockClear();
    await (adapter as unknown as { poll(): Promise<void> }).poll();

    expect(wasPublished(mocks)).toBe(false);

    await adapter.stop();
  });

  it('does not skip a message whose ID is not in the recently-sent set', async () => {
    // Regression: ensure the ID check does not filter legitimate inbound messages
    const msg = makeMockMessage({
      id: 'inbound-new-id',
      from: [{ email: CEO_EMAIL }],
    });
    const { mocks, adapter } = await startWithMessages([msg]);
    expect(wasPublished(mocks)).toBe(true);
    await adapter.stop();
  });

  // ── Layer 3: plus-address normalization ──────────────────────────────────

  it('skips message from selfEmail with a plus-address tag', async () => {
    // SELF_EMAIL = 'curia@example.com'; from = 'curia+alerts@example.com'
    const msg = makeMockMessage({
      from: [{ email: 'curia+alerts@example.com' }],
      folders: ['INBOX'],
    });
    const { mocks, adapter } = await startWithMessages([msg]);
    expect(wasPublished(mocks)).toBe(false);
    await adapter.stop();
  });

  it('skips message from selfEmail in all-caps (case normalization)', async () => {
    const msg = makeMockMessage({
      from: [{ email: SELF_EMAIL.toUpperCase() }],
      folders: ['INBOX'],
    });
    const { mocks, adapter } = await startWithMessages([msg]);
    expect(wasPublished(mocks)).toBe(false);
    await adapter.stop();
  });

  it('does not skip a legitimate external sender that merely shares a domain with self', async () => {
    // 'otherperson@example.com' is NOT selfEmail — must not be filtered
    const msg = makeMockMessage({
      from: [{ email: 'otherperson@example.com' }],
      folders: ['INBOX'],
    });
    const { mocks, adapter } = await startWithMessages([msg]);
    expect(wasPublished(mocks)).toBe(true);
    await adapter.stop();
  });

  // ── Forwarding scenario (security@meetcuria.com → nathancuria1@gmail.com) ──

  it('skips a send-as alias reply appearing in SENT — forwarding scenario', async () => {
    // Curia uses security@meetcuria.com as send-as alias; selfEmail is nathancuria1@gmail.com.
    // Mail provider may surface the sent message with From: security@meetcuria.com.
    // The folder check (SENT) must catch it before the address check runs.
    const mocks = createMocks();
    const adapter = new EmailAdapter({
      accountId: 'curia',
      bus: mocks.bus,
      logger: mocks.logger,
      outboundGateway: mocks.outboundGateway,
      contactService: mocks.contactService,
      pollingIntervalMs: 999999,
      selfEmail: 'nathancuria1@gmail.com',
      excludedSenderEmails: [],
      contactCreationMaxPerMessage: 10,
      contactCreationMaxPerHour: 100,
      ceoEmail: CEO_EMAIL,
      timezone: 'America/Toronto',
    });

    const sentViaAlias = makeMockMessage({
      from: [{ email: 'security@meetcuria.com' }], // alias, not selfEmail
      folders: ['SENT'],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([sentViaAlias]);

    await adapter.start();
    await flushPoll();

    const published = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .find(([, ev]) => ev?.type === 'inbound.message');
    expect(published).toBeUndefined();

    await adapter.stop();
  });
});

// ---------------------------------------------------------------------------
// sendOutboundReply — CC behaviour
// ---------------------------------------------------------------------------

describe('EmailAdapter — sendOutboundReply CC', () => {
  let mocks: ReturnType<typeof createMocks>;
  let adapter: EmailAdapter;
  let triggerOutbound: (event: BusEvent) => Promise<void>;

  beforeEach(() => {
    mocks = createMocks();
    triggerOutbound = captureHandler('outbound.message', mocks);
    adapter = makeAdapter(mocks);
    void adapter.start();
  });

  it('includes CC recipients from the thread message in the send call', async () => {
    const threadMessage = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      to: [{ email: SELF_EMAIL }],
      cc: [{ email: 'cc@example.com', name: 'CC Person' }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([threadMessage]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    expect(mocks.outboundGateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ cc: ['cc@example.com'] }),
      expect.any(Object),
    );
  });

  it('filters selfEmail from CC recipients', async () => {
    // Thread message has self in CC — must be excluded from outbound reply CC
    const threadMessage = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      to: [{ email: SELF_EMAIL }],
      cc: [{ email: SELF_EMAIL, name: 'Curia' }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([threadMessage]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    // send() should not receive a cc property (empty CC list is omitted)
    const sendArg = (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sendArg.cc).toBeUndefined();
  });

  it('filters the primary To recipient from CC recipients', async () => {
    // Thread message has the primary recipient (CEO_EMAIL) also in CC.
    // This can happen in thread shapes where a participant appears in both To and CC
    // of the fetched message. The adapter must not double-address the recipient.
    const threadMessage = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      to: [{ email: SELF_EMAIL }],
      cc: [{ email: CEO_EMAIL, name: 'CEO' }, { email: 'other@example.com' }],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([threadMessage]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    // CEO_EMAIL is the primary To recipient — it must NOT appear in CC
    const sendArg = (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sendArg.cc).toEqual(['other@example.com']);
  });

  it('omits CC field from send when CC list is empty after filtering', async () => {
    // to[] only contains selfEmail (filtered out), cc[] is empty — no CC should be set.
    const threadMessage = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      to: [{ email: SELF_EMAIL }],
      cc: [], // no CC at all
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([threadMessage]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    const sendArg = (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sendArg.cc).toBeUndefined();
  });

  it('includes To recipients in reply-all CC', async () => {
    // Thread message has an extra address in to[] that is neither the primary recipient
    // nor selfEmail — it should appear in the outbound CC (reply-all behaviour).
    const threadMessage = makeMockMessage({
      from: [{ email: CEO_EMAIL }],
      to: [{ email: 'extra@example.com' }],
      cc: [],
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValue([threadMessage]);

    await triggerOutbound(makeOutboundEvent('email:thread-abc'));

    expect(mocks.outboundGateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ cc: ['extra@example.com'] }),
      expect.any(Object),
    );
  });
});

describe('EmailAdapter — fresh-send path (compose-reply sidebar)', () => {
  // When outbound.payload.subject is set, the adapter must send a fresh email
  // to recipientId instead of threading into the conversationId thread. This path
  // is used by the dispatcher's compose-reply sidebar split so the principal update
  // goes to the CEO, not back to the original external sender's thread.

  let mocks: ReturnType<typeof createMocks>;
  let triggerOutbound: (event: BusEvent) => Promise<void>;

  beforeEach(async () => {
    mocks = createMocks();
    triggerOutbound = captureHandler('outbound.message', mocks);
    void makeAdapter(mocks).start();
    // Let the initial poll complete, then reset call counts so assertions only
    // capture what happens in response to the triggered outbound event.
    await flushPoll();
    vi.clearAllMocks();
    // Re-stub send after clearAllMocks so it still returns a resolved promise.
    (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, messageId: 'sent-1' });
  });

  it('sends a fresh email to recipientId using the provided subject (no thread lookup)', async () => {
    const event = createOutboundMessage({
      conversationId: 'email:armin-thread',
      channelId: 'email',
      content: 'CEO update: confirmed Fri 2 PM with Armin.',
      recipientId: CEO_EMAIL,
      subject: 'Task update',
      parentEventId: 'task-99',
    });

    await triggerOutbound(event);

    // Must send to the principal, not look up the original thread
    expect(mocks.outboundGateway.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: CEO_EMAIL,
        subject: 'Task update',
        body: 'CEO update: confirmed Fri 2 PM with Armin.',
      }),
      expect.any(Object),
    );
    // Must NOT do a thread lookup (that would route to the external sender)
    expect(mocks.outboundGateway.listEmailMessages).not.toHaveBeenCalled();
  });

  it('does not include replyToMessageId in the fresh-send request', async () => {
    const event = createOutboundMessage({
      conversationId: 'email:armin-thread',
      channelId: 'email',
      content: 'CEO update: confirmed Fri 2 PM with Armin.',
      recipientId: CEO_EMAIL,
      subject: 'Task update',
      parentEventId: 'task-99',
    });

    await triggerOutbound(event);

    const [[sendArg]] = (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mock.calls as [[Record<string, unknown>]];
    expect(sendArg!['replyToMessageId']).toBeUndefined();
  });

  it('skips delivery and logs an error when subject is set but recipientId is absent', async () => {
    const event = createOutboundMessage({
      conversationId: 'email:armin-thread',
      channelId: 'email',
      content: 'CEO update.',
      // recipientId deliberately omitted
      subject: 'Task update',
      parentEventId: 'task-99',
    });

    await triggerOutbound(event);

    expect(mocks.outboundGateway.send).not.toHaveBeenCalled();
    expect(mocks.outboundGateway.listEmailMessages).not.toHaveBeenCalled();
  });
});
