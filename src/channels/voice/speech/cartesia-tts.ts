import type { Logger } from '../../../logger.js';
import type { PcmFrame, TextToSpeechProvider, TtsSynthesizeOptions } from './types.js';

const CARTESIA_TTS_BYTES_URL = 'https://api.cartesia.ai/tts/bytes';
const CARTESIA_VERSION = '2026-03-01';
const DEFAULT_MODEL_ID = 'sonic-3.5';
const DEFAULT_SAMPLE_RATE = 24000;

interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

interface ByteReadableStream {
  getReader(): ByteReader;
}

function asByteReadableStream(body: unknown): ByteReadableStream | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const candidate = body as { getReader?: unknown };
  return typeof candidate.getReader === 'function' ? body as ByteReadableStream : undefined;
}

function mergeCarry(carry: Uint8Array | undefined, chunk: Uint8Array): Uint8Array {
  if (!carry || carry.byteLength === 0) return chunk;

  const merged = new Uint8Array(carry.byteLength + chunk.byteLength);
  merged.set(carry, 0);
  merged.set(chunk, carry.byteLength);
  return merged;
}

function pcmFrameFromBytes(bytes: Uint8Array, sampleRate: number): PcmFrame {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pcm = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < pcm.length; i += 1) {
    pcm[i] = view.getInt16(i * 2, true);
  }
  return { pcm, sampleRate, channels: 1 };
}

function responseErrorMessage(response: Response): string {
  return `Cartesia TTS request failed with HTTP ${response.status}`;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function makeAbortError(): Error {
  const err = new Error('Cartesia TTS synthesis aborted');
  err.name = 'AbortError';
  return err;
}

export class CartesiaTtsProvider implements TextToSpeechProvider {
  readonly id = 'cartesia';

  private readonly controllers = new Map<string, AbortController>();
  private readonly readers = new Map<string, ByteReader>();

  constructor(
    private readonly apiKey: string,
    private readonly logger: Logger,
    private readonly defaultVoiceId?: string,
  ) {}

  async *synthesize(opts: TtsSynthesizeOptions): AsyncIterable<PcmFrame> {
    const voiceId = opts.voiceId ?? this.defaultVoiceId;
    if (!voiceId) {
      throw new Error('Cartesia TTS requires a voiceId or defaultVoiceId');
    }

    const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const controller = new AbortController();
    this.controllers.set(opts.streamId, controller);

    const abortFromCaller = (): void => {
      controller.abort(opts.signal?.reason ?? makeAbortError());
    };

    if (opts.signal?.aborted) {
      abortFromCaller();
    } else {
      opts.signal?.addEventListener('abort', abortFromCaller, { once: true });
    }

    try {
      const response = await fetch(CARTESIA_TTS_BYTES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Cartesia-Version': CARTESIA_VERSION,
          'Content-Type': 'application/json',
          Accept: 'audio/*',
        },
        body: JSON.stringify({
          model_id: DEFAULT_MODEL_ID,
          transcript: opts.text,
          voice: {
            mode: 'id',
            id: voiceId,
          },
          output_format: {
            container: 'raw',
            encoding: 'pcm_s16le',
            sample_rate: sampleRate,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(responseErrorMessage(response));
      }

      const body = asByteReadableStream(response.body);
      if (!body) {
        throw new Error('Cartesia TTS response did not include a readable audio body');
      }

      const reader = body.getReader();
      this.readers.set(opts.streamId, reader);

      let carry: Uint8Array | undefined;
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;

          const bytes = mergeCarry(carry, value);
          const alignedLength = bytes.byteLength - (bytes.byteLength % 2);
          carry = alignedLength < bytes.byteLength ? bytes.slice(alignedLength) : undefined;
          if (alignedLength === 0) continue;

          yield pcmFrameFromBytes(bytes.slice(0, alignedLength), sampleRate);
        }
      } finally {
        this.readers.delete(opts.streamId);
        reader.releaseLock();
      }
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) {
        this.logger.debug({ streamId: opts.streamId }, 'Cartesia TTS synthesis cancelled');
        return;
      }
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', abortFromCaller);
      const current = this.controllers.get(opts.streamId);
      if (current === controller) {
        this.controllers.delete(opts.streamId);
      }
    }
  }

  cancel(streamId: string): void {
    const controller = this.controllers.get(streamId);
    controller?.abort(makeAbortError());

    const reader = this.readers.get(streamId);
    void reader?.cancel(makeAbortError()).catch(err => {
      this.logger.debug({ err, streamId }, 'Cartesia TTS reader cancel failed');
    });
  }
}
