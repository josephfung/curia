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
import type { ResolveSignalVoiceCallerResult } from '../caller-context.js';
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

/**
 * Backstop lifetime for an accepted-but-not-yet-CONNECTED call. Normally the
 * terminal event (CONNECTED or ENDED) clears the pending entry well within
 * signal-cli's own ~60s ring timeout. If that event is never delivered while
 * the socket stays up (a lost notification, an upstream bug), the entry would
 * otherwise linger forever and the busy check would reject every future call
 * until a process restart. This timer is the last unbounded-wait backstop —
 * on expiry it drops the entry, logs, and hangs the call up. Set beyond the
 * ring timeout so it only fires when signal-cli genuinely failed to report.
 */
const PENDING_CALL_TIMEOUT_MS = 90_000;

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
  /** Accepted-but-not-yet-CONNECTED calls, keyed by callId. Mutate ONLY via
   * setPending()/clearPending() so the parallel expiry timers stay in sync. */
  private readonly pending = new Map<bigint, VoiceCallerContext>();
  /** Per-pending expiry timers (PENDING_CALL_TIMEOUT_MS backstop), keyed by
   * callId. Kept parallel to `pending`; both helpers below maintain the pair. */
  private readonly pendingTimers = new Map<bigint, NodeJS.Timeout>();
  /**
   * callIds whose RINGING_INCOMING handler is between the busy check and
   * `pending.set(...)` — i.e. still awaiting resolveSignalVoiceCaller. The
   * pending reservation only happens AFTER that await, so without this set
   * two RINGING_INCOMING events for different callIds landing in the same
   * synchronous burst (both before either await resolves) would both pass
   * the busy check and both get accepted. Reserved synchronously before the
   * first await; cleared in a finally once the handler exits (however it
   * exits — busy-check never applies to entries already here, since they're
   * added only after passing it once).
   */
  private readonly ringing = new Set<bigint>();
  /**
   * Reentrance guard for handleConnected's setup sequence. The active-callId
   * short-circuit only protects once `active` is assigned, and pending.delete
   * is deferred until then — so two CONNECTED events for the same callId
   * arriving before the first handler's first await resolves (fast
   * CONNECTED→RECONNECTING→CONNECTED flap, or duplicate delivery) would both
   * run the full setup: two session rows and an orphaned transport for one
   * call. Entries live only for the duration of one setup (cleared in its
   * finally). Deliberately NOT part of the busy check — `pending` already
   * covers the whole setup window there.
   */
  private readonly connecting = new Set<bigint>();
  /**
   * callIds whose ENDED arrived while their setup was still in flight (in
   * `connecting`). handleConnected re-checks this after its awaits and aborts
   * instead of starting a session for a call that already hung up.
   */
  private readonly endedDuringSetup = new Set<bigint>();

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

  /**
   * Attach a rejection handler to a fire-and-forget promise. Every detached
   * `rejectCall`/`hangupCall`/`endSession` in this class is best-effort, but a
   * bare `void promise` would turn a rejection into an unhandled rejection and
   * terminate the process — the outer handler wrappers don't cover promises
   * that were deliberately not awaited. Route all of them through this.
   */
  private fireAndLog(promise: Promise<unknown>, what: string, callId?: bigint): void {
    promise.catch((err: unknown) => {
      this.log.warn(
        { err, what, ...(callId !== undefined ? { callId: callId.toString() } : {}) },
        'Best-effort Signal call operation failed',
      );
    });
  }

  /**
   * Record an accepted call as pending and arm its expiry backstop. All
   * pending insertions go through here so no entry can exist without a timer.
   */
  private setPending(callId: bigint, caller: VoiceCallerContext): void {
    this.pending.set(callId, caller);
    const timer = setTimeout(() => {
      // Only reachable if the terminal event never arrived — every normal
      // removal path calls clearPending(), which cancels this timer first.
      this.pendingTimers.delete(callId);
      if (this.pending.delete(callId)) {
        this.log.warn(
          { callId: callId.toString() },
          'Accepted Signal call never reached CONNECTED/ENDED within the backstop; dropping it and hanging up',
        );
        this.fireAndLog(this.config.rpcClient.hangupCall(callId), 'hangupCall(pending_timeout)', callId);
      }
    }, PENDING_CALL_TIMEOUT_MS);
    this.pendingTimers.set(callId, timer);
  }

  /**
   * Remove a pending entry and cancel its expiry timer. Returns whether an
   * entry existed (mirrors Map.delete's boolean, which handleEnded relies on).
   */
  private clearPending(callId: bigint): boolean {
    const timer = this.pendingTimers.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(callId);
    }
    return this.pending.delete(callId);
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

    // Drop any accepted-but-not-connected calls and cancel their backstop
    // timers so none fire after shutdown. (Best-effort hangup mirrors the
    // active-call teardown below.)
    for (const callId of [...this.pending.keys()]) {
      this.clearPending(callId);
      this.fireAndLog(this.config.rpcClient.hangupCall(callId), 'hangupCall(stop)', callId);
    }

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
    // A repeat RINGING_INCOMING for a call we are ALREADY handling is a
    // duplicate event, not a competing call. signal-cli re-emits RINGING while
    // the call rings (observed live 2026-08-20: the second event for the very
    // first call tripped the busy check below and rejected the very call we
    // were answering, so no call could ever connect). Ignore it — the original
    // handler is still driving this callId through accept → CONNECTED. Checked
    // against all three in-flight slots plus `connecting` (the CONNECTED-setup
    // window, during which the id may briefly sit in none of the other three).
    if (
      this.active?.callId === ev.callId ||
      this.pending.has(ev.callId) ||
      this.ringing.has(ev.callId) ||
      this.connecting.has(ev.callId)
    ) {
      this.log.debug(
        { callId: ev.callId.toString() },
        'Duplicate RINGING_INCOMING for a call already in flight; ignoring',
      );
      return;
    }

    // Only one call may be in flight at a time — a ring for a DIFFERENT callId
    // while one is active (or mid-accept, i.e. still pending, or still
    // resolving caller identity) is rejected as busy.
    if (this.active !== null || this.pending.size > 0 || this.ringing.size > 0) {
      this.fireAndLog(this.config.rpcClient.rejectCall(ev.callId), 'rejectCall', ev.callId);
      this.log.info({ callId: ev.callId.toString(), reason: 'busy' }, 'Rejecting incoming Signal call');
      return;
    }

    // Reserve the ringing slot synchronously, before the first await, so a
    // second RINGING_INCOMING for a different callId in the same
    // synchronous burst sees a non-empty `ringing` set above and is
    // busy-rejected too (see the field comment).
    this.ringing.add(ev.callId);
    try {
      let result: ResolveSignalVoiceCallerResult;
      try {
        result = await resolveSignalVoiceCaller({
          contactResolver: this.config.contactResolver,
          callerNumber: ev.number,
          logger: this.log,
        });
      } catch (err) {
        // A DB blip (or any other throw) mid-resolution must not leave the
        // call in limbo — reject it explicitly. Left unguarded, this would
        // bubble to onCallEvent's outer catch-all, which only error-logs;
        // no rejectCall would ever be sent and the caller would just hang.
        this.log.error(
          { err, callId: ev.callId.toString() },
          'Caller resolution threw for an incoming Signal call — rejecting',
        );
        this.fireAndLog(this.config.rpcClient.rejectCall(ev.callId), 'rejectCall', ev.callId);
        return;
      }
      if (!result.ok) {
        this.fireAndLog(this.config.rpcClient.rejectCall(ev.callId), 'rejectCall', ev.callId);
        this.log.info({ callId: ev.callId.toString(), reason: result.reason }, 'Rejecting incoming Signal call');
        return;
      }

      this.setPending(ev.callId, result.caller);
      try {
        await this.config.rpcClient.acceptCall(ev.callId);
      } catch (err) {
        this.log.error({ err, callId: ev.callId.toString() }, 'acceptCall failed for incoming Signal call');
        this.clearPending(ev.callId);
        // Mirror the other rejection paths above: acceptCall failing leaves
        // signal-cli's own call state indeterminate from our side, so send
        // an explicit reject rather than silently dropping it.
        this.fireAndLog(this.config.rpcClient.rejectCall(ev.callId), 'rejectCall', ev.callId);
      }
    } finally {
      this.ringing.delete(ev.callId);
    }
  }

  private async handleConnected(ev: SignalCallEvent): Promise<void> {
    // Redundant CONNECTED for the already-active call: after a mid-call
    // network blip RingRTC recovers via RECONNECTING → CONNECTED for the SAME
    // live callId. That is not a protocol surprise — treating it as one (and
    // hanging up) would kill a healthy call. No-op.
    if (this.active?.callId === ev.callId) {
      this.log.debug({ callId: ev.callId.toString() }, 'Redundant CONNECTED for the active Signal call; ignoring');
      return;
    }
    // Same-tick duplicate: a second CONNECTED can land before the first
    // handler's first await resolves — `active` is still null then, so the
    // short-circuit above misses it, and `pending` still holds the entry
    // (deletion is deferred), so without this guard both would run the full
    // setup (double row, orphaned transport).
    if (this.connecting.has(ev.callId)) {
      this.log.debug({ callId: ev.callId.toString() }, 'Duplicate CONNECTED while session setup is in flight; ignoring');
      return;
    }

    const caller = this.pending.get(ev.callId);
    if (!caller) {
      // CONNECTED without a prior accept from us is a protocol surprise —
      // never start a session (and thus never answer) without having run it
      // through the answer policy above.
      this.log.warn({ callId: ev.callId.toString() }, 'CONNECTED for a Signal call with no pending accept — hanging up');
      this.fireAndLog(this.config.rpcClient.hangupCall(ev.callId), 'hangupCall', ev.callId);
      return;
    }
    // NOTE: pending.delete is deferred until `active` is set (or an error path
    // cleans up below). While the store/bus awaits are in flight neither
    // `active` nor `pending` would otherwise show this call, and a concurrent
    // RINGING_INCOMING would slip past the busy check and be accepted —
    // keeping the entry in `pending` preserves the one-call-at-a-time
    // invariant through the whole setup sequence.

    if (!ev.inputDeviceName || !ev.outputDeviceName) {
      this.log.error({ callId: ev.callId.toString() }, 'CONNECTED missing PulseAudio device names — hanging up');
      this.clearPending(ev.callId);
      this.fireAndLog(this.config.rpcClient.hangupCall(ev.callId), 'hangupCall', ev.callId);
      return;
    }

    const sessionId = randomUUID();
    const conversationId = `voice:${sessionId}`;
    const roomName = `signal-call:${ev.callId.toString()}`;

    // Everything from the row insert onward runs inside one guarded region:
    // any throw after this point (store insert, bus publish, transport build,
    // runtime start) must leave clean state — RTC hung up, the row (if it was
    // created) ended, and active/pending cleared. Otherwise the RTC call
    // stays connected with no audio while the bridge believes it is idle.
    // Added to `connecting` BEFORE the first await (same-tick duplicate
    // CONNECTED guard); removed in the finally.
    this.connecting.add(ev.callId);
    let rowCreated = false;
    try {
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
      rowCreated = true;

      await this.config.bus.publish('channel', createVoiceSessionStarted({
        sessionId: session.id,
        conversationId: session.conversationId,
        livekitRoom: session.livekitRoom,
      }));

      // The caller may have hung up while the row/publish awaits were in
      // flight (handleEnded flags it here — the call was neither `active`
      // nor still meaningfully pending from its point of view). Don't start
      // a session for a dead call: end the row we just created and stop.
      // No hangupCall needed — the remote side already ended the call.
      if (this.endedDuringSetup.has(ev.callId)) {
        this.log.info({ callId: ev.callId.toString(), sessionId }, 'Signal call ended during session setup; aborting start');
        this.clearPending(ev.callId);
        try {
          await this.config.voiceRuntime.endSession(sessionId, 'remote_hangup');
        } catch (endErr) {
          this.log.error({ err: endErr, sessionId }, 'endSession failed after mid-setup hangup');
        }
        return;
      }

      const transport = this.buildTransport({
        pulseServer: this.config.pulseServer,
        inputDeviceName: ev.inputDeviceName,
        outputDeviceName: ev.outputDeviceName,
        logger: this.log,
      });

      const capTimer = setTimeout(() => {
        this.fireAndLog(this.enforceCap(), 'enforceCap', ev.callId);
      }, this.maxCallSeconds * 1000);

      this.active = { callId: ev.callId, sessionId, transport, capTimer, caller };
      // The call is now visible as `active`, so it may leave `pending`
      // without opening the busy-check race window described above. clearPending
      // also cancels the pending backstop timer (the cap timer now governs).
      this.clearPending(ev.callId);

      await this.config.voiceRuntime.startSession({
        sessionId,
        conversationId,
        roomName,
        caller,
        transport,
        openingGreeting: true,
      });

      // startSession has resolved and the session is now registered in the
      // runtime's session map. If ENDED arrived while we were awaiting it,
      // handleEnded (above) recorded it in endedDuringSetup instead of
      // tearing down immediately, since nothing was registered yet to tear
      // down. Do the real teardown now — endSession will find a registered
      // session (live STT + subprocesses) instead of a no-op. The
      // `this.active?.callId !== ev.callId` half of the check is
      // belt-and-suspenders for any other path (stop(), handleDisconnected)
      // that may have cleared `active` for this call during the same await
      // window without going through endedDuringSetup.
      if (this.endedDuringSetup.has(ev.callId) || this.active?.callId !== ev.callId) {
        this.log.info(
          { callId: ev.callId.toString(), sessionId },
          'Signal call ended while startSession was still connecting; tearing down the now-registered session',
        );
        // Only clear `active`/capTimer if it's still this call's — another
        // call could have become active in the meantime and must not be
        // clobbered.
        if (this.active?.callId === ev.callId) {
          if (this.active.capTimer) clearTimeout(this.active.capTimer);
          this.active = null;
        }
        try {
          await this.config.voiceRuntime.endSession(sessionId, 'remote_hangup');
        } catch (endErr) {
          this.log.error({ err: endErr, sessionId }, 'endSession failed after mid-start hangup');
        }
      }
    } catch (err) {
      this.log.error(
        { err, sessionId, callId: ev.callId.toString() },
        'Failed to start a Signal call session — ending it',
      );
      // Mirrors voice-adapter.ts:158-168, extended to cover pre-startSession
      // throws too: whatever partial state exists must be torn down.
      this.clearPending(ev.callId);
      if (this.active?.callId === ev.callId) {
        if (this.active.capTimer) clearTimeout(this.active.capTimer);
        this.active = null;
      }
      try {
        await this.config.rpcClient.hangupCall(ev.callId);
      } catch (hangupErr) {
        this.log.error({ err: hangupErr, callId: ev.callId.toString() }, 'hangupCall failed after session start failure');
      }
      // Only end a session that actually got a row — endSession before the
      // insert would be a no-op anyway, but skipping it keeps logs honest.
      if (rowCreated) {
        try {
          await this.config.voiceRuntime.endSession(sessionId, 'runtime_start_failed');
        } catch (endErr) {
          this.log.error({ err: endErr, sessionId }, 'endSession failed after session start failure');
        }
      }
    } finally {
      // The setup window is over — whichever way it exited (active set, error
      // cleanup, or mid-setup hangup abort), the reentrance guard and any
      // ENDED-during-setup flag for this callId must not outlive it.
      this.connecting.delete(ev.callId);
      this.endedDuringSetup.delete(ev.callId);
    }
  }

  private async handleEnded(ev: SignalCallEvent): Promise<void> {
    if (this.active && this.active.callId === ev.callId) {
      const { transport, sessionId, capTimer } = this.active;
      if (capTimer) clearTimeout(capTimer);
      // `active` (and its capTimer) is assigned in handleConnected BEFORE
      // its `await voiceRuntime.startSession(...)` resolves — the cap timer
      // needs to start ticking from CONNECTED, not from whenever the STT
      // connection finishes. If ENDED lands in that window (`connecting`
      // still holds this callId), startSession hasn't registered the
      // session with the runtime yet and the transport's onClose hasn't
      // been wired up: notifyRemoteHangup() here would be a silent no-op
      // (empty closeCallbacks, and closeFired=true would swallow the real
      // listener startSession registers moments later) and endSession would
      // look up a session id the runtime doesn't know about yet. Flag it
      // (reusing endedDuringSetup) so handleConnected's post-await recheck
      // tears the session down once it actually exists, instead of doing a
      // no-op teardown against state that isn't there yet.
      if (this.connecting.has(ev.callId)) {
        this.endedDuringSetup.add(ev.callId);
        this.active = null;
        return;
      }
      // Drives the runtime's own teardown via AudioTransport.onClose.
      transport.notifyRemoteHangup();
      // Safety net: endSession is idempotent via the store's dedupe
      // (voice-runtime.ts:1197-1198 — endSession returns null once the row
      // is already 'ended'), so calling it here even though notifyRemoteHangup
      // should already trigger teardown costs nothing and covers a transport
      // that (for whatever reason) doesn't fire onClose.
      this.fireAndLog(this.config.voiceRuntime.endSession(sessionId, 'remote_hangup'), 'endSession(remote_hangup)', ev.callId);
      this.active = null;
      return;
    }

    // Flag a hangup that lands while handleConnected's setup awaits are in
    // flight — the setup re-checks this after its awaits and aborts instead
    // of starting a session for a call that is already over.
    if (this.connecting.has(ev.callId)) {
      this.endedDuringSetup.add(ev.callId);
    }

    if (this.clearPending(ev.callId)) {
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
    this.fireAndLog(this.config.rpcClient.hangupCall(callId), 'hangupCall(max_duration)', callId);
    this.fireAndLog(this.config.voiceRuntime.endSession(sessionId, 'max_duration'), 'endSession(max_duration)', callId);
    this.active = null;
  }

  private handleDisconnected(): void {
    // Drop any accepted-but-never-connected calls: their CONNECTED will never
    // arrive on a dead socket, and a callId stuck in `pending` would make the
    // busy check reject every future call until restart — wedging the channel.
    // (Reconnect + resubscribe is automatic — Task 2; nothing to hang up over
    // a socket that no longer exists.)
    if (this.pending.size > 0) {
      const droppedCallIds = [...this.pending.keys()].map(id => id.toString());
      // clearPending per key so each entry's expiry timer is cancelled too
      // (a bare pending.clear() would leak every pending backstop timer).
      for (const callId of [...this.pending.keys()]) this.clearPending(callId);
      this.log.info({ droppedCallIds }, 'Signal RPC socket disconnected; dropping pending calls');
    }

    if (!this.active) return;
    const { callId, sessionId, capTimer } = this.active;
    if (capTimer) clearTimeout(capTimer);
    this.log.error({ sessionId }, 'Signal RPC socket disconnected mid-call; ending voice session');
    this.fireAndLog(this.config.voiceRuntime.endSession(sessionId, 'rpc_disconnected'), 'endSession(rpc_disconnected)', callId);
    this.active = null;
  }
}
