import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { EventBus } from '../../../../src/bus/bus.js';
import { SignalAdapter } from '../../../../src/channels/signal/signal-adapter.js';
import type { SignalRpcClient } from '../../../../src/channels/signal/signal-rpc-client.js';
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';
import type { SignalEnvelope } from '../../../../src/channels/signal/types.js';
import type { OutboundMessageEvent } from '../../../../src/bus/events.js';
import type { ContactTier } from '../../../../src/contacts/types.js';
import { createLogger } from '../../../../src/logger.js';
import pino from 'pino';
import { SpeechMediaService } from '../../../../src/speech/media-service.js';
import { FakeSttProvider } from '../../../../src/speech/fake-stt.js';
import { FakeTtsProvider } from '../../../../src/speech/fake-tts.js';
import { SttHttpError } from '../../../../src/speech/types.js';
import { TRANSCRIBED_FROM_AUDIO_TAG } from '../../../../src/channels/inbound-voice-note.js';

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
    getAttachment: ReturnType<typeof vi.fn>;
    // Helper to simulate an inbound message from signal-cli
    simulateMessage: (envelope: SignalEnvelope) => void;
  };

  // connect() is synchronous in the real implementation
  emitter.connect = vi.fn().mockReturnValue(undefined);
  emitter.disconnect = vi.fn().mockResolvedValue(undefined);
  emitter.send = vi.fn().mockResolvedValue(undefined);
  emitter.sendReadReceipt = vi.fn().mockResolvedValue(undefined);
  emitter.listGroups = vi.fn().mockResolvedValue([]);
  emitter.getAttachment = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
  emitter.simulateMessage = (envelope) => emitter.emit('message', envelope);

  return emitter as unknown as SignalRpcClient & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    sendReadReceipt: ReturnType<typeof vi.fn>;
    listGroups: ReturnType<typeof vi.fn>;
    getAttachment: ReturnType<typeof vi.fn>;
    simulateMessage: (envelope: SignalEnvelope) => void;
  };
}

function makeMockGateway() {
  return {
    send: vi.fn().mockResolvedValue({ success: true }),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    getSignalGroupMembers: vi.fn().mockRejectedValue(new Error('Signal client not configured')),
  } as unknown as OutboundGateway;
}

