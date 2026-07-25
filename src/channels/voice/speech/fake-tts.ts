import type { PcmFrame, TextToSpeechProvider, TtsSynthesizeOptions } from './types.js';

export interface FakeTtsProviderOptions {
  sampleRate?: number;
  frameSamples?: number;
  frameCount?: number;
}

export class FakeTtsProvider implements TextToSpeechProvider {
  readonly id = 'fake-tts';
  readonly requests: TtsSynthesizeOptions[] = [];

  private readonly sampleRate: number;
  private readonly frameSamples: number;
  private readonly frameCount: number;
  private readonly cancelled = new Set<string>();

  constructor(opts: FakeTtsProviderOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 24000;
    this.frameSamples = opts.frameSamples ?? 160;
    this.frameCount = opts.frameCount ?? 3;
  }

  async *synthesize(opts: TtsSynthesizeOptions): AsyncIterable<PcmFrame> {
    this.requests.push(opts);
    const sampleRate = opts.sampleRate ?? this.sampleRate;

    for (let frameIndex = 0; frameIndex < this.frameCount; frameIndex += 1) {
      if (this.isCancelled(opts)) return;
      await Promise.resolve();
      if (this.isCancelled(opts)) return;

      const pcm = new Int16Array(this.frameSamples);
      pcm.fill(frameIndex + 1);
      yield { pcm, sampleRate, channels: 1 };
    }
  }

  cancel(streamId: string): void {
    this.cancelled.add(streamId);
  }

  private isCancelled(opts: TtsSynthesizeOptions): boolean {
    return this.cancelled.has(opts.streamId) || opts.signal?.aborted === true;
  }
}
