import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { EventBus } from '../../../../src/bus/bus.js';
import { SlackAdapter } from '../../../../src/channels/slack/slack-adapter.js';
import type { SlackClient } from '../../../../src/channels/slack/slack-client.js';
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';
import type { SlackInboundEvent, SlackInboundKind } from '../../../../src/channels/slack/types.js';
import type { OutboundMessageEvent } from '../../../../src/bus/events.js';
import { createLogger } from '../../../../src/logger.js';
import pino from 'pino';
import { SpeechMediaService } from '../../../../src/speech/media-service.js';
import { FakeSttProvider } from '../../../../src/speech/fake-stt.js';
import { FakeTtsProvider } from '../../../../src/speech/fake-tts.js';
import { SttHttpError } from '../../../../src/speech/types.js';
import { TRANSCRIBED_FROM_AUDIO_TAG } from '../../../../src/channels/inbound-voice-note.js';

function makeSilentLogger() {
  return pino({ level: 'silent' });
}

function makeMockClient() {
  const emitter = new EventEmitter() as EventEmitter & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    getBotIdentity: ReturnType<typeof vi.fn>;
    lookupUser: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    downloadFile: ReturnType<typeof vi.fn>;
    simulateEvent: (event: SlackInboundEvent, kind: SlackInboundKind) => void;
  };
  emitter.connect = vi.fn().mockResolvedValue(undefined);
  emitter.disconnect = vi.fn().mockResolvedValue(undefined);
  emitter.getBotIdentity = vi.fn().mockReturnValue({ botUserId: 'U_BOT', botName: 'nathan' });
  emitter.lookupUser = vi.fn().mockResolvedValue({ id: 'U_ALICE', displayName: 'Alice' });
  emitter.postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '1.1' });
  emitter.downloadFile = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
  emitter.simulateEvent = (event, kind) => emitter.emit('event', event, kind);
  return emitter as unknown as SlackClient & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    getBotIdentity: ReturnType<typeof vi.fn>;
    lookupUser: ReturnType<typeof vi.fn>;
    simulateEvent: (event: SlackInboundEvent, kind: SlackInboundKind) => void;
    downloadFile: ReturnType<typeof vi.fn>;
  };
}

