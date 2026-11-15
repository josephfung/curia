import { randomUUID } from 'node:crypto';
import type { EventBus } from '../../bus/bus.js';
import type { OutboundMessageEvent } from '../../bus/events.js';
import { createVoiceSessionEnded, createVoiceSessionStarted } from '../../bus/events.js';
import type { Logger } from '../../logger.js';
import type { AgendaStore } from '../../meetings/agenda-store.js';
import {
  prepareCallAgendas,
  releaseUnstartedPreload,
  withAgendaMetadata,
} from '../../meetings/session-agendas.js';
import type { Channel } from '../channel.js';
import { persistableCallerContactId } from './caller-contact-id.js';
import { mintVoiceParticipantToken } from './livekit/token.js';
import type { VoiceSessionBridge, VoiceSessionCreateRequest, VoiceSessionCreateResult } from './session-bridge.js';
import type { VoiceSessionStore } from './session-store.js';
import type { VoiceRuntime } from './voice-runtime.js';

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
  /** Live duplex runtime. Required for usable sessions; createSession fails closed without it. */
  voiceRuntime?: VoiceRuntime;
  /**
   * Parked agendas (#2322). With a store, a principal call starts from its due
   * agenda exactly like a Signal call (#2359). Without one, sessions start
   * free-form and the row metadata is untouched.
   */
  agendaStore?: AgendaStore;
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
    // 'principal') so a future non-principal transport cannot inherit principal standing
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

    // Prepare before the row exists so the lock records this session id; the
    // same shared path the Signal bridge uses (#2359). Non-principal callers get
    // null and the store is never touched. A store failure yields empty agendas
    // and the call still starts free-form.
    const prepared = await prepareCallAgendas(this.config.agendaStore, {
      callerSystemRole: caller.systemRole,
      sessionId,
      now: new Date(),
      logger: this.log,
    });

    let session: Awaited<ReturnType<VoiceSessionStore['create']>>;
    try {
      session = await this.config.sessionStore.create({
        id: sessionId,
        conversationId,
        livekitRoom: roomName,
        callerContactId: persistableCallerContactId(caller.contactId),
        metadata: withAgendaMetadata(req.metadata, prepared),
      });
    } catch (err) {
      // No row means no session-ended event to settle the lock; release it so
      // the principal's next call can still see the agenda. Then let the route
      // answer 500 as before.
      await releaseUnstartedPreload(this.config.agendaStore, prepared, sessionId, this.log);
      throw err;
    }

    try {
      await this.config.bus.publish('channel', createVoiceSessionStarted({
        sessionId: session.id,
        conversationId: session.conversationId,
        livekitRoom: session.livekitRoom,
      }));
    } catch (err) {
      // The row exists but nothing will end it, and with a preload locked the
      // principal's agenda would stay in_call (hidden from every later call)
      // until a restart. Release the lock directly first: the bus just failed,
      // so the ended event runtime.endSession publishes may never reach the
      // minutes pipeline. Then end the row, matching the agent-token path below.
      this.log.error({ err, sessionId: session.id }, 'Failed to publish voice.session.started; ending voice session');
      await releaseUnstartedPreload(this.config.agendaStore, prepared, session.id, this.log);
      try {
        await runtime.endSession(session.id, 'runtime_start_failed');
      } catch (cleanupErr) {
        this.log.error(
          { err: cleanupErr, sessionId: session.id },
          'Voice session teardown after started-publish failure also failed',
        );
      }
      return { status: 500, body: { error: 'Failed to start voice session' } };
    }

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
        // so Curia does not talk over the principal answering (#1596).
        openingGreeting: true,
        ...(prepared ? { agendas: prepared.agendas } : {}),
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
