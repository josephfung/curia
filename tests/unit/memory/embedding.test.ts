import { describe, it, expect, beforeEach } from 'vitest';
import {
  EmbeddingService,
  describeEmbeddingUnavailable,
  resolveEmbedding,
  stampModel,
  type EmbeddingResolution,
  type StoredEmbeddingState,
} from '../../../src/memory/embedding.js';
import {
  ALL_MINILM_L6_V2,
  OPENAI_TEXT_EMBEDDING_3_SMALL,
  embeddingStamp,
  type EmbeddingProfile,
} from '../../../src/memory/embedding-profiles.js';

describe('EmbeddingService', () => {
  let service: EmbeddingService;

  beforeEach(() => {
    service = EmbeddingService.createForTesting();
  });

  it('generates an embedding vector of correct dimensions', async () => {
    const embedding = await service.embed('Hello world', 'document');
    expect(embedding).toHaveLength(OPENAI_TEXT_EMBEDDING_3_SMALL.dimensions);
  });

  it('returns numbers between -1 and 1', async () => {
    const embedding = await service.embed('test input', 'document');
    for (const val of embedding) {
      expect(val).toBeGreaterThanOrEqual(-1);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  it('returns different embeddings for different inputs', async () => {
    const e1 = await service.embed('cats', 'document');
    const e2 = await service.embed('quantum physics', 'document');
    expect(e1).not.toEqual(e2);
  });

  it('returns identical embedding for identical input (deterministic in test mode)', async () => {
    const e1 = await service.embed('same input', 'document');
    const e2 = await service.embed('same input', 'document');
    expect(e1).toEqual(e2);
  });

  it('computes cosine similarity between two embeddings', () => {
    const v = [1, 0, 0];
    expect(EmbeddingService.cosineSimilarity(v, v)).toBeCloseTo(1.0);

    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(EmbeddingService.cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it('takes its width from the profile', async () => {
    const narrow: EmbeddingProfile = { ...OPENAI_TEXT_EMBEDDING_3_SMALL, model: 'narrow', dimensions: 8 };
    const embedding = await EmbeddingService.createForTesting(narrow).embed('x', 'document');
    expect(embedding).toHaveLength(8);
  });

  it('puts the profile prefix for the purpose in front of the text', async () => {
    const prefixed: EmbeddingProfile = {
      ...OPENAI_TEXT_EMBEDDING_3_SMALL,
      model: 'prefixed',
      prefixes: { query: 'Q: ', document: '', similarity: '' },
    };
    const prefixedService = EmbeddingService.createForTesting(prefixed);
    // The fake backend is a pure function of its input, so equal vectors mean equal text.
    expect(await prefixedService.embed('cats', 'query')).toEqual(await prefixedService.embed('Q: cats', 'document'));
    expect(await prefixedService.embed('cats', 'similarity')).toEqual(await prefixedService.embed('cats', 'document'));
  });
});

// Design §1 ("Model resolution"): one branch per case. resolveEmbedding is pure over the
// stored state, so each case is a config and a set of stamps, with no database.
describe('resolveEmbedding', () => {
  const MODEL_DIR = '/opt/curia/models/embedding/all-MiniLM-L6-v2';
  const nothingSet = {
    embeddingBaseUrl: undefined,
    embeddingModel: undefined,
    embeddingApiKey: undefined,
    openaiApiKey: undefined,
    embeddingModelDir: MODEL_DIR,
  };
  const empty: StoredEmbeddingState = { stamps: [] };
  const storedOpenAI: StoredEmbeddingState = { stamps: ['text-embedding-3-small'] };
  const OPENAI_COMPAT: EmbeddingResolution = {
    ok: true,
    source: {
      kind: 'endpoint',
      endpoint: { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', apiKey: 'sk-vault' },
    },
    profile: OPENAI_TEXT_EMBEDDING_3_SMALL,
    deprecation: 'implicit_openai',
  };
  const BUNDLED: EmbeddingResolution = {
    ok: true,
    source: { kind: 'bundled', modelDir: MODEL_DIR },
    profile: ALL_MINILM_L6_V2,
  };

  function failure(resolution: EmbeddingResolution): Exclude<EmbeddingResolution, { ok: true }> {
    if (resolution.ok) throw new Error(`expected the knowledge graph off, got ${JSON.stringify(resolution)}`);
    return resolution;
  }

  it('uses the configured endpoint with the embedding key', () => {
    expect(resolveEmbedding(
      { ...nothingSet, embeddingBaseUrl: 'http://embed.local/v1/', embeddingModel: 'Qwen3-Embedding-4B', embeddingApiKey: 'ek' },
      undefined,
      empty,
    )).toMatchObject({
      ok: true,
      source: { kind: 'endpoint', endpoint: { baseUrl: 'http://embed.local/v1', model: 'Qwen3-Embedding-4B', apiKey: 'ek' } },
      profile: { model: 'Qwen3-Embedding-4B' },
    });
  });

  it('treats OpenAI as an ordinary endpoint: embedding_api_key, never openai_api_key, and no deprecation', () => {
    const resolution = resolveEmbedding(
      {
        ...nothingSet,
        embeddingBaseUrl: 'https://api.openai.com/v1',
        embeddingModel: 'text-embedding-3-small',
        openaiApiKey: 'sk-vault',
      },
      undefined,
      storedOpenAI,
    );
    expect(resolution).toEqual({
      ok: true,
      source: { kind: 'endpoint', endpoint: { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', apiKey: undefined } },
      profile: OPENAI_TEXT_EMBEDDING_3_SMALL,
    });
  });

  it('turns the knowledge graph off for a base URL without a model', () => {
    const resolution = failure(resolveEmbedding({ ...nothingSet, embeddingBaseUrl: 'http://embed.local/v1' }, undefined, empty));
    expect(resolution).toEqual({ ok: false, reason: 'no_model' });
    expect(describeEmbeddingUnavailable(resolution)).toContain('EMBEDDING_MODEL');
  });

  it('defaults to the bundled model on an empty graph', () => {
    expect(resolveEmbedding(nothingSet, undefined, empty)).toEqual(BUNDLED);
  });

  it('defaults to the bundled model on an empty graph even with an OpenAI key in the vault', () => {
    expect(resolveEmbedding({ ...nothingSet, openaiApiKey: 'sk-vault' }, undefined, empty)).toEqual(BUNDLED);
  });

  it('keeps an install whose graph holds OpenAI vectors on OpenAI, deprecated', () => {
    expect(resolveEmbedding({ ...nothingSet, openaiApiKey: 'sk-vault' }, undefined, storedOpenAI)).toEqual(OPENAI_COMPAT);
  });

  it('applies the compatibility rule when EMBEDDING_MODEL names OpenAI without a base URL', () => {
    expect(resolveEmbedding(
      { ...nothingSet, embeddingModel: 'text-embedding-3-small', openaiApiKey: 'sk-vault' },
      undefined,
      storedOpenAI,
    )).toEqual(OPENAI_COMPAT);
  });

  it('turns the knowledge graph off when the compatibility rule applies but the vault has no OpenAI key', () => {
    const resolution = failure(resolveEmbedding(nothingSet, undefined, storedOpenAI));
    expect(resolution).toEqual({ ok: false, reason: 'implicit_openai_without_key' });
    const message = describeEmbeddingUnavailable(resolution);
    expect(message).toContain('openai_api_key');
    expect(message).toContain('EMBEDDING_BASE_URL=https://api.openai.com/v1');
  });

  it('counts an unfinished re-embed toward OpenAI as OpenAI vectors', () => {
    expect(resolveEmbedding(
      { ...nothingSet, openaiApiKey: 'sk-vault' },
      undefined,
      { stamps: [], openRunTarget: 'text-embedding-3-small' },
    )).toEqual(OPENAI_COMPAT);
  });

  it('never switches a graph holding another model\'s vectors to the bundled model (Review Focus 1)', () => {
    const resolution = failure(resolveEmbedding(
      { ...nothingSet, openaiApiKey: 'sk-vault' },
      undefined,
      { stamps: ['Qwen3-Embedding-4B'] },
    ));
    expect(resolution).toEqual({ ok: false, reason: 'stored_model_without_endpoint', storedModel: 'Qwen3-Embedding-4B' });
    const message = describeEmbeddingUnavailable(resolution);
    expect(message).toContain('restore EMBEDDING_BASE_URL/EMBEDDING_MODEL for Qwen3-Embedding-4B');
    expect(message).toContain('set EMBEDDING_MODEL=all-MiniLM-L6-v2 and run pnpm reembed:kg');
  });

  it('reads a stamp with a document-prefix hash as its model', () => {
    const resolution = failure(resolveEmbedding(
      nothingSet,
      undefined,
      { stamps: ['Qwen3-Embedding-4B#document:0123456789ab'] },
    ));
    expect(resolution).toMatchObject({ reason: 'stored_model_without_endpoint', storedModel: 'Qwen3-Embedding-4B' });
  });

  it('counts an unfinished re-embed toward another model, so a cleared graph never looks fresh', () => {
    expect(resolveEmbedding(nothingSet, undefined, { stamps: [], openRunTarget: 'Qwen3-Embedding-4B' }))
      .toMatchObject({ ok: false, reason: 'stored_model_without_endpoint', storedModel: 'Qwen3-Embedding-4B' });
  });

  it('takes EMBEDDING_MODEL naming the bundled model as the switch signal, whatever the graph holds', () => {
    expect(resolveEmbedding(
      { ...nothingSet, embeddingModel: 'all-MiniLM-L6-v2', openaiApiKey: 'sk-vault' },
      undefined,
      storedOpenAI,
    )).toEqual(BUNDLED);
  });

  it('turns the knowledge graph off for a non-bundled model without a base URL', () => {
    const resolution = failure(resolveEmbedding({ ...nothingSet, embeddingModel: 'nomic-embed-text' }, undefined, empty));
    expect(resolution).toEqual({ ok: false, reason: 'non_bundled_model_without_base_url', model: 'nomic-embed-text' });
    expect(describeEmbeddingUnavailable(resolution)).toContain('a non-bundled model needs EMBEDDING_BASE_URL');
  });

  it('does not take the compatibility rule on an empty graph when EMBEDDING_MODEL names OpenAI', () => {
    expect(resolveEmbedding(
      { ...nothingSet, embeddingModel: 'text-embedding-3-small', openaiApiKey: 'sk-vault' },
      undefined,
      empty,
    )).toEqual({ ok: false, reason: 'non_bundled_model_without_base_url', model: 'text-embedding-3-small' });
  });

  it('keeps a graph of bundled vectors on the bundled model', () => {
    expect(resolveEmbedding(
      { ...nothingSet, openaiApiKey: 'sk-vault' },
      undefined,
      { stamps: ['all-MiniLM-L6-v2#weights:afdb6f1a0e45'] },
    )).toEqual(BUNDLED);
  });

  it('serves MiniLM through an endpoint with its thresholds and pooling but no weights hash (design §3)', () => {
    const resolution = resolveEmbedding(
      { ...nothingSet, embeddingBaseUrl: 'http://ollama.local/v1', embeddingModel: 'all-MiniLM-L6-v2' },
      undefined,
      empty,
    );
    expect(resolution).toMatchObject({
      ok: true,
      source: { kind: 'endpoint', endpoint: { baseUrl: 'http://ollama.local/v1', model: 'all-MiniLM-L6-v2' } },
      profile: { thresholds: ALL_MINILM_L6_V2.thresholds, pooling: 'mean' },
    });
    if (!resolution.ok) throw new Error('expected ok');
    expect(resolution.profile.weightsSha256).toBeUndefined();
    expect(embeddingStamp(resolution.profile)).toBe('all-MiniLM-L6-v2');
  });

  it('turns the knowledge graph off for an endpoint model with no profile, naming the model', () => {
    expect(resolveEmbedding(
      { ...nothingSet, embeddingBaseUrl: 'http://embed.local/v1', embeddingModel: 'unprofiled' },
      undefined,
      empty,
    )).toEqual({ ok: false, reason: 'no_profile', model: 'unprofiled' });
  });

  it('uses an operator profile for an endpoint model the built-in table lacks', () => {
    const custom: EmbeddingProfile = { ...OPENAI_TEXT_EMBEDDING_3_SMALL, model: 'custom', dimensions: 1024 };
    const resolution = resolveEmbedding(
      { ...nothingSet, embeddingBaseUrl: 'http://embed.local/v1', embeddingModel: 'custom' },
      { custom },
      empty,
    );
    expect(resolution.ok && resolution.profile).toBe(custom);
  });

  it('uses an operator override of the bundled profile', () => {
    const override: EmbeddingProfile = { ...ALL_MINILM_L6_V2, thresholds: { ...ALL_MINILM_L6_V2.thresholds, fuzzyResolve: 0.97 } };
    const resolution = resolveEmbedding(nothingSet, { 'all-MiniLM-L6-v2': override }, empty);
    expect(resolution.ok && resolution.profile).toBe(override);
  });
});

describe('stampModel', () => {
  it('is the part of a stamp before the first #', () => {
    expect(stampModel('all-MiniLM-L6-v2#weights:afdb6f1a0e45')).toBe('all-MiniLM-L6-v2');
    expect(stampModel('m#document:0123456789ab#weights:afdb6f1a0e45')).toBe('m');
    expect(stampModel('text-embedding-3-small')).toBe('text-embedding-3-small');
  });
});
