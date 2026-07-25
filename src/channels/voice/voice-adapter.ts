import { randomUUID } from 'node:crypto';
import type { EventBus } from '../../bus/bus.js';
import type { OutboundMessageEvent } from '../../bus/events.js';
import { createVoiceSessionEnded, createVoiceSessionStarted } from '../../bus/events.js';
import type { Logger } from '../../logger.js';
import type { Channel } from '../channel.js';
import type { VoiceSessionBridge, VoiceSessionCreateRequest, VoiceSessionCreateResult } from './session-bridge.js';
import type { VoiceSessionStore } from './session-store.js';
import { mintVoiceParticipantToken } from './livekit/token.js';

export interface VoiceAdapterConfig {
  bus: EventBus;
  logger: Logger;
  sessionBridge: VoiceSessionBridge;
  sessionStore: VoiceSessionStore;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  voiceModel?: string;
}

export class VoiceAdapter implements Channel {
  readonly name = 'voice';
  readonly isToggleable = true;
  private readonly log: Logger;

  constructor(private readonly config: VoiceAdapterConfig) {
    this.log = config.logger.child({ component: 'voice-adapter' });
  }

  async start(): Promise<void> {
    this.config.bus.subscribe('outbound.message', 'channel', async (event) => {
      const outbound = event as OutboundMessageEvent;
      if (outbound.payload.channelId !== 'voice') return;
      this.log.debug(
        { conversationId: outbound.payload.conversationId },
        'Voice outbound.message ignored; spoken egress is handled by VoiceRuntime',
      );
    });

    this.config.sessionBridge.setHandler({
      status: async () => ({ enabled: true }),
      createSession: (req) => this.createSession(req),
      endSession: (sessionId) => this.endSession(sessionId),
    });
    this.log.info({ hasVoiceModelOverride: this.config.voiceModel !== undefined }, 'Voice adapter started');
  }

  async stop(): Promise<void> {
    this.config.sessionBridge.setHandler(null);
    this.log.info('Voice adapter stopped');
  }

  private async createSession(req: VoiceSessionCreateRequest): Promise<VoiceSessionCreateResult> {
    const sessionId = randomUUID();
    const conversationId = `voice:${sessionId}`;
    const roomName = `voice-${sessionId}`;
    const token = await mintVoiceParticipantToken(
      {
        apiKey: this.config.livekitApiKey,
        apiSecret: this.config.livekitApiSecret,
      },
      {
        roomName,
        identity: 'principal',
        name: 'Principal',
      },
    );

    const session = await this.config.sessionStore.create({
      id: sessionId,
      conversationId,
      livekitRoom: roomName,
      principalContactId: req.principalContactId,
      metadata: req.metadata,
    });

    await this.config.bus.publish('channel', createVoiceSessionStarted({
      sessionId: session.id,
      conversationId: session.conversationId,
      livekitRoom: session.livekitRoom,
    }));

    return {
      status: 201,
      body: {
        sessionId: session.id,
        conversationId: session.conversationId,
        livekitUrl: this.config.livekitUrl,
        token,
        roomName: session.livekitRoom,
      },
    };
  }

  private async endSession(sessionId: string): Promise<VoiceSessionCreateResult> {
    const ended = await this.config.sessionStore.endSession(sessionId, 'console_hangup');
    if (!ended) {
      return { status: 404, body: { error: 'Voice session not found' } };
    }

    await this.config.bus.publish('channel', createVoiceSessionEnded({
      sessionId: ended.id,
      conversationId: ended.conversationId,
      reason: ended.endReason ?? 'console_hangup',
      durationMs: ended.endedAt ? ended.endedAt.getTime() - ended.startedAt.getTime() : undefined,
    }));

    return {
      status: 200,
      body: {
        ok: true,
        sessionId: ended.id,
        conversationId: ended.conversationId,
      },
    };
  }
}
