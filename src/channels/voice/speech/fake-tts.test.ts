import { describe, expect, it } from 'vitest';
import { FakeTtsProvider } from './fake-tts.js';

describe('FakeTtsProvider', () => {
  it('yields deterministic PCM frames', async () => {
    const provider = new FakeTtsProvider({ sampleRate: 16000, frameSamples: 4, frameCount: 2 });

    const frames = [];
    for await (const frame of provider.synthesize({ text: 'hello', streamId: 's1' })) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      { pcm: new Int16Array([1, 1, 1, 1]), sampleRate: 16000, channels: 1 },
      { pcm: new Int16Array([2, 2, 2, 2]), sampleRate: 16000, channels: 1 },
    ]);
    expect(provider.requests).toHaveLength(1);
  });

  it('honors per-request sample rate overrides', async () => {
    const provider = new FakeTtsProvider({ sampleRate: 16000, frameSamples: 1, frameCount: 1 });

    const [frame] = await collect(provider.synthesize({
      text: 'hello',
      streamId: 's1',
      sampleRate: 24000,
    }));

    expect(frame?.sampleRate).toBe(24000);
  });

  it('cancel stops further frames', async () => {
    const provider = new FakeTtsProvider({ frameSamples: 1, frameCount: 3 });
    const iterator = provider.synthesize({ text: 'hello', streamId: 's1' })[Symbol.asyncIterator]();

    const first = await iterator.next();
    provider.cancel('s1');
    const second = await iterator.next();

    expect(first.done).toBe(false);
    expect(first.value?.pcm).toEqual(new Int16Array([1]));
    expect(second.done).toBe(true);
  });

  it('stops when the caller aborts', async () => {
    const provider = new FakeTtsProvider({ frameSamples: 1, frameCount: 3 });
    const controller = new AbortController();
    const iterator = provider.synthesize({
      text: 'hello',
      streamId: 's1',
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    const first = await iterator.next();
    controller.abort();
    const second = await iterator.next();

    expect(first.done).toBe(false);
    expect(second.done).toBe(true);
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}
