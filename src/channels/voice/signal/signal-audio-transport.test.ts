import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../../../logger.js';
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

function setup() {
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
    logger: createSilentLogger(),
    spawnFn,
  });
  return { transport, children };
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
});
