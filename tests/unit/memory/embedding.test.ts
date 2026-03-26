import { describe, it, expect, beforeEach } from 'vitest';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { EMBEDDING_DIMENSIONS } from '../../../src/memory/types.js';

describe('EmbeddingService', () => {
  let service: EmbeddingService;

  beforeEach(() => {
    service = EmbeddingService.createForTesting();
  });

  it('generates an embedding vector of correct dimensions', async () => {
    const embedding = await service.embed('Hello world');
    expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it('returns numbers between -1 and 1', async () => {
    const embedding = await service.embed('test input');
    for (const val of embedding) {
      expect(val).toBeGreaterThanOrEqual(-1);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  it('returns different embeddings for different inputs', async () => {
    const e1 = await service.embed('cats');
    const e2 = await service.embed('quantum physics');
    expect(e1).not.toEqual(e2);
  });

  it('returns identical embedding for identical input (deterministic in test mode)', async () => {
    const e1 = await service.embed('same input');
    const e2 = await service.embed('same input');
    expect(e1).toEqual(e2);
  });

  it('computes cosine similarity between two embeddings', () => {
    const v = [1, 0, 0];
    expect(EmbeddingService.cosineSimilarity(v, v)).toBeCloseTo(1.0);

    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(EmbeddingService.cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });
});
