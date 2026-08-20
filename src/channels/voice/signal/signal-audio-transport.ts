// signal-audio-transport.ts — AudioTransport backed by parec/pacat piping raw
// PCM through the PulseAudio native socket that signal-cli's container shares
// with us. There is no signaling handshake here: parec starts producing bytes
// the moment the remote party's audio hits the shared PulseAudio sink, and
// pacat starts consuming bytes the moment we write them. `connect()` only
// needs to get both child processes spawned.
//
// Device naming contract (from the Signal RingRTC call bridge):
//   - `outputDeviceName` (e.g. 'signal_output_106...') is the PulseAudio
//     *source* that carries the remote party's voice. We RECORD its
//     `.monitor` — the monitor source mirrors whatever is played into the
//     paired sink.
//   - `inputDeviceName` (e.g. 'signal_input_106...') is used to derive the
//     sink we PLAY our (assistant) audio into: `sink_for_<inputDeviceName>`.
//     signal-cli feeds that sink into the outbound call leg.

import { spawn } from 'node:child_process';
import type { Logger } from '../../../logger.js';
import type { AudioTransport, AudioTransportCloseReason } from '../audio-transport.js';
import type { PcmFrame } from '../../../speech/index.js';

/** 20 ms @ 48 kHz mono = 960 samples = 1920 bytes (s16le). */
export const SIGNAL_FRAME_SAMPLES = 960;
const SIGNAL_FRAME_BYTES = SIGNAL_FRAME_SAMPLES * 2;

/** Grace period after SIGTERM before we escalate to SIGKILL on disconnect(). */
const DISCONNECT_GRACE_MS = 500;

/**
 * Minimal shape of a spawned child process that SignalAudioTransport needs.
 * Matches (a subset of) node:child_process's ChildProcess so tests can inject
 * a fake without pulling in real processes.
 */
export interface AudioChildProcess {
  stdout: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => AudioChildProcess;

export interface SignalAudioTransportOpts {
  /** PulseAudio native socket path shared from the signal-cli container. */
  pulseServer: string;
  /** From callEvent: e.g. 'signal_input_106...' — we PLAY into sink_for_<this>. */
  inputDeviceName: string;
  /** From callEvent: e.g. 'signal_output_106...' — we RECORD <this>.monitor. */
  outputDeviceName: string;
  logger: Logger;
  /** Injected for tests; defaults to node:child_process spawn. */
  spawnFn?: SpawnFn;
}

/** Default spawnFn: wraps node:child_process spawn. */
const defaultSpawnFn: SpawnFn = (cmd, args, opts) =>
  spawn(cmd, args, { ...opts }) as unknown as AudioChildProcess;

export class SignalAudioTransport implements AudioTransport {
  readonly inboundSampleRate = 48_000;
  readonly publishSampleRate = 48_000;

  private readonly opts: SignalAudioTransportOpts;
  private readonly log: Logger;
  private readonly spawnFn: SpawnFn;

  private parec: AudioChildProcess | undefined;
  private pacat: AudioChildProcess | undefined;

  // Children that have already emitted 'exit'/'error'. A dead child never
  // emits 'exit' again, so terminateChild() — which resolves off a fresh
  // 'exit' — would otherwise hang forever waiting on one. disconnect() is
  // reached exactly when a child has died mid-call (handleUnexpectedExit →
  // fireClose('transport_error') → runtime endSession() → disconnect()), so
  // this is the common path, not a corner case. Short-circuit on it.
  private readonly deadChildren = new WeakSet<AudioChildProcess>();

  // Buffer of not-yet-emitted parec stdout bytes; frames are sliced off the
  // front once >= SIGNAL_FRAME_BYTES have accumulated.
  private inboundCarry: Buffer = Buffer.alloc(0);

  private readonly remoteCallbacks: Array<(frame: PcmFrame) => void> = [];
  private readonly closeCallbacks: Array<(reason: AudioTransportCloseReason) => void> = [];

  // `closing` distinguishes an intentional local disconnect() from an
  // unexpected child exit/error — only the latter fires close callbacks,
  // per the AudioTransport seam contract (audio-transport.ts:23-27).
  private closing = false;
  // Guards against double-firing close callbacks when both children exit
  // around the same time (e.g. parec dies, which then causes pacat to be
  // killed too) — the seam promises "once".
  private closeFired = false;

  // True once pacat has exited or errored. publishAudio checks it to drop
  // frames instead of writing into a dead pipe, and markPacatGone() uses it
  // to flush any backpressure waits that would otherwise never see 'drain'.
  private pacatGone = false;
  // publishAudio calls parked on 'drain'. Kept in a list (rather than a
  // per-call child.on('exit') listener) so they can be flushed centrally on
  // pacat death without leaking one exit listener per backpressured write.
  private pacatDrainWaiters: Array<() => void> = [];

  constructor(opts: SignalAudioTransportOpts) {
    this.opts = opts;
    this.log = opts.logger;
    this.spawnFn = opts.spawnFn ?? defaultSpawnFn;
  }

