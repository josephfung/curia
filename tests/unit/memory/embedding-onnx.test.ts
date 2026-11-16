// Unit tests for the in-process ONNX embedding backend (design §2) and the weights hash
// that goes into its stamp (design §3).
//
// The tests marked "real weights" load models/embedding/all-MiniLM-L6-v2/, which
// `pnpm fetch:embedder` writes. Locally they skip when the weights are absent. In CI they
// never skip: CI fetches the weights before tests, so missing weights there fail loudly.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ort from 'onnxruntime-node';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import {
  BUNDLED_WEIGHTS_FILE,
  BUNDLED_MAX_TOKENS,
  OnnxEmbeddingBackend,
  hashBundledWeights,
  type OnnxRunner,
  type TextTokenizer,
} from '../../../src/memory/embedding-onnx.js';
import { ALL_MINILM_L6_V2 } from '../../../src/memory/embedding-profiles.js';
import type { EventBus } from '../../../src/bus/bus.js';
import { createSilentLogger } from '../../../src/logger.js';

const MODEL_DIR = path.resolve(import.meta.dirname, '../../../models/embedding/all-MiniLM-L6-v2');
const WEIGHTS_SHA256 = 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1';
const weightsPresent = [BUNDLED_WEIGHTS_FILE, 'tokenizer.json', 'tokenizer_config.json']
  .every(f => existsSync(path.join(MODEL_DIR, f)));

const BUNDLED_PROFILE = { ...ALL_MINILM_L6_V2, weightsSha256: WEIGHTS_SHA256 };

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function mockBus(): EventBus & { publish: ReturnType<typeof vi.fn> } {
  return { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus & { publish: ReturnType<typeof vi.fn> };
}

describe.skipIf(!weightsPresent && !process.env.CI)('OnnxEmbeddingBackend (real weights)', () => {
  let service: EmbeddingService;
  let bus: ReturnType<typeof mockBus>;

  beforeAll(async () => {
    if (!weightsPresent) {
      throw new Error(`Bundled embedder weights missing from ${MODEL_DIR} in CI. Run \`pnpm fetch:embedder\` before the tests.`);
    }
    bus = mockBus();
    service = await EmbeddingService.createBundled(MODEL_DIR, BUNDLED_PROFILE, createSilentLogger(), bus);
  });

  it('embeds a name as 384 numbers of unit length', async () => {
    const v = await service.embed('Robert Lindqvist', 'similarity');
    expect(v).toHaveLength(384);
    expect(Math.abs(norm(v) - 1)).toBeLessThan(1e-6);
  });

  it('truncates a long input to the model\'s window instead of failing', async () => {
    const v = await service.embed('x'.repeat(2000), 'document');
    expect(v).toHaveLength(384);
    expect(Math.abs(norm(v) - 1)).toBeLessThan(1e-6);
  });

  // Review Focus 4: calls are serialised, and concurrency does not mix up results.
  it('returns each concurrent call\'s own vector', async () => {
    const texts = Array.from({ length: 20 }, (_, i) => `Invented label number ${i}`);
    const sequential: number[][] = [];
    for (const t of texts) sequential.push(await service.embed(t, 'similarity'));
    const concurrent = await Promise.all(texts.map(t => service.embed(t, 'similarity')));
    expect(concurrent).toHaveLength(20);
    concurrent.forEach((v, i) => expect(v).toEqual(sequential[i]));
  });

  it('publishes embedding.call with zero cost and the real token count', async () => {
    bus.publish.mockClear();
    await service.embed('Prefers morning meetings', 'document');
    await new Promise(resolve => setImmediate(resolve));
    const call = bus.publish.mock.calls.find(([, e]) => (e as { type: string }).type === 'embedding.call');
    expect(call).toBeDefined();
    const event = call![1] as { payload: Record<string, unknown> };
    expect(call![0]).toBe('system');
    expect(event.payload).toMatchObject({
      model: 'all-MiniLM-L6-v2',
      estimatedCostUsd: 0,
      inputTextLength: 'Prefers morning meetings'.length,
    });
    expect(event.payload['inputTokens']).toBeGreaterThan(2);
    expect(event.payload['latencyMs']).toBeGreaterThanOrEqual(0);
  });

  // Review Focus 2: the stamp's hash and the loaded file must agree.
  it('refuses a profile whose weights hash differs from the file', async () => {
    const wrong = { ...ALL_MINILM_L6_V2, weightsSha256: '0'.repeat(64) };
    await expect(EmbeddingService.createBundled(MODEL_DIR, wrong, createSilentLogger()))
      .rejects.toThrow(/weights/i);
  });

  describe('hashBundledWeights', () => {
    let tmp: string;

    beforeAll(async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), 'curia-embedder-'));
    });

    afterAll(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('returns the manifest hash for the shipped file', async () => {
      expect(await hashBundledWeights(MODEL_DIR, createSilentLogger())).toBe(WEIGHTS_SHA256);
    });

    // Review Focus 2: another export in the model dir gets its real hash, and a warning.
    it('returns the real hash of a modified copy and warns about the manifest mismatch', async () => {
      const copy = path.join(tmp, BUNDLED_WEIGHTS_FILE);
      await copyFile(path.join(MODEL_DIR, BUNDLED_WEIGHTS_FILE), copy);
      await appendFile(copy, Buffer.from([0]));
      const expected = createHash('sha256').update(await readFile(copy)).digest('hex');

      const logger = createSilentLogger();
      const warn = vi.spyOn(logger, 'warn');
      const actual = await hashBundledWeights(tmp, logger);

      expect(actual).toBe(expected);
      expect(actual).not.toBe(WEIGHTS_SHA256);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![1])).toMatch(/manifest/i);
    });
  });
});

