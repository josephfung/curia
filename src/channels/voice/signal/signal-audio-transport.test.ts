import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../../../logger.js';
import type { Logger } from '../../../logger.js';
import { SignalAudioTransport } from './signal-audio-transport.js';
import type { AudioChildProcess, SpawnFn } from './signal-audio-transport.js';

class FakeChild extends EventEmitter implements AudioChildProcess {
  stdout = new PassThrough();
  stdin = new PassThrough();
  killed: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM');
    // simulate prompt exit on TERM
    queueMicrotask(() => this.emit('exit', 0, signal ?? null));
    return true;
  }
}

function setup(opts: { logger?: Logger } = {}) {
  const children: { cmd: string; args: string[]; child: FakeChild }[] = [];
  const spawnFn: SpawnFn = (cmd, args) => {
    const child = new FakeChild();
    children.push({ cmd, args, child });
    return child;
  };
  const transport = new SignalAudioTransport({
    pulseServer: '/run/pulse/native',
    inputDeviceName: 'signal_input_42',
    outputDeviceName: 'signal_output_42',
    logger: opts.logger ?? createSilentLogger(),
    spawnFn,
  });
  return { transport, children };
}

/**
 * Stub pino-shaped logger with spyable level methods, for tests that assert
 * on the level a message was logged at (createSilentLogger swallows output
 * so there's nothing to assert against).
 */
function stubLogger() {
  const debug = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const logger: Record<string, unknown> = { debug, info, warn, error };
  return { logger: logger as unknown as Logger, debug, info, warn, error };
}

