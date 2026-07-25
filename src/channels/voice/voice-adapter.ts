import { randomUUID } from 'node:crypto';
import type { EventBus } from '../../bus/bus.js';
import type { OutboundMessageEvent } from '../../bus/events.js';
import { createVoiceSessionEnded, createVoiceSessionStarted } from '../../bus/events.js';
import type { Logger } from '../../logger.js';
import type { Channel } from '../channel.js';
import type { VoiceSessionBridge, VoiceSessionCreateRequest, VoiceSessionCreateResult } from './session-bridge.js';
import type { VoiceSessionStore } from './session-store.js';
import type { VoiceRuntime } from './voice-runtime.js';
import { mintVoiceParticipantToken } from './livekit/token.js';

/** LiveKit identity for the server-side agent participant that VoiceRuntime joins as. */
const AGENT_IDENTITY = 'curia-agent';

export interface VoiceAdapterConfig {
  bus: EventBus;
  logger: Logger;
  sessionBridge: VoiceSessionBridge;
  sessionStore: VoiceSessionStore;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  voiceModel?: string;
  /** Live duplex runtime. When present, sessions run the STT→LLM→TTS cascade;
   *  when absent (e.g. missing streaming provider), sessions still mint tokens
   *  but no server-side turn loop runs. */
  voiceRuntime?: VoiceRuntime;
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
    if (this.config.voiceRuntime) {
      await this.config.voiceRuntime.endAllSessions('adapter_stop');
    }
    this.log.info('Voice adapter stopped');
  }

  /** Exposed so bootstrap can late-bind coordinator tools after agent registration. */
  getRuntime(): VoiceRuntime | undefined {
    return this.config.voiceRuntime;
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

    // Kick off the server-side duplex loop. Mint a separate agent token and start
    // the runtime WITHOUT awaiting its full lifetime — the HTTP response only needs
    // the principal token so the console can join. Failures are tracked by ending
    // the session (which publishes voice.session.ended) rather than blocking the caller.
    if (this.config.voiceRuntime) {
      const runtime = this.config.voiceRuntime;
      const agentToken = await mintVoiceParticipantToken(
        { apiKey: this.config.livekitApiKey, apiSecret: this.config.livekitApiSecret },
        { roomName, identity: AGENT_IDENTITY, name: 'Curia' },
      );
      void runtime
        .startSession({
          sessionId: session.id,
          conversationId: session.conversationId,
          roomName: session.livekitRoom,
          agentToken,
        })
        .catch(async err => {
          this.log.error({ err, sessionId: session.id }, 'Voice runtime failed to start session');
          await runtime.endSession(session.id, 'runtime_start_failed').catch(() => {});
        });
    }

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
    // When the runtime is present it owns teardown (transport/STT/TTS) and
    // publishes voice.session.ended exactly once (store.endSession dedupes).
    if (this.config.voiceRuntime) {
      const ended = await this.config.voiceRuntime.endSession(sessionId, 'console_hangup');
      if (!ended) {
        return { status: 404, body: { error: 'Voice session not found' } };
      }
      return {
        status: 200,
        body: { ok: true, sessionId: ended.id, conversationId: ended.conversationId },
      };
    }

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
