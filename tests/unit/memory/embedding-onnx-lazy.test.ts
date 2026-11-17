// The native ONNX binding loads only on the bundled path (#2023, ruling R9). An install that
// uses an endpoint never runs the bundled model, so it must not pay for onnxruntime-node's
// native addon (about 16 MB resident), nor fail to boot on a platform where it cannot load.
//
// vi.mock's factory runs the first time anything imports the module, so counting its calls
// counts real loads. Everything under test is imported dynamically, after the mock is in
// place: a static import here would load the module graph before the first assertion.
import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ort = vi.hoisted(() => ({ loads: 0 }));

vi.mock('onnxruntime-node', async (importOriginal) => {
  ort.loads++;
  return importOriginal();
});

const MODEL_DIR = path.resolve(import.meta.dirname, '../../../models/embedding/all-MiniLM-L6-v2');
// The same policy as embedding-onnx.test.ts: the bundled case skips locally without the
// weights, and in CI (which fetches them first) runs, so missing weights fail loudly there.
// The file names are spelled out: importing BUNDLED_WEIGHTS_FILE would load the module graph
// before the counting starts.
const weightsPresent = ['model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json']
  .every(f => existsSync(path.join(MODEL_DIR, f)));

describe('onnxruntime-node loading', () => {
  it('is not loaded by importing the embedding modules or building an endpoint service', async () => {
    const { EmbeddingService } = await import('../../../src/memory/embedding.js');
    await import('../../../src/memory/embedding-schema.js');
    await import('../../../src/memory/embedding-onnx.js');
    const { OPENAI_TEXT_EMBEDDING_3_SMALL } = await import('../../../src/memory/embedding-profiles.js');
    const { createSilentLogger } = await import('../../../src/logger.js');

    await EmbeddingService.create(
      { kind: 'endpoint', endpoint: { baseUrl: 'http://embed.invalid/v1', model: 'text-embedding-3-small', apiKey: undefined } },
      OPENAI_TEXT_EMBEDDING_3_SMALL,
      createSilentLogger(),
    );

    expect(ort.loads).toBe(0);
  });

  it.skipIf(!weightsPresent && !process.env.CI)('is loaded when the bundled model is', async () => {
    const { EmbeddingService } = await import('../../../src/memory/embedding.js');
    const { hashBundledWeights } = await import('../../../src/memory/embedding-onnx.js');
    const { ALL_MINILM_L6_V2 } = await import('../../../src/memory/embedding-profiles.js');
    const { createSilentLogger } = await import('../../../src/logger.js');
    const logger = createSilentLogger();

    const profile = { ...ALL_MINILM_L6_V2, weightsSha256: await hashBundledWeights(MODEL_DIR, logger) };
    const service = await EmbeddingService.create({ kind: 'bundled', modelDir: MODEL_DIR }, profile, logger);
    try {
      expect(ort.loads).toBe(1);
      expect(await service.embed('a short label', 'document')).toHaveLength(384);
    } finally {
      // Release the native session, failed assertions included.
      await service.close();
    }
  });
});

// Node's ESM loader puts a CommonJS module's exports on `default`; tsx's (which runs
// `pnpm reembed:kg`) follows the package's __esModule flag and leaves `default` undefined,
// with the names on the namespace. Vitest's interop hides the difference, so it is pinned
// here with stand-in namespaces.
describe('onnxRuntimeFrom', () => {
  type Namespace = Parameters<typeof import('../../../src/memory/embedding-onnx.js').onnxRuntimeFrom>[0];
  const runtime = { InferenceSession: { create: () => undefined }, Tensor: class {} };

  it('reads module.exports from default, as Node loads it', async () => {
    const { onnxRuntimeFrom } = await import('../../../src/memory/embedding-onnx.js');
    expect(onnxRuntimeFrom({ default: runtime } as unknown as Namespace)).toBe(runtime);
  });

  it('reads the namespace itself when default is undefined, as tsx loads it', async () => {
    const { onnxRuntimeFrom } = await import('../../../src/memory/embedding-onnx.js');
    const namespace = { ...runtime, default: undefined } as unknown as Namespace;
    expect(onnxRuntimeFrom(namespace)).toBe(namespace);
  });

  it('refuses a namespace with no InferenceSession rather than failing later on the first load', async () => {
    const { onnxRuntimeFrom } = await import('../../../src/memory/embedding-onnx.js');
    expect(() => onnxRuntimeFrom({ default: {} } as unknown as Namespace)).toThrow('InferenceSession');
  });
});
