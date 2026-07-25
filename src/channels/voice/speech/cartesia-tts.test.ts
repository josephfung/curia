import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../../../logger.js';
import { CartesiaTtsProvider } from './cartesia-tts.js';
import type { PcmFrame } from './types.js';

function bytesFromSamples(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => {
    view.setInt16(index * 2, sample, true);
  });
  return bytes;
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

describe('CartesiaTtsProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to Cartesia bytes API and yields raw PCM frames', async () => {
    const allBytes = bytesFromSamples([1, -2, 300]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      streamFromChunks([allBytes.slice(0, 3), allBytes.slice(3)]),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new CartesiaTtsProvider('cartesia-key', createSilentLogger());
    const frames = await collect(provider.synthesize({
      text: 'hello',
      streamId: 's1',
      voiceId: 'voice-1',
      sampleRate: 16000,
    }));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.cartesia.ai/tts/bytes');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer cartesia-key',
      'Cartesia-Version': '2026-03-01',
      'Content-Type': 'application/json',
      Accept: 'audio/*',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model_id: 'sonic-3.5',
      transcript: 'hello',
      voice: { mode: 'id', id: 'voice-1' },
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: 16000,
      },
    });

    expect(frames).toEqual([
      { pcm: new Int16Array([1]), sampleRate: 16000, channels: 1 },
      { pcm: new Int16Array([-2, 300]), sampleRate: 16000, channels: 1 },
    ]);
  });

  it('uses the default voice id when one is not provided per request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      streamFromChunks([bytesFromSamples([7])]),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new CartesiaTtsProvider('cartesia-key', createSilentLogger(), 'default-voice');

    await collect(provider.synthesize({ text: 'hello', streamId: 's1' }));

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body as string).voice).toEqual({ mode: 'id', id: 'default-voice' });
  });

  it('throws when Cartesia returns a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 401 })));
    const provider = new CartesiaTtsProvider('cartesia-key', createSilentLogger(), 'voice-1');

    await expect(collect(provider.synthesize({ text: 'hello', streamId: 's1' })))
      .rejects.toThrow('Cartesia TTS request failed with HTTP 401');
  });

  it('cancel stops further frames', async () => {
    let cancelCalled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytesFromSamples([1]));
      },
      cancel() {
        cancelCalled = true;
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const provider = new CartesiaTtsProvider('cartesia-key', createSilentLogger(), 'voice-1');
    const iterator = provider.synthesize({ text: 'hello', streamId: 's1' })[Symbol.asyncIterator]();

    const first = await iterator.next();
    provider.cancel('s1');
    const second = await iterator.next();

    expect(first.done).toBe(false);
    expect((first.value as PcmFrame).pcm).toEqual(new Int16Array([1]));
    expect(second.done).toBe(true);
    expect(cancelCalled).toBe(true);
  });
});
