import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { EventBus } from '../../../../src/bus/bus.js';
import { SignalAdapter } from '../../../../src/channels/signal/signal-adapter.js';
import type { SignalRpcClient } from '../../../../src/channels/signal/signal-rpc-client.js';
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';
import type { SignalEnvelope } from '../../../../src/channels/signal/types.js';
import type { OutboundMessageEvent } from '../../../../src/bus/events.js';
import { createLogger } from '../../../../src/logger.js';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSilentLogger() {
  return pino({ level: 'silent' });
}

/** Minimal EventEmitter standing in for SignalRpcClient */
function makeMockRpcClient() {
  const emitter = new EventEmitter() as EventEmitter & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    sendReadReceipt: ReturnType<typeof vi.fn>;
    listGroups: ReturnType<typeof vi.fn>;
    // Helper to simulate an inbound message from signal-cli
    simulateMessage: (envelope: SignalEnvelope) => void;
  };

  // connect() is synchronous in the real implementation
  emitter.connect = vi.fn().mockReturnValue(undefined);
  emitter.disconnect = vi.fn().mockResolvedValue(undefined);
  emitter.send = vi.fn().mockResolvedValue(undefined);
  emitter.sendReadReceipt = vi.fn().mockResolvedValue(undefined);
  emitter.listGroups = vi.fn().mockResolvedValue([]);
  emitter.simulateMessage = (envelope) => emitter.emit('message', envelope);

  return emitter as unknown as SignalRpcClient & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    sendReadReceipt: ReturnType<typeof vi.fn>;
    listGroups: ReturnType<typeof vi.fn>;
    simulateMessage: (envelope: SignalEnvelope) => void;
  };
}

function makeMockGateway() {
  return {
    send: vi.fn().mockResolvedValue({ success: true }),
    getSignalGroupMembers: vi.fn().mockRejectedValue(new Error('Signal client not configured')),
  } as unknown as OutboundGateway;
}

function makeMockContactService(resolved: { contactId: string; status: string } | null = null) {
  return {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(resolved),
    createContact: vi.fn().mockResolvedValue({ id: 'new-contact-id' }),
    linkIdentity: vi.fn().mockResolvedValue(undefined),
  } as unknown as ContactService;
}

