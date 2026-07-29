import type {
  BatchTextToSpeechProvider,
  PcmFrame,
  SynthesizeToFileOptions,
  SynthesizeToFileResult,
  TextToSpeechProvider,
  TtsSynthesizeOptions,
} from './types.js';
import { AUDIO_FILE_CONTENT_TYPE } from './types.js';

export interface FakeTtsProviderOptions {
  sampleRate?: number;
  frameSamples?: number;
  frameCount?: number;
  /** Fixed bytes returned by synthesizeToFile. */
  fileBytes?: Uint8Array;
  /** When set, synthesizeToFile rejects with this error. */
  fileError?: Error;
}

export class FakeTtsProvider implements TextToSpeechProvider, BatchTextToSpeechProvider {
  readonly id = 'fake-tts';
  readonly requests: TtsSynthesizeOptions[] = [];
  readonly fileRequests: SynthesizeToFileOptions[] = [];

  private readonly sampleRate: number;
  private readonly frameSamples: number;
  private readonly frameCount: number;
  private readonly cancelled = new Set<string>();
  private fileBytes: Uint8Array;
  private fileError: Error | undefined;

  constructor(opts: FakeTtsProviderOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 24000;
    this.frameSamples = opts.frameSamples ?? 160;
    this.frameCount = opts.frameCount ?? 3;
    this.fileBytes = opts.fileBytes ?? new Uint8Array([1, 2, 3, 4]);
    this.fileError = opts.fileError;
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

  async synthesizeToFile(opts: SynthesizeToFileOptions): Promise<SynthesizeToFileResult> {
    this.fileRequests.push(opts);
    if (this.fileError) throw this.fileError;
    const sampleRate = opts.sampleRate ?? this.sampleRate;
    return {
      bytes: this.fileBytes,
      format: opts.format,
      contentType: AUDIO_FILE_CONTENT_TYPE[opts.format],
      sampleRate,
    };
  }

  cancel(streamId: string): void {
    this.cancelled.add(streamId);
  }

  setFileBytes(bytes: Uint8Array): void {
    this.fileBytes = bytes;
  }

  setFileError(err: Error | undefined): void {
    this.fileError = err;
  }

  private isCancelled(opts: TtsSynthesizeOptions): boolean {
    return this.cancelled.has(opts.streamId) || opts.signal?.aborted === true;
  }
}
