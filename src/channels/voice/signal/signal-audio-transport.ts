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

    this.parec.stdout?.on('data', (chunk: Buffer) => this.handleInboundChunk(chunk));

    // No handshake to await — parec/pacat produce/consume bytes on their own
    // schedule. Resolving once both children are spawned is sufficient; any
    // immediate spawn failure surfaces asynchronously via the 'error'/'exit'
    // handlers wired above, which fire close callbacks with 'transport_error'.
  }

  /** Attach exit/error/stderr handling common to both children. */
  private wireChild(child: AudioChildProcess, name: 'parec' | 'pacat'): void {
    child.on('error', err => {
      this.log.error({ err, child: name }, 'signal audio child process error');
      this.handleUnexpectedExit();
    });
    child.on('exit', (code, signal) => {
      this.log.debug({ code, signal, child: name }, 'signal audio child process exited');
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
    for (const cb of this.closeCallbacks) cb(reason);
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
      for (const cb of this.remoteCallbacks) cb(frame);
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
    if (!stdin) {
      this.log.warn('publishAudio called with no pacat stdin available; dropping frame');
      return;
    }
    const bytes = Buffer.from(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.length * 2);
    const canWriteMore = stdin.write(bytes);
    if (canWriteMore) return;
    // Backpressure: TTS can produce audio faster than realtime, but pacat
    // only drains at 48kHz playback speed. Wait for 'drain' before letting
    // the caller queue more frames, or we'd grow an unbounded write buffer.
    await new Promise<void>(resolve => stdin.once('drain', () => resolve()));
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
