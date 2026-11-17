// Integration test — the bundled embedding model as the default source, and the deprecated
// OpenAI compatibility rule, through the shared boot gate against a live Postgres (#2023,
// design §1). Runs in a scratch database because the gate resizes kg_nodes.embedding.
// Skips without DATABASE_URL.
//
// The bundled path loads the real weights from models/embedding/ (`pnpm fetch:embedder`).
// Locally it also skips without them; in CI, which runs `pnpm fetch:embedder` first, it never
// skips for missing weights (beforeAll fails loudly instead), as the golden test does.
// No endpoint is ever called: the createService seam swaps the fake backend in for any
// endpoint source, and records which source the gate chose.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import pino from 'pino';
import { createScratchDatabase, type ScratchDatabase } from './scratch-database.js';
import { createSilentLogger } from '../../src/logger.js';
import { EmbeddingService, type EmbeddingConfig, type EmbeddingSource } from '../../src/memory/embedding.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import {
  ALL_MINILM_L6_V2,
  OPENAI_TEXT_EMBEDDING_3_SMALL,
  QWEN3_EMBEDDING_4B,
  embeddingStamp,
  type EmbeddingProfile,
} from '../../src/memory/embedding-profiles.js';
import { readEmbeddingSchema, resizeEmbeddingColumn, resolveKnowledgeGraphEmbedding } from '../../src/memory/embedding-schema.js';
import { reembedKnowledgeGraph } from '../../src/memory/reembed.js';
import { BUNDLED_WEIGHTS_FILE, hashBundledWeights } from '../../src/memory/embedding-onnx.js';
import { MemoryStoreHandler } from '../../skills/memory/tools/memory-store/handler.js';
import { MemoryQueryHandler } from '../../skills/memory/tools/memory-query/handler.js';
import type { ToolContext } from '../../src/skills/types.js';

const DATABASE_URL = process.env.DATABASE_URL;
const logger = createSilentLogger();

const MODEL_DIR = path.resolve(import.meta.dirname, '../../models/embedding/all-MiniLM-L6-v2');
const weightsPresent = [BUNDLED_WEIGHTS_FILE, 'tokenizer.json', 'tokenizer_config.json']
  .every(f => existsSync(path.join(MODEL_DIR, f)));
// Needs the database always, and the weights except in CI (where their absence must fail).
const describeIf = DATABASE_URL && (weightsPresent || process.env.CI) ? describe : describe.skip;
/** Every node this suite writes carries this source, so cleanup deletes only those rows. */
const SOURCE = 'kg-bundled-test';
const OPENAI = OPENAI_TEXT_EMBEDDING_3_SMALL;

function spyLogger() {
  return Object.assign(createSilentLogger(), { warn: vi.fn(), error: vi.fn() });
}

/** No embedding settings at all: the default `.env`. */
const NOTHING_SET: EmbeddingConfig = {
  embeddingBaseUrl: undefined,
  embeddingModel: undefined,
  embeddingApiKey: undefined,
  openaiApiKey: undefined,
  embeddingModelDir: MODEL_DIR,
};

