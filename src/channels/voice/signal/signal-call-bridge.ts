// signal-call-bridge.ts — the central state machine bridging Signal RingRTC
// voice calls (via SignalRpcClient's callEvent stream) to VoiceRuntime sessions
// (#1672).
//
// Policy: "answer everyone" — v1 admits both known contacts and unresolved
// strangers (unknown tier, liveTurn=false), rejecting only blocked contacts and
// callers with no stable identifier (uuid-only, no E.164 number). Exactly one
// call is ever active at a time; a second incoming call while one is active (or
// mid-accept) is rejected as busy.
//
// Two pieces of local state track this:
//   - `pending`: callId -> resolved caller, from RINGING_INCOMING (accepted) to
//     CONNECTED (promoted to `active`) or ENDED-before-connecting (discarded).
//   - `active`: the single in-progress call, from CONNECTED through ENDED /
//     duration cap / rpc disconnect / stop().
//
// callEvent arrives on an EventEmitter (SignalRpcClient) — an unhandled throw
// there would crash the process, so every handler is wrapped to catch and
// error-log rather than propagate.

import { randomUUID } from 'node:crypto';
import type { EventBus } from '../../../bus/bus.js';
import { createVoiceSessionStarted } from '../../../bus/events.js';
import type { ContactResolver } from '../../../contacts/contact-resolver.js';
import type { Logger } from '../../../logger.js';
import type { SignalCallEvent } from '../../signal/call-types.js';
import type { SignalRpcClient } from '../../signal/signal-rpc-client.js';
import type { AudioTransport } from '../audio-transport.js';
import type { VoiceCallerContext } from '../caller-context.js';
import { resolveSignalVoiceCaller } from '../caller-context.js';
import type { VoiceSessionStore } from '../session-store.js';
import type { VoiceRuntime } from '../voice-runtime.js';
import { SignalAudioTransport } from './signal-audio-transport.js';
import type { SignalAudioTransportOpts } from './signal-audio-transport.js';

/**
 * voice_sessions.principal_contact_id is UUID — only persist real contact ids.
 * Copied from voice-adapter.ts:15 (kept local rather than exported/shared —
 * this bridge is a separate call graph and the regex is two lines).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hard per-call duration cap default (seconds). v1 hard-stops with no spoken
 * wrap-up — see the enforceCap() doc comment below. */
const DEFAULT_MAX_CALL_SECONDS = 600;

export interface SignalCallBridgeConfig {
  bus: EventBus;
  logger: Logger;
  rpcClient: SignalRpcClient;
  contactResolver: ContactResolver;
  voiceRuntime: VoiceRuntime;
  sessionStore: VoiceSessionStore;
  pulseServer: string;
  /** Hard cap per call; default 600. */
  maxCallSeconds?: number;
  /** Injected for tests; defaults to (opts) => new SignalAudioTransport(opts). */
  createTransport?: (opts: SignalAudioTransportOpts) => AudioTransport & { notifyRemoteHangup(): void };
}

interface ActiveCall {
  callId: bigint;
  sessionId: string;
  transport: AudioTransport & { notifyRemoteHangup(): void };
  capTimer: NodeJS.Timeout | null;
  caller: VoiceCallerContext;
}

export class SignalCallBridge {
  private readonly log: Logger;
  private readonly maxCallSeconds: number;
  private readonly buildTransport: (opts: SignalAudioTransportOpts) => AudioTransport & { notifyRemoteHangup(): void };

  /** The single in-progress call (post-CONNECTED), or null between calls. */
  private active: ActiveCall | null = null;
  /** Accepted-but-not-yet-CONNECTED calls, keyed by callId. */
  private readonly pending = new Map<bigint, VoiceCallerContext>();

  private started = false;

  // Bound once so start()/stop() can add/remove the exact same listener
  // reference from the EventEmitter.
  private readonly onCallEvent = (ev: SignalCallEvent): void => {
    // callEvent handlers are async internally; wrap so a rejected promise
    // (or a synchronous throw before the first await) never becomes an
    // unhandled rejection / uncaught exception on the RPC client's emitter.
    this.handleCallEvent(ev).catch((err: unknown) => {
      this.log.error({ err, callId: ev.callId.toString() }, 'Unhandled error handling Signal call event');
    });
  };