describe('SignalAudioTransport', () => {
  it('spawns parec on the monitor source and pacat on the sink_for_ sink', async () => {
    const { transport, children } = setup();
    await transport.connect();
    const parec = children.find(c => c.cmd === 'parec')!;
    const pacat = children.find(c => c.cmd === 'pacat')!;
    expect(parec.args).toContain('--device=signal_output_42.monitor');
    expect(parec.args).toContain('--server=/run/pulse/native');
    expect(pacat.args).toContain('--device=sink_for_signal_input_42');
    await transport.disconnect();
  });

  it('chunks parec stdout into 20ms 960-sample frames with remainder carry', async () => {
    const { transport, children } = setup();
    const frames: number[] = [];
    transport.onRemoteAudio(f => {
      frames.push(f.pcm.length);
      expect(f.sampleRate).toBe(48_000);
    });
    await transport.connect();
    const parec = children.find(c => c.cmd === 'parec')!.child;
    parec.stdout.write(Buffer.alloc(1920 + 1000)); // one frame + carry
    parec.stdout.write(Buffer.alloc(920));          // completes the second frame
    await vi.waitFor(() => expect(frames).toEqual([960, 960]));
    await transport.disconnect();
  });

  it('publishAudio writes s16le bytes to pacat stdin', async () => {
    const { transport, children } = setup();
    await transport.connect();
    const pacat = children.find(c => c.cmd === 'pacat')!.child;
    const chunks: Buffer[] = [];
    pacat.stdin.on('data', (c: Buffer) => chunks.push(c));
    const pcm = new Int16Array(960).fill(1234);
    await transport.publishAudio({ pcm, sampleRate: 48_000, channels: 1 });
    await vi.waitFor(() => expect(Buffer.concat(chunks).length).toBe(1920));
    expect(Buffer.concat(chunks).readInt16LE(0)).toBe(1234);
    await transport.disconnect();
  });

  it('fires onClose(transport_error) once when a child dies unexpectedly', async () => {
    const { transport, children } = setup();
    const reasons: string[] = [];
    transport.onClose(r => reasons.push(r));
    await transport.connect();
    children[0]!.child.emit('exit', 1, null);
    children[1]!.child.emit('exit', 1, null);
    expect(reasons).toEqual(['transport_error']);
  });

  it('publishAudio settles instead of hanging when pacat dies before drain', async () => {
    // stdin with a tiny highWaterMark: the very first 1920-byte write exceeds
    // it, so write() returns false and publishAudio parks awaiting 'drain'.
    // (A default PassThrough buffers ~64 KiB per side on Node 24 before
    // signaling backpressure, which would make this test silently vacuous.)
    class BackpressureChild extends FakeChild {
      override stdin = new PassThrough({ highWaterMark: 1 });
    }
    const children: { cmd: string; child: FakeChild }[] = [];
    const spawnFn: SpawnFn = cmd => {
      const child = new BackpressureChild();
      children.push({ cmd, child });
      return child;
    };
    const transport = new SignalAudioTransport({
      pulseServer: '/run/pulse/native',
      inputDeviceName: 'signal_input_42',
      outputDeviceName: 'signal_output_42',
      logger: createSilentLogger(),
      spawnFn,
    });
    await transport.connect();
    const pacat = children.find(c => c.cmd === 'pacat')!.child;
    const pcm = new Int16Array(960).fill(7);
    // Parks on backpressure — no 'data' listener ever drains this stdin.
    const pending = transport.publishAudio({ pcm, sampleRate: 48_000, channels: 1 });
    // pacat dies before any drain: the pending publish must settle.
    pacat.emit('exit', 1, null);
    await pending; // hangs (test times out) if the fix regresses
    // Subsequent publishes drop the frame instead of writing into the dead pipe.
    await transport.publishAudio({ pcm, sampleRate: 48_000, channels: 1 });
  });

  it('disconnect escalates to SIGKILL when a child ignores SIGTERM past the grace period', async () => {
    // A child that ignores SIGTERM and only dies on SIGKILL, exercising the
    // 500 ms grace-timer escalation in disconnect().
    class StubbornChild extends FakeChild {
      override kill(signal?: NodeJS.Signals): boolean {
        this.killed.push(signal ?? 'SIGTERM');
        if (signal === 'SIGKILL') {
          queueMicrotask(() => this.emit('exit', null, 'SIGKILL'));
        }
        return true;
      }
    }
    vi.useFakeTimers();
    try {
      const stubborn: StubbornChild[] = [];
      const spawnFn: SpawnFn = () => {
        const child = new StubbornChild();
        stubborn.push(child);
        return child;
      };
      const transport = new SignalAudioTransport({
        pulseServer: '/run/pulse/native',
        inputDeviceName: 'signal_input_42',
        outputDeviceName: 'signal_output_42',
        logger: createSilentLogger(),
        spawnFn,
      });
      await transport.connect();
      const done = transport.disconnect();
      await vi.advanceTimersByTimeAsync(500); // grace period elapses → SIGKILL
      await done;
      expect(stubborn).toHaveLength(2);
      for (const child of stubborn) {
        expect(child.killed).toEqual(['SIGTERM', 'SIGKILL']);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifyRemoteHangup fires principal_disconnected; local disconnect fires nothing', async () => {
    const { transport } = setup();
    const reasons: string[] = [];
    transport.onClose(r => reasons.push(r));
    await transport.connect();
    transport.notifyRemoteHangup();
    expect(reasons).toEqual(['principal_disconnected']);

    const { transport: t2 } = setup();
    const r2: string[] = [];
    t2.onClose(r => r2.push(r));
    await t2.connect();
    await t2.disconnect();
    expect(r2).toEqual([]);
  });

  it('does not let a throwing onRemoteAudio callback crash the process or block other listeners', async () => {
    const { transport, children } = setup();
    const received: number[] = [];
    // Registered first so it runs before the well-behaved listener below —
    // proves iteration continues past a throw rather than crashing out.
    transport.onRemoteAudio(() => {
      throw new Error('boom from a bad onRemoteAudio listener');
    });
    transport.onRemoteAudio(frame => {
      received.push(frame.pcm.length);
    });
    await transport.connect();
    const parec = children.find(c => c.cmd === 'parec')!.child;
    parec.stdout.write(Buffer.alloc(1920)); // exactly one 20ms frame
    await vi.waitFor(() => expect(received).toEqual([960]));
    await transport.disconnect();
  });

  it('does not let a throwing onClose callback crash the process or block other listeners', async () => {
    const { transport } = setup();
    const reasons: string[] = [];
    transport.onClose(() => {
      throw new Error('boom from a bad onClose listener');
    });
    transport.onClose(r => reasons.push(r));
    await transport.connect();
    transport.notifyRemoteHangup();
    expect(reasons).toEqual(['principal_disconnected']);
  });

  it('logs at warn (not debug) when a child exits abnormally outside of disconnect()', async () => {
    const { logger, warn, debug } = stubLogger();
    const { transport, children } = setup({ logger });
    await transport.connect();
    warn.mockClear();
    debug.mockClear();

    // Simulates parec dying on its own mid-call (not our own SIGTERM/SIGKILL).
    children.find(c => c.cmd === 'parec')!.child.emit('exit', 1, null);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 1, signal: null, child: 'parec' }),
      expect.any(String),
    );
    expect(debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ child: 'parec' }),
      expect.stringContaining('exited'),
    );
  });

  it('logs at debug (not warn) for the expected exits during our own disconnect()', async () => {
    const { logger, warn, debug } = stubLogger();
    const { transport } = setup({ logger });
    await transport.connect();
    warn.mockClear();
    debug.mockClear();

    // FakeChild.kill() simulates a prompt exit(0, signal) in response to our
    // own SIGTERM — expected, not abnormal.
    await transport.disconnect();

    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
  });
});
