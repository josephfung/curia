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
/** voice_sessions.principal_contact_id is UUID — only persist real contact ids. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VoiceAdapterConfig {
  bus: EventBus;
  logger: Logger;
  sessionBridge: VoiceSessionBridge;
  sessionStore: VoiceSessionStore;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  voiceModel?: string;
  /** Live duplex runtime. Required for usable sessions; createSession fails closed without it. */
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
    const runtime = this.config.voiceRuntime;
    if (!runtime) {
      // Fail closed before persisting a row or minting a principal JWT — without
      // a streaming runtime the console would join a silent room.
      return {
        status: 503,
        body: { error: 'Voice runtime is unavailable (streaming LLM provider required)' },
      };
    }

    const sessionId = randomUUID();
    const conversationId = `voice:${sessionId}`;
    const roomName = `voice-${sessionId}`;
    const { caller } = req;
    // LiveKit participant identity is the resolved contact id (not the literal
    // 'principal') so a future non-principal transport cannot inherit CEO standing
    // at the media layer (#1598).
    const token = await mintVoiceParticipantToken(
      {
        apiKey: this.config.livekitApiKey,
        apiSecret: this.config.livekitApiSecret,
      },
      {
        roomName,
        identity: caller.contactId,
        name: caller.displayName || (caller.liveTurn ? 'Principal' : 'Caller'),
      },
    );

    // voice_sessions.principal_contact_id is UUID NULL ON DELETE SET NULL — only store
    // a real contact UUID (synthetic 'primary-user' stays null).
    const principalContactId = UUID_RE.test(caller.contactId) ? caller.contactId : undefined;

    const session = await this.config.sessionStore.create({
      id: sessionId,
      conversationId,
      livekitRoom: roomName,
      principalContactId,
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
    //
    // The row is already persisted and voice.session.started is on the bus, so a
    // throw here (e.g. JWT signing failure) must be matched with an end — otherwise
    // the session sits in 'starting' with no closing event. Reuse runtime.endSession
    // (same teardown path as the startSession failure below); with the session not
    // yet in the runtime map it just transitions the row and publishes ended.
    let agentToken: string;
    try {
      agentToken = await mintVoiceParticipantToken(
        { apiKey: this.config.livekitApiKey, apiSecret: this.config.livekitApiSecret },
        { roomName, identity: AGENT_IDENTITY, name: 'Curia' },
      );
    } catch (err) {
      this.log.error({ err, sessionId: session.id }, 'Failed to mint agent token; ending voice session');
      try {
        await runtime.endSession(session.id, 'runtime_start_failed');
      } catch (cleanupErr) {
        this.log.error(
          { err: cleanupErr, sessionId: session.id },
          'Voice session teardown after agent-token failure also failed',
        );
      }
      return { status: 500, body: { error: 'Failed to start voice session' } };
    }
    void runtime
      .startSession({
        sessionId: session.id,
        conversationId: session.conversationId,
        roomName: session.livekitRoom,
        agentToken,
        caller,
        // Console POST /api/voice/sessions is always principal-initiated inbound.
        // A future Curia-initiated outbound path must pass openingGreeting: false
        // so Curia does not talk over the CEO answering (#1596).
        openingGreeting: true,
      })
      .catch(async err => {
        this.log.error({ err, sessionId: session.id }, 'Voice runtime failed to start session');
        try {
          await runtime.endSession(session.id, 'runtime_start_failed');
        } catch (cleanupErr) {
          this.log.error(
            { err: cleanupErr, sessionId: session.id },
            'Voice runtime teardown after start failure also failed',
          );
        }
      });

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