  private readonly onDisconnected = (): void => {
    try {
      this.handleDisconnected();
    } catch (err) {
      this.log.error({ err }, 'Unhandled error handling Signal RPC disconnect');
    }
  };

  constructor(private readonly config: SignalCallBridgeConfig) {
    this.log = config.logger.child({ component: 'signal-call-bridge' });
    this.maxCallSeconds = config.maxCallSeconds ?? DEFAULT_MAX_CALL_SECONDS;
    this.buildTransport = config.createTransport ?? (opts => new SignalAudioTransport(opts));
  }

  /** Subscribe to call events. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.config.rpcClient.setCallEventsSubscription(true);
    this.config.rpcClient.on('callEvent', this.onCallEvent);
    this.config.rpcClient.on('disconnected', this.onDisconnected);
  }

  /** Unsubscribe and tear down any active session (best-effort). */
  async stop(): Promise<void> {
    this.config.rpcClient.off('callEvent', this.onCallEvent);
    this.config.rpcClient.off('disconnected', this.onDisconnected);
    this.config.rpcClient.setCallEventsSubscription(false);
    this.started = false;

    if (!this.active) return;
    const { callId, sessionId, capTimer } = this.active;
    if (capTimer) clearTimeout(capTimer);
    this.active = null;

    try {
      await this.config.rpcClient.hangupCall(callId);
    } catch (err) {
      this.log.error({ err, callId: callId.toString() }, 'stop(): hangupCall failed for the active Signal call');
    }
    try {
      await this.config.voiceRuntime.endSession(sessionId, 'adapter_stop');
    } catch (err) {
      this.log.error({ err, sessionId }, 'stop(): endSession failed for the active Signal call');
    }
  }

  private async handleCallEvent(ev: SignalCallEvent): Promise<void> {
    switch (ev.state) {
      case 'RINGING_INCOMING':
        await this.handleRingingIncoming(ev);
        return;
      case 'CONNECTED':
        await this.handleConnected(ev);
        return;
      case 'ENDED':
        await this.handleEnded(ev);
        return;
      default:
        // RINGING_OUTGOING / CONNECTING / RECONNECTING: no policy action for
        // v1 — the bridge only answers inbound calls, it never originates one.
        return;
    }
  }

  private async handleRingingIncoming(ev: SignalCallEvent): Promise<void> {
    // Only one call may be in flight at a time — a second ring while one is
    // active (or mid-accept, i.e. still pending) is rejected as busy.
    if (this.active !== null || this.pending.size > 0) {
      void this.config.rpcClient.rejectCall(ev.callId);
      this.log.info({ callId: ev.callId.toString(), reason: 'busy' }, 'Rejecting incoming Signal call');
      return;
    }

    const result = await resolveSignalVoiceCaller({
      contactResolver: this.config.contactResolver,
      callerNumber: ev.number,
      logger: this.log,
    });
    if (!result.ok) {
      void this.config.rpcClient.rejectCall(ev.callId);
      this.log.info({ callId: ev.callId.toString(), reason: result.reason }, 'Rejecting incoming Signal call');
      return;
    }

    this.pending.set(ev.callId, result.caller);
    try {
      await this.config.rpcClient.acceptCall(ev.callId);
    } catch (err) {
      this.log.error({ err, callId: ev.callId.toString() }, 'acceptCall failed for incoming Signal call');
      this.pending.delete(ev.callId);
    }
  }