  async connect(): Promise<void> {
    const { pulseServer, inputDeviceName, outputDeviceName } = this.opts;
    // Pass both --server= (what these CLI tools document) and PULSE_SERVER
    // (what the PulseAudio client library actually reads) so behavior is
    // identical regardless of which one a given build of parec/pacat honors.
    const env: NodeJS.ProcessEnv = { ...process.env, PULSE_SERVER: pulseServer };

    this.parec = this.spawnFn('parec', [
      '--server=' + pulseServer,
      '--device=' + outputDeviceName + '.monitor',
      '--rate=48000',
      '--channels=1',
      '--format=s16le',
      '--raw',
    ], { env });

    this.pacat = this.spawnFn('pacat', [
      '--server=' + pulseServer,
      '--device=sink_for_' + inputDeviceName,
      '--rate=48000',
      '--channels=1',
      '--format=s16le',
      '--raw',
    ], { env });

    this.wireChild(this.parec, 'parec');
    this.wireChild(this.pacat, 'pacat');

    // Persistent stdin 'error' listener: when pacat dies mid-call, an
    // in-flight or late write surfaces EPIPE on the stream. Without a
    // listener, that 'error' would be an unhandled event and crash the
    // process. It also marks pacat gone so pending backpressure waits settle.
    this.pacat.stdin?.on('error', (err: Error) => {
      this.log.debug({ err }, 'pacat stdin error (expected when pacat exits mid-call)');
      this.markPacatGone();
    });

    this.parec.stdout?.on('data', (chunk: Buffer) => this.handleInboundChunk(chunk));

    // No handshake to await — parec/pacat produce/consume bytes on their own
    // schedule. Resolving once both children are spawned is sufficient; any
    // immediate spawn failure surfaces asynchronously via the 'error'/'exit'
    // handlers wired above, which fire close callbacks with 'transport_error'.
  }

  /** Attach exit/error/stderr handling common to both children. */
  private wireChild(child: AudioChildProcess, name: 'parec' | 'pacat'): void {
    child.on('error', err => {
      this.deadChildren.add(child);
      this.log.error({ err, child: name }, 'signal audio child process error');
      if (name === 'pacat') this.markPacatGone();
      this.handleUnexpectedExit();
    });
    child.on('exit', (code, signal) => {
      this.deadChildren.add(child);
      // A non-zero code / non-null signal while we're NOT in the middle of a
      // local disconnect() is an abnormal exit — parec/pacat died on their
      // own mid-call. That's worth a warn at prod log levels (default info),
      // not a debug line nobody sees until they turn on verbose logging. An
      // exit during our own disconnect() (SIGTERM/SIGKILL below) or a clean
      // code-0/no-signal exit is expected/normal and stays at debug.
      const abnormal = (code !== 0 || signal !== null) && !this.closing;
      if (abnormal) {
        this.log.warn({ code, signal, child: name }, 'signal audio child process exited abnormally');
      } else {
        this.log.debug({ code, signal, child: name }, 'signal audio child process exited');
      }
      if (name === 'pacat') this.markPacatGone();
      this.handleUnexpectedExit();
    });
    // Drain stderr at debug level so it never accumulates unread (which
    // would otherwise apply backpressure to the child and eventually stall
    // it). We don't act on stderr content, just log it for diagnostics.
    const stderr = (child as unknown as { stderr?: NodeJS.ReadableStream | null }).stderr;
    stderr?.on('data', (chunk: Buffer) => {
      this.log.debug({ child: name, line: chunk.toString('utf8').trim() }, 'signal audio child stderr');
    });
  }

  /** Called on every child 'error' or 'exit'; only fires close if not a local disconnect(). */
  private handleUnexpectedExit(): void {
    if (this.closing) return; // local disconnect() in progress — expected exit, no callback
    this.fireClose('transport_error');
  }

  private fireClose(reason: AudioTransportCloseReason): void {
    if (this.closeFired) return; // "once" guarantee — e.g. both children exiting
    this.closeFired = true;
    // This runs inside a child-process 'exit'/'error' event emit (or a
    // direct notifyRemoteHangup() call from the bridge). A throwing consumer
    // callback would otherwise become an uncaught exception on that call
    // stack and crash the process — guard each invocation individually so
    // one bad listener can't stop the rest from being notified.
    for (const cb of this.closeCallbacks) {
      try {
        cb(reason);
      } catch (err) {
        this.log.error({ err, reason }, 'onClose callback threw; continuing to next listener');
      }
    }
  }