function makeMockGateway() {
  return {
    send: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as OutboundGateway;
}

function makeMockContactService(resolved: { contactId: string } | null = null) {
  return {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(resolved),
    ensureChannelContact: vi.fn().mockResolvedValue({
      contactId: resolved?.contactId ?? 'new-contact-id',
      tier: 'unknown',
      created: resolved == null,
    }),
    createContact: vi.fn().mockResolvedValue({ id: 'new-contact-id' }),
    linkIdentity: vi.fn().mockResolvedValue(undefined),
    deleteContact: vi.fn().mockResolvedValue(undefined),
  } as unknown as ContactService;
}

describe('SlackAdapter', () => {
  let bus: EventBus;
  let client: ReturnType<typeof makeMockClient>;
  let gateway: ReturnType<typeof makeMockGateway>;
  let contactService: ReturnType<typeof makeMockContactService>;
  let adapter: SlackAdapter;
  const logger = makeSilentLogger();

  beforeEach(async () => {
    bus = new EventBus(createLogger('error'));
    client = makeMockClient();
    gateway = makeMockGateway();
    contactService = makeMockContactService();
    adapter = new SlackAdapter({
      bus,
      logger,
      client,
      outboundGateway: gateway,
      contactService,
    });
    await adapter.start();
  });

  afterEach(async () => {
    await adapter.stop();
  });

  it('publishes inbound DM to the bus and auto-creates contact', async () => {
    const published: unknown[] = [];
    bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

    client.simulateEvent(
      {
        type: 'message',
        user: 'U_ALICE',
        text: 'Hello',
        channel: 'D123',
        ts: '1710000000.000100',
        channel_type: 'im',
      },
      'dm',
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(published).toHaveLength(1);
    const event = published[0] as { payload: { channelId: string; senderId: string; conversationId: string } };
    expect(event.payload.channelId).toBe('slack');
    expect(event.payload.senderId).toBe('U_ALICE');
    expect(event.payload.conversationId).toBe('slack:D123');
    expect(contactService.ensureChannelContact).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'slack',
        channelIdentifier: 'U_ALICE',
        source: 'slack_participant',
        displayName: 'Alice',
      }),
    );
  });

  it('routes outbound slack: conversation via gateway with slackUserId', async () => {
    const outbound: OutboundMessageEvent = {
      id: 'evt-1',
      timestamp: new Date(),
      type: 'outbound.message',
      sourceLayer: 'dispatch',
      payload: {
        conversationId: 'slack:C999:1710000000.000200',
        channelId: 'slack',
        content: 'On it',
        recipientId: 'U_ALICE',
      },
    };

    await bus.publish('dispatch', outbound);
    await new Promise((r) => setTimeout(r, 20));

    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'slack',
        slackChannelId: 'C999',
        threadTs: '1710000000.000200',
        message: 'On it',
        slackUserId: 'U_ALICE',
      }),
      expect.objectContaining({
        conversationId: 'slack:C999:1710000000.000200',
        parentEventId: 'evt-1',
      }),
    );
  });

  it('publishes inbound.reaction for reaction_added', async () => {
    const published: unknown[] = [];
    bus.subscribe('inbound.reaction', 'dispatch', (e) => { published.push(e); });

    client.simulateEvent(
      {
        type: 'reaction_added',
        user: 'U_ALICE',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C999', ts: '1710000000.000200' },
      },
      'reaction',
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(published).toHaveLength(1);
    const event = published[0] as {
      payload: { emoji: string; senderId: string; targetMessageId: string };
    };
    expect(event.payload.emoji).toBe('thumbsup');
    expect(event.payload.senderId).toBe('U_ALICE');
    expect(event.payload.targetMessageId).toBe('1710000000.000200');
  });

  it('ignores outbound for other channels', async () => {
    const outbound: OutboundMessageEvent = {
      id: 'evt-2',
      timestamp: new Date(),
      type: 'outbound.message',
      sourceLayer: 'dispatch',
      payload: {
        conversationId: 'signal:+1',
        channelId: 'signal',
        content: 'nope',
      },
    };
    await bus.publish('dispatch', outbound);
    await new Promise((r) => setTimeout(r, 20));
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it('drops @mentions outside the allowlist', async () => {
    await adapter.stop();
    adapter = new SlackAdapter({
      bus,
      logger,
      client,
      outboundGateway: gateway,
      contactService,
      allowedChannelIds: ['C_ALLOWED'],
    });
    await adapter.start();

    const published: unknown[] = [];
    bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

    client.simulateEvent(
      {
        type: 'app_mention',
        user: 'U_ALICE',
        text: '<@U_BOT> hi',
        channel: 'C_OTHER',
        ts: '1710000000.000200',
      },
      'mention',
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(published).toHaveLength(0);
  });

  describe('inbound voice notes (#1600)', () => {
    const AUDIO = new Uint8Array([4, 5, 6]);
    const FILE_URL = 'https://files.slack.com/files-pri/T1/F_VOICE/download';

    function makeVoiceDm() {
      return {
        type: 'message' as const,
        user: 'U_ALICE',
        text: '',
        channel: 'D123',
        ts: '1710000000.000900',
        channel_type: 'im',
        files: [{
          id: 'F_VOICE',
          mimetype: 'audio/webm',
          filetype: 'webm',
          url_private_download: FILE_URL,
        }],
      };
    }

    async function startWithSpeech(stt: FakeSttProvider): Promise<void> {
      await adapter.stop();
      adapter = new SlackAdapter({
        bus,
        logger,
        client,
        outboundGateway: gateway,
        contactService,
        speechMediaService: new SpeechMediaService({
          stt,
          tts: new FakeTtsProvider(),
          logger,
        }),
      });
      await adapter.start();
    }

    it('publishes a transcribed inbound message tagged transcribed-from-audio', async () => {
      const stt = new FakeSttProvider({ fileTranscript: { text: 'ship it' } });
      client.downloadFile.mockResolvedValue(AUDIO);
      await startWithSpeech(stt);

      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });
      client.simulateEvent(makeVoiceDm(), 'dm');
      await vi.waitFor(() => expect(published).toHaveLength(1));

      const event = published[0] as {
        payload: { content: string; metadata: Record<string, unknown> };
      };
      expect(event.payload.content).toBe(`${TRANSCRIBED_FROM_AUDIO_TAG}\nship it`);
      expect(event.payload.metadata.transcribedFromAudio).toBe(true);
      expect(stt.fileRequests[0]?.contentType).toBe('audio/webm');
      expect(stt.fileRequests[0]?.audio).toEqual(AUDIO);
      expect(client.downloadFile).toHaveBeenCalledWith(FILE_URL);
    });

    it('does not publish empty content when the transcript is empty', async () => {
      const stt = new FakeSttProvider({ fileTranscript: { text: '' } });
      client.downloadFile.mockResolvedValue(AUDIO);
      await startWithSpeech(stt);

      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });
      client.simulateEvent(makeVoiceDm(), 'dm');
      await vi.waitFor(() => expect(published).toHaveLength(1));

      const event = published[0] as { payload: { content: string } };
      expect(event.payload.content.length).toBeGreaterThan(0);
      expect(event.payload.content).toContain("couldn't make that out");
    });

    it('surfaces transcription error type and message instead of dropping', async () => {
      const stt = new FakeSttProvider({
        fileError: new SttHttpError(503, 'Deepgram STT request failed with HTTP 503'),
      });
      client.downloadFile.mockResolvedValue(AUDIO);
      await startWithSpeech(stt);

      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });
      client.simulateEvent(makeVoiceDm(), 'dm');
      await vi.waitFor(() => expect(published).toHaveLength(1));

      const event = published[0] as {
        payload: { content: string; metadata: Record<string, unknown> };
      };
      expect(event.payload.content).toContain('PROVIDER_ERROR');
      expect(event.payload.content).toContain('503');
      expect(event.payload.metadata.transcriptionError).toEqual(
        expect.objectContaining({ type: 'PROVIDER_ERROR', retryable: true }),
      );
    });

    it('degrades to existing text behavior when speechMediaService is unset', async () => {
      const published: unknown[] = [];
      bus.subscribe('inbound.message', 'dispatch', (e) => { published.push(e); });

      client.simulateEvent(
        {
          type: 'message',
          user: 'U_ALICE',
          text: 'Hello',
          channel: 'D123',
          ts: '1710000000.001000',
          channel_type: 'im',
        },
        'dm',
      );
      await vi.waitFor(() => expect(published).toHaveLength(1));
      expect((published[0] as { payload: { content: string } }).payload.content).toBe('Hello');
      expect(client.downloadFile).not.toHaveBeenCalled();

      published.length = 0;
      client.simulateEvent(makeVoiceDm(), 'dm');
      await new Promise((r) => setTimeout(r, 30));
      expect(published).toHaveLength(0);
      expect(client.downloadFile).not.toHaveBeenCalled();
    });
  });
});