  private async handleConnected(ev: SignalCallEvent): Promise<void> {
    const caller = this.pending.get(ev.callId);
    if (!caller) {
      // CONNECTED without a prior accept from us is a protocol surprise —
      // never start a session (and thus never answer) without having run it
      // through the answer policy above.
      this.log.warn({ callId: ev.callId.toString() }, 'CONNECTED for a Signal call with no pending accept — hanging up');
      void this.config.rpcClient.hangupCall(ev.callId);
      return;
    }
    this.pending.delete(ev.callId);

    if (!ev.inputDeviceName || !ev.outputDeviceName) {
      this.log.error({ callId: ev.callId.toString() }, 'CONNECTED missing PulseAudio device names — hanging up');
      void this.config.rpcClient.hangupCall(ev.callId);
      return;
    }

    const sessionId = randomUUID();
    const conversationId = `voice:${sessionId}`;
    const roomName = `signal-call:${ev.callId.toString()}`;

    const session = await this.config.sessionStore.create({
      id: sessionId,
      conversationId,
      livekitRoom: roomName,
      principalContactId: UUID_RE.test(caller.contactId) ? caller.contactId : undefined,
      metadata: {
        channel: 'signal',
        callerNumber: ev.number,
        callId: ev.callId.toString(),
        tier: caller.tier,
      },
    });

    await this.config.bus.publish('channel', createVoiceSessionStarted({
      sessionId: session.id,
      conversationId: session.conversationId,
      livekitRoom: session.livekitRoom,
    }));

    const transport = this.buildTransport({
      pulseServer: this.config.pulseServer,
      inputDeviceName: ev.inputDeviceName,
      outputDeviceName: ev.outputDeviceName,
      logger: this.log,
    });

    const capTimer = setTimeout(() => {
      void this.enforceCap();
    }, this.maxCallSeconds * 1000);

    this.active = { callId: ev.callId, sessionId, transport, capTimer, caller };

    try {
      await this.config.voiceRuntime.startSession({
        sessionId,
        conversationId,
        roomName,
        caller,
        transport,
        openingGreeting: true,
      });
    } catch (err) {
      this.log.error(
        { err, sessionId, callId: ev.callId.toString() },
        'VoiceRuntime failed to start a Signal call session — ending it',
      );
      // Mirrors voice-adapter.ts:158-168: the row (and pending capTimer) already
      // exist, so a start failure must be matched with a full teardown rather
      // than left dangling.
      if (this.active?.capTimer) clearTimeout(this.active.capTimer);
      this.active = null;
      try {
        await this.config.rpcClient.hangupCall(ev.callId);
      } catch (hangupErr) {
        this.log.error({ err: hangupErr, callId: ev.callId.toString() }, 'hangupCall failed after runtime start failure');
      }
      try {
        await this.config.voiceRuntime.endSession(sessionId, 'runtime_start_failed');
      } catch (endErr) {
        this.log.error({ err: endErr, sessionId }, 'endSession failed after runtime start failure');
      }
    }
  }

  private async handleEnded(ev: SignalCallEvent): Promise<void> {
    if (this.active && this.active.callId === ev.callId) {
      const { transport, sessionId, capTimer } = this.active;
      if (capTimer) clearTimeout(capTimer);
      // Drives the runtime's own teardown via AudioTransport.onClose.
      transport.notifyRemoteHangup();
      // Safety net: endSession is idempotent via the store's dedupe
      // (voice-runtime.ts:1197-1198 — endSession returns null once the row
      // is already 'ended'), so calling it here even though notifyRemoteHangup
      // should already trigger teardown costs nothing and covers a transport
      // that (for whatever reason) doesn't fire onClose.
      void this.config.voiceRuntime.endSession(sessionId, 'remote_hangup');
      this.active = null;
      return;
    }

    if (this.pending.delete(ev.callId)) {
      this.log.info({ callId: ev.callId.toString() }, 'Signal call ended before it connected');
    }
  }

  /**
   * v1 keeps the duration cap blunt — no spoken wrap-up before hangup. The
   * spec sketches a synthetic turn announcing the cap, but that requires
   * injecting a turn mid-session, which touches VoiceRuntime's turn loop.
   * Deferred as a fast-follow (#1672 checklist note); this hard-stops instead,
   * and the runtime's own teardown cancels any mid-turn speech.
   */
  private async enforceCap(): Promise<void> {
    if (!this.active) return;
    const { callId, sessionId } = this.active;
    this.log.info({ callId: callId.toString(), sessionId }, 'Signal call hit the max-duration cap; hanging up');
    void this.config.rpcClient.hangupCall(callId);
    void this.config.voiceRuntime.endSession(sessionId, 'max_duration');
    this.active = null;
  }

  private handleDisconnected(): void {
    if (!this.active) return;
    const { sessionId, capTimer } = this.active;
    if (capTimer) clearTimeout(capTimer);
    this.log.error({ sessionId }, 'Signal RPC socket disconnected mid-call; ending voice session');
    void this.config.voiceRuntime.endSession(sessionId, 'rpc_disconnected');
    this.active = null;
    // No need to touch `pending` here — reconnect is automatic (Task 2) and
    // any pending-but-not-yet-connected call's fate is decided by the next
    // callEvent (or simply times out on the signal-cli side); there is no
    // socket left to reject/hangup it over right now.
  }
}