  /**
   * Marks pacat dead and settles every publishAudio call parked on 'drain'.
   * With pacat gone the drain event will never fire; an unsettled promise
   * there would freeze the outbound write path for the rest of the call.
   */
  private markPacatGone(): void {
    this.pacatGone = true;
    // Swap-then-flush so waiters removing themselves (via their own settle
    // cleanup) can't mutate the array we're iterating.
    const waiters = this.pacatDrainWaiters;
    this.pacatDrainWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private handleInboundChunk(chunk: Buffer): void {
    this.inboundCarry = Buffer.concat([this.inboundCarry, chunk]);
    while (this.inboundCarry.length >= SIGNAL_FRAME_BYTES) {
      const slice = this.inboundCarry.subarray(0, SIGNAL_FRAME_BYTES);
      this.inboundCarry = this.inboundCarry.subarray(SIGNAL_FRAME_BYTES);
      // Copy the slice into its own buffer before wrapping it in an
      // Int16Array: `slice` is a view into `inboundCarry`, which we keep
      // mutating (re-slicing) as more data arrives. Without the copy the
      // Int16Array would alias memory that gets reused/discarded on the
      // next chunk, corrupting frames already handed to callbacks.
      const owned = Buffer.from(slice);
      const frame: PcmFrame = {
        pcm: new Int16Array(owned.buffer, owned.byteOffset, SIGNAL_FRAME_SAMPLES),
        sampleRate: 48_000,
        channels: 1,
      };
      // This runs inside parec's stdout 'data' event emit. A throwing
      // consumer callback would otherwise become an uncaught exception on
      // that call stack and crash the process — guard each invocation
      // individually so one bad listener can't stop the rest from getting
      // the frame (or stop the next chunk's 'data' event from firing).
      for (const cb of this.remoteCallbacks) {
        try {
          cb(frame);
        } catch (err) {
          this.log.error({ err }, 'onRemoteAudio callback threw; continuing to next listener');
        }
      }
    }
  }

  onRemoteAudio(cb: (frame: PcmFrame) => void): void {
    this.remoteCallbacks.push(cb);
  }

  onClose(cb: (reason: AudioTransportCloseReason) => void): void {
    this.closeCallbacks.push(cb);
  }

  async publishAudio(frame: PcmFrame): Promise<void> {
    const stdin = this.pacat?.stdin;
    if (!stdin || this.pacatGone || this.closing) {
      // Dead or absent pipe: drop the frame rather than block. The exit
      // handler has already fired 'transport_error' (or a local disconnect
      // is in flight), so the runtime is tearing the session down anyway.
      this.log.debug('publishAudio dropped a frame (pacat unavailable)');
      return;
    }
    const bytes = Buffer.from(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.length * 2);
    const canWriteMore = stdin.write(bytes);
    if (canWriteMore) return;
    // Backpressure: TTS can produce audio faster than realtime, but pacat
    // only drains at 48kHz playback speed. Wait for 'drain' before letting
    // the caller queue more frames, or we'd grow an unbounded write buffer.
    //
    // The wait must ALSO settle if pacat dies (child exit/error — via the
    // pacatDrainWaiters flush) or its stdin errors/closes before draining —
    // otherwise 'drain' never fires and this promise would hang forever,
    // freezing the outbound write path for the rest of the call. Resolving
    // (not rejecting) is deliberate: the exit handler already fires
    // 'transport_error', so the runtime tears down; the caller just needs
    // the promise to settle. All listeners are removed on settle so nothing
    // leaks across repeated backpressured writes.
    await new Promise<void>(resolve => {
      const settle = (): void => {
        stdin.removeListener('drain', settle);
        stdin.removeListener('close', settle);
        stdin.removeListener('error', settle);
        const idx = this.pacatDrainWaiters.indexOf(settle);
        if (idx !== -1) this.pacatDrainWaiters.splice(idx, 1);
        resolve();
      };
      stdin.once('drain', settle);
      stdin.once('close', settle);
      stdin.once('error', settle);
      this.pacatDrainWaiters.push(settle);
    });
  }

  /** Bridge calls this on callEvent ENDED so the runtime tears the session down. */
  notifyRemoteHangup(): void {
    // A local disconnect() already in flight/complete means the runtime tore
    // the session down on its own terms — a late remote-hangup notification
    // (e.g. a callEvent racing our own teardown) must not re-fire close.
    if (this.closing) return;
    this.fireClose('principal_disconnected');
  }

  async disconnect(): Promise<void> {
    if (this.closing) return; // idempotent — a second call is a no-op
    this.closing = true;

    const children = [this.parec, this.pacat].filter((c): c is AudioChildProcess => c !== undefined);
    if (children.length === 0) return;

    await Promise.all(children.map(child => this.terminateChild(child)));
  }

  /** SIGTERM a child and wait for it to exit, escalating to SIGKILL after a grace period. */
  private terminateChild(child: AudioChildProcess): Promise<void> {
    // Already exited/errored — no further 'exit' will ever fire, so waiting for
    // one would hang disconnect() (and everything awaiting it: endSession,
    // SignalCallBridge.stop(), handleConnected).
    if (this.deadChildren.has(child)) return Promise.resolve();
    return new Promise<void>(resolve => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      child.on('exit', () => finish());
      const killTimer = setTimeout(() => {
        // Child ignored SIGTERM within the grace period — force it.
        child.kill('SIGKILL');
      }, DISCONNECT_GRACE_MS);
      child.kill('SIGTERM');
    });
  }
}