function makeMockContactService(resolved: { contactId: string; tier: ContactTier } | null = null) {
  return {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(resolved),
    ensureChannelContact: vi.fn().mockResolvedValue({
      contactId: resolved?.contactId ?? 'new-contact-id',
      tier: resolved?.tier ?? 'unknown',
      created: resolved == null,
    }),
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
      message: 'Hello there',
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
    expect(event.payload.content).toBe('Hello there');
  });

  it('sends a read receipt for a 1:1 message from a known (confirmed) sender', async () => {
    // resolveByChannelIdentity returns confirmed contact
    const confirmedService = makeMockContactService({ contactId: 'c1', tier: 'known' });
    const confirmedAdapter = new SignalAdapter({
      bus,
      logger,
      rpcClient,
      outboundGateway: gateway,
      contactService: confirmedService,
      phoneNumber: PHONE,
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
    // resolveByChannelIdentity returns tier='unknown' (was: provisional) contact
    const provisionalService = makeMockContactService({ contactId: 'c2', tier: 'unknown' });
    const provisionalAdapter = new SignalAdapter({
      bus,
      logger,
      rpcClient,
      outboundGateway: gateway,
      contactService: provisionalService,
      phoneNumber: PHONE,
    });
    await provisionalAdapter.start();

    rpcClient.simulateMessage(makeEnvelope());
    await new Promise((r) => setTimeout(r, 30));

    expect(rpcClient.sendReadReceipt).not.toHaveBeenCalled();

    await provisionalAdapter.stop();
  });

  it('does NOT send a read receipt for a blocked sender', async () => {
    const blockedService = makeMockContactService({ contactId: 'c3', tier: 'blocked' });
    const blockedAdapter = new SignalAdapter({
      bus,
      logger,
      rpcClient,
      outboundGateway: gateway,
      contactService: blockedService,
      phoneNumber: PHONE,
    });
    await blockedAdapter.start();

    rpcClient.simulateMessage(makeEnvelope());
    await new Promise((r) => setTimeout(r, 30));

    expect(rpcClient.sendReadReceipt).not.toHaveBeenCalled();

    await blockedAdapter.stop();
  });

  it('does NOT send a read receipt for a group message even from a known sender', async () => {
    const confirmedService = makeMockContactService({ contactId: 'c4', tier: 'known' });
    const confirmedAdapter = new SignalAdapter({
      bus,
      logger,
      rpcClient,
      outboundGateway: gateway,
      contactService: confirmedService,
      phoneNumber: PHONE,
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
    });
    await unknownAdapter.start();

    rpcClient.simulateMessage(makeEnvelope());
    await new Promise((r) => setTimeout(r, 30));

    expect(unknownService.ensureChannelContact).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'signal',
        channelIdentifier: '+14155551234',
        source: 'signal_participant',
        tier: 'unknown',
      }),
    );

    await unknownAdapter.stop();
  });

  it('publishes inbound.reaction for reaction envelopes', async () => {
    const published: unknown[] = [];
    bus.subscribe('inbound.reaction', 'dispatch', (e) => { published.push(e); });
    bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

    rpcClient.simulateMessage(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
        reaction: {
          emoji: '👍',
          targetAuthor: '+14155559999',
          targetTimestamp: 1699999999999,
          isRemove: false,
        },
      },
    }));
    await new Promise((r) => setTimeout(r, 20));

    expect(published).toHaveLength(1);
    const event = published[0] as {
      type: string;
      payload: { emoji: string; senderId: string; targetMessageId: string; metadata?: { isRemove?: boolean } };
    };
    expect(event.type).toBe('inbound.reaction');
    expect(event.payload.emoji).toBe('👍');
    expect(event.payload.senderId).toBe('+14155551234');
    expect(event.payload.targetMessageId).toBe('1699999999999');
    expect(event.payload.metadata?.isRemove).toBe(false);
  });

  it('publishes isRemove reactions without mapping intent', async () => {
    const published: unknown[] = [];
    bus.subscribe('inbound.reaction', 'dispatch', (e) => { published.push(e); });

    rpcClient.simulateMessage(makeEnvelope({
      dataMessage: {
        timestamp: 1700000000000,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
        reaction: {
          emoji: '👍',
          targetAuthor: '+14155559999',
          targetTimestamp: 1699999999999,
          isRemove: true,
        },
      },
    }));
    await new Promise((r) => setTimeout(r, 20));

    expect(published).toHaveLength(1);
    const event = published[0] as { payload: { metadata?: { isRemove?: boolean } } };
    expect(event.payload.metadata?.isRemove).toBe(true);
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
        content: 'Hello from the agent',
      },
    };

    await bus.publish('dispatch', outboundEvent);
    await new Promise((r) => setTimeout(r, 20));

    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'signal',
        recipient: '+14155551234',
        message: 'Hello from the agent',
      }),
      expect.objectContaining({
        conversationId: 'signal:+14155551234',
        parentEventId: 'evt-1',
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
      expect.objectContaining({
        conversationId: 'signal:group=abc123==',
        parentEventId: 'evt-2',
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
      // contactService resolves the member as confirmed (trusted)
      (contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(
        { contactId: 'c1', tier: 'known' as ContactTier },
      );

      rpcClient.simulateMessage(makeGroupEnvelope(GROUP_ID));
      await new Promise((r) => setTimeout(r, 30));

      expect(published).toHaveLength(1);
    });

    it('routes a group message to coordinator in low-trust mode when a member is unknown', async () => {
      // Unknown-tier group members no longer cause the message to be held.
      // The adapter auto-creates tier='unknown' contacts and publishes the message.
      // The runtime injects a LOW-TRUST SENDER block to constrain coordinator behavior.
      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

      (rpcClient.listGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: GROUP_ID, name: 'G', members: [{ number: '+14155551234' }], pendingMembers: [], isMember: true },
      ]);
      // Member has no contact record — unknown sender
      (contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      rpcClient.simulateMessage(makeGroupEnvelope(GROUP_ID));
      await new Promise((r) => setTimeout(r, 30));

      // Message should be published (not held)
      expect(published).toHaveLength(1);
      // Auto-create contact for the unknown member at tier='unknown'
      expect(contactService.ensureChannelContact).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'signal',
          channelIdentifier: '+14155551234',
          source: 'signal_participant',
          tier: 'unknown',
        }),
      );
      // No hold notification sent
      expect(gateway.sendNotification).not.toHaveBeenCalled();
    });

    it('drops a group message silently when a member is blocked (no email, no publish)', async () => {
      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

      (rpcClient.listGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: GROUP_ID, name: 'G', members: [{ number: '+14155551234' }], pendingMembers: [], isMember: true },
      ]);
      (contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(
        { contactId: 'c1', tier: 'blocked' as ContactTier },
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

  describe('inbound voice notes (#1600)', () => {
    const AUDIO = new Uint8Array([9, 8, 7, 6]);

    function makeVoiceEnvelope() {
      return makeEnvelope({
        dataMessage: {
          timestamp: 1700000000000,
          message: null,
          expiresInSeconds: 0,
          viewOnce: false,
          attachments: [{
            id: 'att-voice',
            contentType: 'audio/ogg',
            filename: 'voice.ogg',
            size: 4,
            isVoiceNote: true,
          }],
        },
      });
    }

    async function startWithSpeech(stt: FakeSttProvider, contact = makeMockContactService({ contactId: 'c1', tier: 'known' })): Promise<SignalAdapter> {
      await adapter.stop();
      contactService = contact;
      const speech = new SpeechMediaService({
        stt,
        tts: new FakeTtsProvider(),
        logger,
      });
      adapter = new SignalAdapter({
        bus,
        logger,
        rpcClient,
        outboundGateway: gateway,
        contactService,
        phoneNumber: PHONE,
        speechMediaService: speech,
      });
      await adapter.start();
      return adapter;
    }

    it('publishes a transcribed inbound message tagged transcribed-from-audio', async () => {
      const stt = new FakeSttProvider({ fileTranscript: { text: 'lunch tomorrow?' } });
      rpcClient.getAttachment.mockResolvedValue(AUDIO);
      await startWithSpeech(stt);

      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });
      rpcClient.simulateMessage(makeVoiceEnvelope());
      await vi.waitFor(() => expect(published).toHaveLength(1));

      const event = published[0] as {
        payload: { content: string; metadata: Record<string, unknown> };
      };
      expect(event.payload.content).toBe(`${TRANSCRIBED_FROM_AUDIO_TAG}\nlunch tomorrow?`);
      expect(event.payload.metadata.transcribedFromAudio).toBe(true);
      expect(stt.fileRequests[0]?.contentType).toBe('audio/ogg');
      expect(stt.fileRequests[0]?.audio).toEqual(AUDIO);
      expect(rpcClient.getAttachment).toHaveBeenCalledWith({
        id: 'att-voice',
        recipient: '+14155551234',
        groupId: undefined,
      });
    });

    it('does not publish empty content when the transcript is empty', async () => {
      const stt = new FakeSttProvider({ fileTranscript: { text: '' } });
      rpcClient.getAttachment.mockResolvedValue(AUDIO);
      await startWithSpeech(stt);

      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });
      rpcClient.simulateMessage(makeVoiceEnvelope());
      await vi.waitFor(() => expect(published).toHaveLength(1));

      const event = published[0] as { payload: { content: string } };
      expect(event.payload.content.length).toBeGreaterThan(0);
      expect(event.payload.content).not.toBe('');
      expect(event.payload.content).toContain("couldn't make that out");
    });

    it('surfaces transcription failure in metadata with a user-safe body', async () => {
      const stt = new FakeSttProvider({
        fileError: new SttHttpError(401, 'Deepgram STT request failed with HTTP 401'),
      });
      rpcClient.getAttachment.mockResolvedValue(AUDIO);
      await startWithSpeech(stt);

      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });
      rpcClient.simulateMessage(makeVoiceEnvelope());
      await vi.waitFor(() => expect(published).toHaveLength(1));

      const event = published[0] as {
        payload: { content: string; metadata: Record<string, unknown> };
      };
      expect(event.payload.content).toContain("couldn't process that voice note");
      expect(event.payload.content).not.toContain('AUTH_FAILURE');
      expect(event.payload.content).not.toContain('Deepgram');
      expect(event.payload.metadata.transcriptionError).toEqual(
        expect.objectContaining({ type: 'AUTH_FAILURE', retryable: false }),
      );
    });

    it('does not download or transcribe voice notes from unknown 1:1 senders', async () => {
      const stt = new FakeSttProvider({ fileTranscript: { text: 'secret' } });
      await startWithSpeech(stt, makeMockContactService()); // unknown tier

      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });
      rpcClient.simulateMessage(makeVoiceEnvelope());
      await new Promise((r) => setTimeout(r, 30));
      expect(published).toHaveLength(0);
      expect(rpcClient.getAttachment).not.toHaveBeenCalled();
      expect(stt.fileRequests).toHaveLength(0);
    });

    it('rejects oversized voice notes before getAttachment', async () => {
      const stt = new FakeSttProvider({ fileTranscript: { text: 'nope' } });
      await startWithSpeech(stt);

      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });
      rpcClient.simulateMessage(makeEnvelope({
        dataMessage: {
          timestamp: 1700000000000,
          message: null,
          expiresInSeconds: 0,
          viewOnce: false,
          attachments: [{
            id: 'att-huge',
            contentType: 'audio/ogg',
            size: 6 * 1024 * 1024,
            isVoiceNote: true,
          }],
        },
      }));
      await vi.waitFor(() => expect(published).toHaveLength(1));
      const event = published[0] as {
        payload: { content: string; metadata: Record<string, unknown> };
      };
      expect(event.payload.content).toContain('voice note too long to transcribe');
      expect(rpcClient.getAttachment).not.toHaveBeenCalled();
      expect(event.payload.metadata.transcriptionError).toEqual(
        expect.objectContaining({ type: 'VALIDATION_ERROR', retryable: false }),
      );
    });

    it('falls back to sourceUuid when sourceNumber is empty', async () => {
      const stt = new FakeSttProvider({ fileTranscript: { text: 'aci sender' } });
      rpcClient.getAttachment.mockResolvedValue(AUDIO);
      await startWithSpeech(stt);

      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });
      rpcClient.simulateMessage(makeEnvelope({
        source: '',
        sourceNumber: '',
        sourceUuid: 'aci-uuid-1',
        dataMessage: {
          timestamp: 1700000000000,
          message: null,
          expiresInSeconds: 0,
          viewOnce: false,
          attachments: [{
            id: 'att-voice',
            contentType: 'audio/ogg',
            size: 4,
            isVoiceNote: true,
          }],
        },
      }));
      await vi.waitFor(() => expect(published).toHaveLength(1));
      expect(rpcClient.getAttachment).toHaveBeenCalledWith({
        id: 'att-voice',
        recipient: 'aci-uuid-1',
        groupId: undefined,
      });
    });

    it('notes when a second voice note is not transcribed', async () => {
      const stt = new FakeSttProvider({ fileTranscript: { text: 'first' } });
      rpcClient.getAttachment.mockResolvedValue(AUDIO);
      await startWithSpeech(stt);

      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });
      rpcClient.simulateMessage(makeEnvelope({
        dataMessage: {
          timestamp: 1700000000000,
          message: null,
          expiresInSeconds: 0,
          viewOnce: false,
          attachments: [
            { id: 'att-1', contentType: 'audio/ogg', size: 4, isVoiceNote: true },
            { id: 'att-2', contentType: 'audio/ogg', size: 4, isVoiceNote: true },
          ],
        },
      }));
      await vi.waitFor(() => expect(published).toHaveLength(1));
      const event = published[0] as { payload: { content: string } };
      expect(event.payload.content).toContain('first');
      expect(event.payload.content).toContain('1 more voice note not transcribed');
    });

    it('degrades to existing text behavior when speechMediaService is unset', async () => {
      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

      rpcClient.simulateMessage(makeEnvelope());
      await vi.waitFor(() => expect(published).toHaveLength(1));
      expect((published[0] as { payload: { content: string } }).payload.content).toBe('Hello there');
      expect(rpcClient.getAttachment).not.toHaveBeenCalled();

      published.length = 0;
      rpcClient.simulateMessage(makeVoiceEnvelope());
      await new Promise((r) => setTimeout(r, 30));
      expect(published).toHaveLength(0);
      expect(rpcClient.getAttachment).not.toHaveBeenCalled();
    });
  });
});
