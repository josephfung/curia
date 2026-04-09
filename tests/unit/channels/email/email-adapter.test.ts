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
import { createOutboundMessage } from '../../../../src/bus/events.js';

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
    listEmailMessages: vi.fn().mockResolvedValue([]),
  } as unknown as OutboundGateway;

  return { logger, bus, contactService, outboundGateway };
}

function makeAdapter(mocks: ReturnType<typeof createMocks>) {
  return new EmailAdapter({
    bus: mocks.bus,
    logger: mocks.logger,
    outboundGateway: mocks.outboundGateway,
    contactService: mocks.contactService,
    pollingIntervalMs: 999999, // never fires in tests
    selfEmail: SELF_EMAIL,
  });
}

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
