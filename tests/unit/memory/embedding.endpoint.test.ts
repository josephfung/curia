// embedding.endpoint.test.ts — unit tests for OpenAI-compatible embedding endpoints: the
// request the backend sends, and how it fits a wider vector to the profile's width.
// Resolution from config (which source, which profile) is in embedding.test.ts.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EmbeddingDimensionError,
  EmbeddingService,
  redactUrlUserinfo,
  EMBEDDING_FETCH_TIMEOUT_MS,
} from '../../../src/memory/embedding.js';
import type { EventBus } from '../../../src/bus/bus.js';
import { createSilentLogger } from '../../../src/logger.js';
import { OPENAI_TEXT_EMBEDDING_3_SMALL, type EmbeddingProfile } from '../../../src/memory/embedding-profiles.js';

const logger = createSilentLogger();
const EMBEDDING_DIMENSIONS = OPENAI_TEXT_EMBEDDING_3_SMALL.dimensions;
const profile: EmbeddingProfile = { ...OPENAI_TEXT_EMBEDDING_3_SMALL, model: 'm' };

function stubFetch(embedding: number[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: [{ embedding }], usage: { prompt_tokens: 3 } }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('EmbeddingService — custom endpoint', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to the configured URL and model with the configured key', async () => {
    const fetchMock = stubFetch(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5));
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'qwen3-embedding-4b', apiKey: 'local-key' },
      profile,
      logger,
    );

    await service.embed('hello', 'document');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://embed.local/v1/embeddings');
    expect(init.headers['Authorization']).toBe('Bearer local-key');
    expect(JSON.parse(init.body).model).toBe('qwen3-embedding-4b');
  });

  it('sends no Authorization header when the endpoint has no key', async () => {
    const fetchMock = stubFetch(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5));
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      profile,
      logger,
    );

    await service.embed('hello', 'document');

    expect(fetchMock.mock.calls[0]![1].headers).not.toHaveProperty('Authorization');
  });

  it('keeps the leading dimensions of a wider vector and rescales them to unit length', async () => {
    // 2560 values; the first EMBEDDING_DIMENSIONS are all 2, the rest are noise that must be dropped.
    stubFetch([
      ...Array.from({ length: EMBEDDING_DIMENSIONS }, () => 2),
      ...Array.from({ length: 2560 - EMBEDDING_DIMENSIONS }, () => 99),
    ]);
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      profile,
      logger,
    );

    const embedding = await service.embed('hello', 'document');

    expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embedding[0]).toBeCloseTo(1 / Math.sqrt(EMBEDDING_DIMENSIONS));
    expect(Math.sqrt(embedding.reduce((sum, x) => sum + x * x, 0))).toBeCloseTo(1);
  });

  it('warns once per backend the first time it truncates, naming the model and both widths', async () => {
    stubFetch(Array.from({ length: 2560 }, () => 1));
    const testLogger = createSilentLogger();
    const warnSpy = vi.spyOn(testLogger, 'warn');
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'wide-model', apiKey: undefined },
      profile,
      testLogger,
    );

    await service.embed('first', 'document');
    await service.embed('second', 'document');

    expect(warnSpy).toHaveBeenCalledOnce();
    const [fields, message] = warnSpy.mock.calls[0]! as unknown as [Record<string, unknown>, string];
    expect(fields).toEqual({ model: 'wide-model', returnedDimensions: 2560, profileDimensions: EMBEDDING_DIMENSIONS });
    expect(message).toContain('only valid for Matryoshka-trained models');
  });

  it('does not warn when the vector already has the profile width', async () => {
    stubFetch(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5));
    const testLogger = createSilentLogger();
    const warnSpy = vi.spyOn(testLogger, 'warn');
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      profile,
      testLogger,
    );

    await service.embed('hello', 'document');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still rejects a vector narrower than the profile width', async () => {
    stubFetch(Array.from({ length: 1024 }, () => 0.5));
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      profile,
      logger,
    );

    const err = await service.embed('hello', 'document').catch((e: unknown) => e);
    // Typed, so the drift check reads a narrower model as changed weights (#2023).
    expect(err).toBeInstanceOf(EmbeddingDimensionError);
    expect(err).toMatchObject({ expected: EMBEDDING_DIMENSIONS, actual: 1024 });
    expect((err as Error).message).toContain('Unexpected embedding dimensions: 1024');
  });

  it('rejects a response with no vector with a plain error, not a dimension error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      profile,
      logger,
    );

    const err = await service.embed('hello', 'document').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EmbeddingDimensionError);
  });

  it('asks the server for the profile width and cuts to it', async () => {
    const fetchMock = stubFetch(Array.from({ length: 2560 }, () => 1));
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      { ...profile, dimensions: 2000 },
      logger,
    );

    const embedding = await service.embed('hello', 'document');

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).dimensions).toBe(2000);
    expect(embedding).toHaveLength(2000);
  });

  it('gives up on a server that does not answer, through the fetch-failure path', async () => {
    // The real timer would make this test wait 30 seconds, so the test aborts the signal itself.
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
      })));
      const bus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;
      const testLogger = createSilentLogger();
      const errorSpy = vi.spyOn(testLogger, 'error');
      const service = EmbeddingService.createWithEndpoint(
        { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
        profile,
        testLogger,
        bus,
      );

      const pending = service.embed('hello', 'document');
      controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

      await expect(pending).rejects.toThrow('Embedding endpoint fetch error: The operation was aborted due to timeout');
      expect(timeoutSpy).toHaveBeenCalledWith(EMBEDDING_FETCH_TIMEOUT_MS);
      expect(EMBEDDING_FETCH_TIMEOUT_MS).toBe(30_000);
      const [, event] = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(event.type).toBe('embedding.error');
      expect(event.payload.errorType).toBe('FETCH_FAILED');
      expect(errorSpy).toHaveBeenCalledWith(expect.anything(), 'Embedding endpoint fetch failed');
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('sends the purpose prefix as part of the input', async () => {
    const fetchMock = stubFetch(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.5));
    const service = EmbeddingService.createWithEndpoint(
      { baseUrl: 'http://embed.local/v1', model: 'm', apiKey: undefined },
      { ...profile, prefixes: { query: 'Instruct: find\nQuery: ', document: '', similarity: '' } },
      logger,
    );

    await service.embed('who is Ada', 'query');
    await service.embed('Ada Lovelace', 'document');

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).input).toBe('Instruct: find\nQuery: who is Ada');
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).input).toBe('Ada Lovelace');
  });
});

describe('redactUrlUserinfo', () => {
  it('drops a user and password from the URL', () => {
    expect(redactUrlUserinfo('https://user:s3cr%40t@embed.example:8443/v1')).toBe('https://embed.example:8443/v1');
  });

  it('drops a user with no password', () => {
    expect(redactUrlUserinfo('http://token@embed.example/v1')).toBe('http://embed.example/v1');
  });

  it('leaves a URL without userinfo unchanged, including an @ in its path', () => {
    expect(redactUrlUserinfo('http://localhost:8080/v1')).toBe('http://localhost:8080/v1');
    expect(redactUrlUserinfo('http://embed.example/v1/@team')).toBe('http://embed.example/v1/@team');
  });
});