describeIf('bundled embedding model as the default source', () => {
  let scratch: ScratchDatabase;
  let pool: pg.Pool;
  let created: EmbeddingSource[];
  // Every real service a test makes; afterEach releases their native ONNX sessions.
  let services: EmbeddingService[] = [];
  const track = (service: EmbeddingService): EmbeddingService => {
    services.push(service);
    return service;
  };

  // The fake backend for every endpoint, the real one for the bundled model.
  const createService: typeof EmbeddingService.create = async (source, profile, ...rest) => {
    created.push(source);
    return source.kind === 'endpoint'
      ? EmbeddingService.createForTesting(profile)
      : track(await EmbeddingService.create(source, profile, ...rest));
  };

  async function seedNodes(profile: EmbeddingProfile, labels: string[]): Promise<void> {
    const store = KnowledgeGraphStore.createWithPostgres(pool, EmbeddingService.createForTesting(profile), logger);
    for (const label of labels) await store.createNode({ type: 'concept', label, properties: {}, source: SOURCE });
  }

  function ctx(entityMemory: EntityMemory, input: Record<string, unknown>): ToolContext {
    return { input, secret: () => undefined, log: pino({ level: 'silent' }), entityMemory } as unknown as ToolContext;
  }

  beforeAll(async () => {
    if (!weightsPresent) {
      throw new Error(`Bundled embedder weights missing from ${MODEL_DIR} in CI. Run \`pnpm fetch:embedder\` before the tests.`);
    }
    scratch = await createScratchDatabase(DATABASE_URL!, 'kgbundled');
    pool = new pg.Pool({ connectionString: scratch.url });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await scratch?.drop();
  });

  // Runs when an assertion fails too. close() never throws.
  afterEach(async () => {
    await Promise.all(services.map(s => s.close()));
    services = [];
  });

  beforeEach(async () => {
    created = [];
    // The scratch database holds only this suite's rows. Edges cascade from their nodes.
    // Re-embed runs are left alone: the one test that opens a run finishes it, and only
    // an unfinished run affects the gate.
    await pool.query('DELETE FROM kg_nodes WHERE source = $1', [SOURCE]);
    // Migration 004's width: what an install upgraded from the OpenAI default has.
    const client = await pool.connect();
    try {
      await resizeEmbeddingColumn(client, OPENAI.dimensions);
    } finally {
      client.release();
    }
  });

  it('runs a fresh install on the bundled model: column resized to 384, and memory-store/memory-query round-trip', async () => {
    const result = await resolveKnowledgeGraphEmbedding(pool, NOTHING_SET, undefined, logger, {}, { createService });
    if (!result.ok) throw new Error(`expected ok, got ${result.message}`);

    expect(result.source).toEqual({ kind: 'bundled', modelDir: MODEL_DIR });
    expect(result.deprecation).toBeUndefined();
    expect(result.profile.weightsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await readEmbeddingSchema(pool)).columnDimensions).toBe(ALL_MINILM_L6_V2.dimensions);

    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, result.service, logger);
    const entityMemory = new EntityMemory(kgStore, new MemoryValidator(kgStore, result.service), result.service, logger);
    const stored = await new MemoryStoreHandler().execute(ctx(entityMemory, {
      entity: 'Juniper Street Bakery',
      entity_type: 'organization',
      field: 'opening_hours',
      value: 'Opens at seven every weekday morning',
      source: SOURCE,
    }));
    expect(stored).toMatchObject({ success: true });

    const queried = await new MemoryQueryHandler().execute(ctx(entityMemory, { query: 'when does the bakery open' }));
    expect(queried.success).toBe(true);
    const labels = (queried as { success: true; data: { results: Array<{ label: string }> } }).data.results.map(r => r.label);
    expect(labels.some(l => l.includes('Opens at seven every weekday morning'))).toBe(true);

    // Every vector carries the bundled stamp, weights hash included.
    expect(Object.keys((await readEmbeddingSchema(pool)).vectorsByModel)).toEqual([embeddingStamp(result.profile)]);
  }, 30_000);

  it('keeps an install whose graph holds OpenAI vectors on OpenAI, logging the deprecation with both ways forward', async () => {
    await seedNodes(OPENAI, ['a', 'b']);
    const bootLogger = spyLogger();

    const result = await resolveKnowledgeGraphEmbedding(
      pool, { ...NOTHING_SET, openaiApiKey: 'sk-vault-test' }, undefined, bootLogger, {}, { createService },
    );

    expect(result).toMatchObject({
      ok: true,
      source: { kind: 'endpoint', endpoint: { baseUrl: 'https://api.openai.com/v1', model: OPENAI.model, apiKey: 'sk-vault-test' } },
      profile: OPENAI,
      deprecation: 'implicit_openai',
    });
    expect(created).toEqual([expect.objectContaining({ kind: 'endpoint' })]);
    expect(bootLogger.warn).toHaveBeenCalledOnce();
    const warning = String(bootLogger.warn.mock.calls[0]!.at(-1));
    expect(warning).toContain('EMBEDDING_BASE_URL=https://api.openai.com/v1');
    expect(warning).toContain('embedding_api_key');
    expect(warning).toContain('EMBEDDING_MODEL=all-MiniLM-L6-v2 and run pnpm reembed:kg');
    // The stored vectors were left alone.
    expect((await readEmbeddingSchema(pool)).columnDimensions).toBe(OPENAI.dimensions);
  });

  it('runs the same graph on OpenAI configured explicitly, with no deprecation and no re-embed', async () => {
    await seedNodes(OPENAI, ['a', 'b']);
    const bootLogger = spyLogger();

    const result = await resolveKnowledgeGraphEmbedding(
      pool,
      {
        ...NOTHING_SET,
        embeddingBaseUrl: 'https://api.openai.com/v1',
        embeddingModel: OPENAI.model,
        embeddingApiKey: 'sk-embedding-test',
        openaiApiKey: 'sk-vault-test',
      },
      undefined,
      bootLogger,
      {},
      { createService },
    );

    expect(result).toMatchObject({
      ok: true,
      source: { kind: 'endpoint', endpoint: { apiKey: 'sk-embedding-test' } },
      profile: OPENAI,
    });
    expect(result.ok && result.deprecation).toBeUndefined();
    expect(bootLogger.warn).not.toHaveBeenCalled();
  });

  it('never switches a graph of another model\'s vectors to the bundled model', async () => {
    await seedNodes(QWEN3_EMBEDDING_4B, ['a']);

    const result = await resolveKnowledgeGraphEmbedding(pool, NOTHING_SET, undefined, logger, {}, { createService });

    expect(result).toMatchObject({
      ok: false, gate: 'config', reason: 'stored_model_without_endpoint', storedModel: 'Qwen3-Embedding-4B',
    });
    expect(result.ok === false && result.message).toContain('Qwen3-Embedding-4B');
    expect(created).toEqual([]);
    expect((await readEmbeddingSchema(pool)).columnDimensions).toBe(QWEN3_EMBEDDING_4B.dimensions);
  });

  it('holds an OpenAI graph off after the switch to the bundled model until pnpm reembed:kg runs', async () => {
    await seedNodes(OPENAI, ['a', 'b']);
    const config = { ...NOTHING_SET, embeddingModel: 'all-MiniLM-L6-v2', openaiApiKey: 'sk-vault-test' };

    const before = await resolveKnowledgeGraphEmbedding(pool, config, undefined, logger, {}, { createService });
    // The widths differ (1536 against 384), so the gate reports the width before the model.
    expect(before).toMatchObject({ ok: false, gate: 'schema', state: { status: 'off', reason: 'width_mismatch' } });
    expect(created).toEqual([]);

    // What `pnpm reembed:kg` does with the same settings.
    const service = track(await EmbeddingService.create(
      { kind: 'bundled', modelDir: MODEL_DIR },
      { ...ALL_MINILM_L6_V2, weightsSha256: await hashBundledWeights(MODEL_DIR, logger) },
      logger,
    ));
    expect(await reembedKnowledgeGraph({ pool, embeddingService: service, logger, dryRun: false })).toMatchObject({ status: 'done' });

    const after = await resolveKnowledgeGraphEmbedding(pool, config, undefined, logger, {}, { createService });
    expect(after).toMatchObject({ ok: true, source: { kind: 'bundled' } });
  }, 30_000);

  describe('a bundled model that will not load turns the knowledge graph off, never the boot', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'kg-bundled-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('names pnpm fetch:embedder when the weights are missing, and leaves the table alone', async () => {
      const result = await resolveKnowledgeGraphEmbedding(
        pool, { ...NOTHING_SET, embeddingModelDir: dir }, undefined, logger, {}, { createService },
      );

      expect(result).toMatchObject({ ok: false, gate: 'bundled', reason: 'bundled_weights_missing' });
      expect(result.ok === false && result.message).toContain('pnpm fetch:embedder');
      expect((await readEmbeddingSchema(pool)).columnDimensions).toBe(OPENAI.dimensions);
    });

    it('reports a weight file that is there but will not load', async () => {
      await copyFile(path.join(MODEL_DIR, 'tokenizer.json'), path.join(dir, 'tokenizer.json'));
      await copyFile(path.join(MODEL_DIR, 'tokenizer_config.json'), path.join(dir, 'tokenizer_config.json'));
      await writeFile(path.join(dir, 'model_quantized.onnx'), 'not an onnx model');

      const result = await resolveKnowledgeGraphEmbedding(
        pool, { ...NOTHING_SET, embeddingModelDir: dir }, undefined, logger, {}, { createService },
      );

      expect(result).toMatchObject({ ok: false, gate: 'bundled', reason: 'bundled_load_failed' });
      expect(result.ok === false && result.message).toContain('model_quantized.onnx');
    });

    it('reports an operator profile for the bundled model that has no pooling (no base:)', async () => {
      // What parseEmbeddingProfiles makes of an entry with no base: every field but pooling.
      const noPooling: EmbeddingProfile = { ...ALL_MINILM_L6_V2, pooling: undefined };

      const result = await resolveKnowledgeGraphEmbedding(
        pool, NOTHING_SET, { 'all-MiniLM-L6-v2': noPooling }, logger, {}, { createService },
      );

      expect(result).toMatchObject({ ok: false, gate: 'bundled', reason: 'bundled_load_failed' });
      expect(result.ok === false && result.message).toContain('pooling');
    });
  });
});
