// Golden vectors for the bundled embedder: the in-process ONNX backend must reproduce the
// transformers.js pipeline the model evaluation (and so the profile's thresholds) used.
//
// tests/fixtures/embedding-golden/minilm-l6.json was made once, outside the repo, with
// @huggingface/transformers 4.3.2: pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2',
// { dtype: 'q8' }), pooling 'mean', normalize true, from weights whose sha256 matches the
// manifest, on arm64 macOS. Regenerate it only when the pinned weights change.
//
// The tolerance is DRIFT_SAME_MIN, the cutoff the drift check uses for "same weights", not
// an exact match: the q8 model's int8 kernels differ by CPU architecture, so the same
// weights and code give slightly different vectors on x86_64 (CI measured a minimum cosine
// of 0.9973 against this arm64-made fixture). A real backend fault (wrong pooling, a
// tokenizer mismatch) lands far below that.
//
// No database: this lives under integration because it loads the real model. Locally it
// skips without the weights; in CI, which runs `pnpm fetch:embedder` first, it never skips.

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { BUNDLED_WEIGHTS_FILE, hashBundledWeights } from '../../src/memory/embedding-onnx.js';
import { loadEmbedderManifest, verifyEmbedderFiles } from '../../src/memory/embedder-manifest.js';
import { ALL_MINILM_L6_V2 } from '../../src/memory/embedding-profiles.js';
import { DRIFT_SAME_MIN } from '../../src/memory/embedding-drift.js';
import { createSilentLogger } from '../../src/logger.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EMBEDDING_DIR = path.join(ROOT, 'models/embedding');
const MODEL_DIR = path.join(EMBEDDING_DIR, 'all-MiniLM-L6-v2');
const weightsPresent = [BUNDLED_WEIGHTS_FILE, 'tokenizer.json', 'tokenizer_config.json']
  .every(f => existsSync(path.join(MODEL_DIR, f)));

interface GoldenFixture {
  vectors: Array<{ text: string; vector: number[] }>;
}
const golden = JSON.parse(
  readFileSync(path.join(ROOT, 'tests/fixtures/embedding-golden/minilm-l6.json'), 'utf8'),
) as GoldenFixture;

describe.skipIf(!weightsPresent && !process.env.CI)('bundled embedder golden vectors', () => {
  let service: EmbeddingService;

  beforeAll(async () => {
    if (!weightsPresent) {
      throw new Error(`Bundled embedder weights missing from ${MODEL_DIR} in CI. Run \`pnpm fetch:embedder\` before the tests.`);
    }
    const logger = createSilentLogger();
    const weightsSha256 = await hashBundledWeights(MODEL_DIR, logger);
    service = await EmbeddingService.createBundled(MODEL_DIR, { ...ALL_MINILM_L6_V2, weightsSha256 }, logger);
  });

  // A mismatch below then means the backend drifted, not that other weights were fetched.
  it('runs against the pinned files', async () => {
    expect(await verifyEmbedderFiles(EMBEDDING_DIR, loadEmbedderManifest(path.join(EMBEDDING_DIR, 'manifest.json'))))
      .toEqual({ ok: true });
  });

  it.each(golden.vectors.map(g => [g.text, g.vector] as const))(
    'reproduces the pipeline vector for %j',
    async (text, expected) => {
      const actual = await service.embed(text, 'similarity');
      expect(actual).toHaveLength(expected.length);
      expect(EmbeddingService.cosineSimilarity(actual, expected)).toBeGreaterThanOrEqual(DRIFT_SAME_MIN);
    },
  );
});