function makeEnvelope(overrides: Partial<SignalEnvelope> = {}): SignalEnvelope {
  return {
    source: '+14155551234',
    sourceNumber: '+14155551234',
    sourceUuid: 'uuid-abc',
    sourceName: 'Alice',
    sourceDevice: 1,
    timestamp: 1700000000000,
    dataMessage: {
      timestamp: 1700000000000,
      message: 'Hello Nathan',
      expiresInSeconds: 0,
      viewOnce: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SignalAdapter', () => {
  let bus: EventBus;
  let rpcClient: ReturnType<typeof makeMockRpcClient>;
  let gateway: ReturnType<typeof makeMockGateway>;
  let contactService: ReturnType<typeof makeMockContactService>;
  let adapter: SignalAdapter;
  const logger = makeSilentLogger();
  const PHONE = '+15555550000';

  beforeEach(async () => {
    bus = new EventBus(createLogger('error'));
    rpcClient = makeMockRpcClient();
    gateway = makeMockGateway();
    contactService = makeMockContactService();

    adapter = new SignalAdapter({
      bus,
      logger,
      rpcClient,
      outboundGateway: gateway,
      contactService,
      phoneNumber: PHONE,
      ceoEmail: 'ceo@example.com',
    });

    await adapter.start();
  });

  afterEach(async () => {
    await adapter.stop();
  });

  // ---------------------------------------------------------------------------
  // Inbound — happy path
  // ---------------------------------------------------------------------------

  it('publishes an inbound.message event when a 1:1 message arrives', async () => {
    const published: unknown[] = [];
    bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

    rpcClient.simulateMessage(makeEnvelope());

    // Give async processing a tick
    await new Promise((r) => setTimeout(r, 20));

    expect(published).toHaveLength(1);
    const event = published[0] as { type: string; payload: { channelId: string; senderId: string; content: string } };
    expect(event.type).toBe('inbound.message');
    expect(event.payload.channelId).toBe('signal');
    expect(event.payload.senderId).toBe('+14155551234');
    expect(event.payload.content).toBe('Hello Nathan');
  });

  it('sends a read receipt for a 1:1 message from a known (confirmed) sender', async () => {
    // resolveByChannelIdentity returns confirmed contact
    const confirmedService = makeMockContactService({ contactId: 'c1', status: 'confirmed' });
    const confirmedAdapter = new SignalAdapter({
      bus,
      logger,
      rpcClient,
      outboundGateway: gateway,
      contactService: confirmedService,
      phoneNumber: PHONE,
      ceoEmail: 'ceo@example.com',
    });
    await confirmedAdapter.start();

    rpcClient.simulateMessage(makeEnvelope());
    await new Promise((r) => setTimeout(r, 30));

    expect(rpcClient.sendReadReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        account: PHONE,
        recipient: '+14155551234',
        targetTimestamp: [1700000000000],
        receiptType: 'read',
      }),
    );

    await confirmedAdapter.stop();
  });

  it('does NOT send a read receipt for a provisional sender', async () => {
    // resolveByChannelIdentity returns provisional contact
    const provisionalService = makeMockContactService({ contactId: 'c2', status: 'provisional' });
    const provisionalAdapter = new SignalAdapter({
      bus,
      logger,
      rpcClient,
      outboundGateway: gateway,
      contactService: provisionalService,
      phoneNumber: PHONE,
      ceoEmail: 'ceo@example.com',
    });
    await provisionalAdapter.start();

    rpcClient.simulateMessage(makeEnvelope());
    await new Promise((r) => setTimeout(r, 30));

    expect(rpcClient.sendReadReceipt).not.toHaveBeenCalled();

    await provisionalAdapter.stop();
  });

  it('does NOT send a read receipt for a blocked sender', async () => {
    const blockedService = makeMockContactService({ contactId: 'c3', status: 'blocked' });
    const blockedAdapter = new SignalAdapter({
      bus,
      logger,
      rpcClient,
      outboundGateway: gateway,
      contactService: blockedService,
      phoneNumber: PHONE,
      ceoEmail: 'ceo@example.com',
    });
    await blockedAdapter.start();

    rpcClient.simulateMessage(makeEnvelope());
    await new Promise((r) => setTimeout(r, 30));

    expect(rpcClient.sendReadReceipt).not.toHaveBeenCalled();

    await blockedAdapter.stop();
  });

  it('does NOT send a read receipt for a group message even from a known sender', async () => {
    const confirmedService = makeMockContactService({ contactId: 'c4', status: 'confirmed' });
    const confirmedAdapter = new SignalAdapter({
      bus,
      logger,
      rpcClient,
      outboundGateway: gateway,
      contactService: confirmedService,
      phoneNumber: PHONE,
      ceoEmail: 'ceo@example.com',
    });
    await confirmedAdapter.start();

    const groupEnvelope = makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: 'Team standup?',
        expiresInSeconds: 0,
        viewOnce: false,
        groupInfo: { groupId: 'grp123==', type: 'DELIVER' },
      },
    });
    rpcClient.simulateMessage(groupEnvelope);
    await new Promise((r) => setTimeout(r, 30));

    expect(rpcClient.sendReadReceipt).not.toHaveBeenCalled();

    await confirmedAdapter.stop();
  });

  it('auto-creates a contact for an unknown sender', async () => {
    // null = not found
    const unknownService = makeMockContactService(null);
    const unknownAdapter = new SignalAdapter({
      bus,
      logger,
      rpcClient,
      outboundGateway: gateway,
      contactService: unknownService,
      phoneNumber: PHONE,
      ceoEmail: 'ceo@example.com',
    });
    await unknownAdapter.start();

    rpcClient.simulateMessage(makeEnvelope());
    await new Promise((r) => setTimeout(r, 30));

    expect(unknownService.createContact).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'signal_participant', status: 'provisional' }),
    );
    expect(unknownService.linkIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'signal', channelIdentifier: '+14155551234' }),
    );

    await unknownAdapter.stop();
  });

  it('ignores reaction envelopes (no publish)', async () => {
    const published: unknown[] = [];
    bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

    rpcClient.simulateMessage(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
        reaction: { emoji: '👍', targetAuthor: '+1', targetTimestamp: 0, isRemove: false },
      },
    }));
    await new Promise((r) => setTimeout(r, 20));

    expect(published).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  it('routes a 1:1 outbound.message with signal channelId through the gateway', async () => {
    const outboundEvent: OutboundMessageEvent = {
      id: 'evt-1',
      timestamp: new Date(),
      type: 'outbound.message',
      sourceLayer: 'dispatch',
      payload: {
        conversationId: 'signal:+14155551234',
        channelId: 'signal',
        content: 'Hello from Nathan',
      },
    };

    await bus.publish('dispatch', outboundEvent);
    await new Promise((r) => setTimeout(r, 20));

    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'signal',
        recipient: '+14155551234',
        message: 'Hello from Nathan',
      }),
    );
  });

  it('routes a group outbound.message through the gateway', async () => {
    const outboundEvent: OutboundMessageEvent = {
      id: 'evt-2',
      timestamp: new Date(),
      type: 'outbound.message',
      sourceLayer: 'dispatch',
      payload: {
        conversationId: 'signal:group=abc123==',
        channelId: 'signal',
        content: 'Group reply',
      },
    };

    await bus.publish('dispatch', outboundEvent);
    await new Promise((r) => setTimeout(r, 20));

    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'signal',
        groupId: 'abc123==',
        recipient: undefined,
        message: 'Group reply',
      }),
    );
  });

  it('ignores outbound.message events for other channels (e.g. email)', async () => {
    const outboundEvent: OutboundMessageEvent = {
      id: 'evt-3',
      timestamp: new Date(),
      type: 'outbound.message',
      sourceLayer: 'dispatch',
      payload: {
        conversationId: 'email:thread123',
        channelId: 'email',
        content: 'Email reply',
      },
    };

    await bus.publish('dispatch', outboundEvent);
    await new Promise((r) => setTimeout(r, 20));

    expect(gateway.send).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  it('calls rpcClient.connect() on start and disconnect() on stop', async () => {
    // adapter was already started in beforeEach
    expect(rpcClient.connect).toHaveBeenCalledTimes(1);

    await adapter.stop();
    expect(rpcClient.disconnect).toHaveBeenCalledTimes(1);

    // Re-start for afterEach cleanup
    await adapter.start();
  });

  // ---------------------------------------------------------------------------
  // Group trust check
  // ---------------------------------------------------------------------------

  function makeGroupEnvelope(groupId: string, overrides: Partial<SignalEnvelope> = {}): SignalEnvelope {
    return makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: 'Group message',
        expiresInSeconds: 0,
        viewOnce: false,
        groupInfo: { groupId, type: 'DELIVER' },
      },
      ...overrides,
    });
  }

  describe('Group trust check', () => {
    const GROUP_ID = 'grpABC==';

    it('publishes an inbound.message for a group with all verified members', async () => {
      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

      // rpcClient.listGroups returns this group with one member
      (rpcClient.listGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: GROUP_ID, name: 'G', members: [{ number: '+14155551234' }], pendingMembers: [], isMember: true },
      ]);
      // contactService resolves the member as active
      (contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(
        { contactId: 'c1', status: 'active' },
      );

      rpcClient.simulateMessage(makeGroupEnvelope(GROUP_ID));
      await new Promise((r) => setTimeout(r, 30));

      expect(published).toHaveLength(1);
    });

    it('holds a group message and emails the CEO when a member is unknown', async () => {
      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

      (rpcClient.listGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: GROUP_ID, name: 'G', members: [{ number: '+14155551234' }], pendingMembers: [], isMember: true },
      ]);
      // Member has no contact record
      (contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      rpcClient.simulateMessage(makeGroupEnvelope(GROUP_ID));
      await new Promise((r) => setTimeout(r, 30));

      expect(published).toHaveLength(0);
      expect(gateway.send).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'email',
          to: 'ceo@example.com',
          subject: 'Signal group message held — member verification needed',
        }),
      );
    });

    it('drops a group message silently when a member is blocked (no email, no publish)', async () => {
      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

      (rpcClient.listGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: GROUP_ID, name: 'G', members: [{ number: '+14155551234' }], pendingMembers: [], isMember: true },
      ]);
      (contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(
        { contactId: 'c1', status: 'blocked' },
      );

      rpcClient.simulateMessage(makeGroupEnvelope(GROUP_ID));
      await new Promise((r) => setTimeout(r, 30));

      expect(published).toHaveLength(0);
      expect(gateway.send).not.toHaveBeenCalled();
    });

    it('treats a group as untrusted when listGroups throws', async () => {
      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

      (rpcClient.listGroups as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('socket error'));

      rpcClient.simulateMessage(makeGroupEnvelope(GROUP_ID));
      await new Promise((r) => setTimeout(r, 30));

      expect(published).toHaveLength(0);
    });
  });
});