describe('bundled embedder without weights', () => {
  it('names pnpm fetch:embedder when the model dir is missing', async () => {
    const missing = path.join(os.tmpdir(), 'curia-no-such-embedder-dir');
    await expect(hashBundledWeights(missing, createSilentLogger())).rejects.toThrow(/pnpm fetch:embedder/);
    await expect(EmbeddingService.createBundled(missing, BUNDLED_PROFILE, createSilentLogger()))
      .rejects.toThrow(/pnpm fetch:embedder/);
  });

  it('refuses a profile without a pooling strategy before touching the disk', async () => {
    const noPooling = { ...BUNDLED_PROFILE, pooling: undefined };
    await expect(OnnxEmbeddingBackend.load(MODEL_DIR, noPooling, createSilentLogger()))
      .rejects.toThrow(/no pooling strategy/);
  });

  it('refuses a profile without a weights hash', async () => {
    await expect(EmbeddingService.createBundled(MODEL_DIR, ALL_MINILM_L6_V2, createSilentLogger()))
      .rejects.toThrow(/weightsSha256/);
  });
});

// The backend's arithmetic and failure handling, with a stub session and tokenizer so the
// exact inputs and outputs are known.
describe('OnnxEmbeddingBackend with a stub session', () => {
  function tensorOf(values: number[], dims: number[]): ort.Tensor {
    return new ort.Tensor('float32', Float32Array.from(values), dims);
  }

  function stubTokenizer(ids: number[]): TextTokenizer {
    return { encode: () => ({ ids, attention_mask: ids.map(() => 1) }) };
  }

  function backend(session: OnnxRunner, tokenizer: TextTokenizer, bus?: EventBus, dimensions = 2) {
    return new OnnxEmbeddingBackend({
      session,
      tokenizer,
      model: 'stub-model',
      dimensions,
      pooling: 'mean',
      logger: createSilentLogger(),
      bus,
    });
  }

  it('mean-pools over the attention mask and L2-normalises', async () => {
    const session: OnnxRunner = {
      run: vi.fn().mockResolvedValue({ last_hidden_state: tensorOf([1, 0, 0, 1], [1, 2, 2]) }),
    };
    const v = await backend(session, stubTokenizer([101, 102])).embed('ab');
    expect(v[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(v[1]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('feeds int64 [1, n] inputs, truncated to the window with the final [SEP] kept', async () => {
    const ids = [101, ...Array.from({ length: 400 }, (_, i) => 1000 + i), 102];
    const run = vi.fn().mockImplementation((feeds: Record<string, ort.Tensor>) => {
      const n = feeds['input_ids']!.dims[1]!;
      return Promise.resolve({ last_hidden_state: tensorOf(Array.from({ length: n * 2 }, () => 1), [1, n, 2]) });
    });
    await backend({ run }, stubTokenizer(ids)).embed('long');

    const feeds = run.mock.calls[0]![0] as Record<string, ort.Tensor>;
    for (const name of ['input_ids', 'attention_mask', 'token_type_ids']) {
      expect(feeds[name]!.type).toBe('int64');
      expect(feeds[name]!.dims).toEqual([1, BUNDLED_MAX_TOKENS]);
    }
    const fed = Array.from(feeds['input_ids']!.data as BigInt64Array, Number);
    expect(fed[0]).toBe(101);
    expect(fed[BUNDLED_MAX_TOKENS - 2]).toBe(1000 + BUNDLED_MAX_TOKENS - 3);
    expect(fed[BUNDLED_MAX_TOKENS - 1]).toBe(102);
    expect(Array.from(feeds['token_type_ids']!.data as BigInt64Array, Number).every(x => x === 0)).toBe(true);
  });

  it('publishes embedding.error and rejects when inference fails, then keeps serving', async () => {
    const bus = mockBus();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('session exploded'))
      .mockResolvedValueOnce({ last_hidden_state: tensorOf([3, 4], [1, 1, 2]) });
    const b = backend({ run }, stubTokenizer([101]), bus);

    await expect(b.embed('first')).rejects.toThrow(/session exploded/);
    // The queue must not stay poisoned by the failed call.
    expect(await b.embed('second')).toEqual([0.6, 0.8]);

    const error = bus.publish.mock.calls.find(([, e]) => (e as { type: string }).type === 'embedding.error');
    expect(error).toBeDefined();
    expect((error![1] as { payload: Record<string, unknown> }).payload).toMatchObject({ model: 'stub-model' });
  });

  it('rejects an output whose width is not the profile\'s', async () => {
    const bus = mockBus();
    const run = vi.fn().mockResolvedValue({ last_hidden_state: tensorOf([1, 2, 3], [1, 1, 3]) });
    await expect(backend({ run }, stubTokenizer([101]), bus).embed('x')).rejects.toThrow(/dimensions/);
    expect(bus.publish.mock.calls.some(([, e]) => (e as { type: string }).type === 'embedding.error')).toBe(true);
  });
});
