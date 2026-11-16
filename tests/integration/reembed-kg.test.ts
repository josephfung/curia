// Integration test — the embedding schema gate, the re-embed command and the instance lock
// against a live Postgres (#2023, ADR-051). Runs in a scratch database because it resizes
// kg_nodes.embedding, which would break the other files sharing curia_test. Skips without
// DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import pg from 'pg';
import { createScratchDatabase, type ScratchDatabase } from './scratch-database.js';
import { createSilentLogger } from '../../src/logger.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { OPENAI_TEXT_EMBEDDING_3_SMALL, embeddingStamp, type EmbeddingProfile } from '../../src/memory/embedding-profiles.js';
import {
  checkEmbeddingSchema,
  readEmbeddingSchema,
  resizeEmbeddingColumn,
  resolveKnowledgeGraphEmbedding,
} from '../../src/memory/embedding-schema.js';
import { reembedKnowledgeGraph } from '../../src/memory/reembed.js';
import {
  INSTANCE_LOCK_KEYS,
  REEMBED_APPLICATION_NAME,
  findInstanceLockHolder,
  holdInstanceLock,
} from '../../src/db/instance-lock.js';
import { loadConfig, loadYamlConfig } from '../../src/config.js';
import { createTestModeStack } from '../../src/startup/test-mode-stack.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const logger = createSilentLogger();

function spyLogger() {
  const spy = createSilentLogger();
  return Object.assign(spy, { warn: vi.fn(), error: vi.fn() });
}

const OPENAI = OPENAI_TEXT_EMBEDDING_3_SMALL;
const NARROW: EmbeddingProfile = { ...OPENAI, model: 'test-narrow-768', dimensions: 768 };
const SAME_WIDTH_OTHER_MODEL: EmbeddingProfile = { ...OPENAI, model: 'test-other-1536' };
// Same model name and width, different document prefix: stored vectors differ in what was embedded.
const withDocumentPrefix = (document: string): EmbeddingProfile => ({ ...OPENAI, prefixes: { ...OPENAI.prefixes, document } });
const PASSAGE = withDocumentPrefix('passage: ');
const PASSAGE_CHANGED = withDocumentPrefix('search_document: ');

describeIf('embedding schema gate, re-embed command and instance lock', () => {
  let scratch: ScratchDatabase;
  let pool: pg.Pool;

  async function seedNodes(profile: EmbeddingProfile, labels: string[]): Promise<string[]> {
    const store = KnowledgeGraphStore.createWithPostgres(pool, EmbeddingService.createForTesting(profile), logger);
    const ids: string[] = [];
    for (const label of labels) {
      ids.push((await store.createNode({ type: 'concept', label, properties: {}, source: 'test' })).id);
    }
    return ids;
  }

  async function nodeStamps(): Promise<Array<{ model: string | null; dims: number | null }>> {
    const { rows } = await pool.query<{ model: string | null; dims: number | null }>(
      'SELECT embedding_model AS model, vector_dims(embedding) AS dims FROM kg_nodes ORDER BY label',
    );
    return rows;
  }

  async function runs(): Promise<Array<{ finished: boolean; target_model: string; rows_done: number; rows_total: number }>> {
    const { rows } = await pool.query<{ finished: boolean; target_model: string; rows_done: number; rows_total: number }>(
      'SELECT finished_at IS NOT NULL AS finished, target_model, rows_done, rows_total FROM kg_reembed_runs ORDER BY id',
    );
    return rows;
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase(DATABASE_URL!, 'reembed');
    pool = new pg.Pool({ connectionString: scratch.url });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await scratch?.drop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE kg_nodes CASCADE');
    await pool.query('TRUNCATE kg_reembed_runs');
    const client = await pool.connect();
    try {
      await resizeEmbeddingColumn(client, OPENAI.dimensions);
    } finally {
      client.release();
    }
  });

  describe('boot schema check', () => {
    it('is ok on a table stamped with the configured model', async () => {
      await seedNodes(OPENAI, ['a', 'b']);
      expect(await checkEmbeddingSchema(pool, OPENAI, logger)).toEqual({ status: 'ok' });
    });

    it('resizes an empty table and rebuilds the index', async () => {
      await pool.query("INSERT INTO kg_nodes (type, label, source) VALUES ('concept', 'never embedded', 'test')");

      expect(await checkEmbeddingSchema(pool, NARROW, logger)).toEqual({
        status: 'resized', fromDimensions: 1536, toDimensions: 768,
      });
      expect((await readEmbeddingSchema(pool)).columnDimensions).toBe(768);
      const { rows } = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_kg_nodes_embedding'");
      expect(rows).toHaveLength(1);
    });

    it('leaves a table holding vectors at another width alone and turns the KG off', async () => {
      await seedNodes(OPENAI, ['a']);

      expect(await checkEmbeddingSchema(pool, NARROW, logger)).toMatchObject({
        status: 'off', reason: 'width_mismatch', columnDimensions: 1536, profileDimensions: 768, vectorCount: 1,
      });
      expect((await readEmbeddingSchema(pool)).columnDimensions).toBe(1536);
    });

    it('turns the KG off on vectors from another model at the same width', async () => {
      await seedNodes(OPENAI, ['a', 'b']);

      expect(await checkEmbeddingSchema(pool, SAME_WIDTH_OTHER_MODEL, logger)).toMatchObject({
        status: 'off', reason: 'model_mismatch', otherModelVectors: 2,
      });
    });

    it('turns the KG off when the document prefix changed under the same model name', async () => {
      await seedNodes(PASSAGE, ['a', 'b']);
      expect(await checkEmbeddingSchema(pool, PASSAGE, logger)).toEqual({ status: 'ok' });

      expect(await checkEmbeddingSchema(pool, PASSAGE_CHANGED, logger)).toMatchObject({
        status: 'off', reason: 'model_mismatch', stamp: embeddingStamp(PASSAGE_CHANGED), otherModelVectors: 2,
      });
      // Going from no prefix to one is the same change.
      expect(await checkEmbeddingSchema(pool, OPENAI, logger)).toMatchObject({ status: 'off', reason: 'model_mismatch' });
    });

    it('turns the KG off on an open run even when every row looks complete', async () => {
      await seedNodes(OPENAI, ['a']);
      await pool.query("INSERT INTO kg_reembed_runs (target_model, target_dimensions) VALUES ($1, 1536)", [OPENAI.model]);

      expect(await checkEmbeddingSchema(pool, OPENAI, logger)).toMatchObject({ status: 'off', reason: 'open_run' });
    });
  });

  describe('shared knowledge-graph gate', () => {
    const endpointConfig = (model: string) => ({
      embeddingBaseUrl: 'http://embed.invalid/v1',
      embeddingModel: model,
      embeddingApiKey: undefined,
      openaiApiKey: undefined,
      embeddingModelDir: path.resolve(import.meta.dirname, '../../models/embedding/all-MiniLM-L6-v2'),
    });
    // The gate re-embeds stored labels through an endpoint (the drift check): serve the fake
    // backend that seeded them, so no call leaves the process and the weights match.
    const fakeEndpoint = { createService: async (_source: unknown, profile: EmbeddingProfile) => EmbeddingService.createForTesting(profile) };

    it('is usable when the endpoint resolves and the table matches its profile', async () => {
      await seedNodes(OPENAI, ['a']);
      const result = await resolveKnowledgeGraphEmbedding(pool, endpointConfig(OPENAI.model), undefined, logger, {}, fakeEndpoint);
      expect(result).toMatchObject({ ok: true, profile: OPENAI });
    });

    it('is off at the config gate, leaving the table alone, when the model has no profile', async () => {
      // Resolution reads the stored stamps first (design §1), so the table is read; the
      // config gate stops it before the schema check could resize anything.
      await pool.query("INSERT INTO kg_nodes (type, label, source) VALUES ('concept', 'never embedded', 'test')");
      const result = await resolveKnowledgeGraphEmbedding(pool, endpointConfig('unprofiled'), undefined, logger);
      expect(result).toMatchObject({ ok: false, gate: 'config', reason: 'no_profile', model: 'unprofiled' });
      expect(result.ok === false && result.message).toContain('unprofiled');
      expect((await readEmbeddingSchema(pool)).columnDimensions).toBe(OPENAI.dimensions);
    });

    it('is off at the schema gate when the stored vectors come from another model, naming the command', async () => {
      await seedNodes(OPENAI, ['a']);
      const result = await resolveKnowledgeGraphEmbedding(
        pool, endpointConfig(SAME_WIDTH_OTHER_MODEL.model), { [SAME_WIDTH_OTHER_MODEL.model]: SAME_WIDTH_OTHER_MODEL }, logger,
      );
      expect(result).toMatchObject({ ok: false, gate: 'schema', state: { reason: 'model_mismatch' } });
      expect(result.ok === false && result.message).toContain('Stop Curia, run pnpm reembed:kg, then start Curia');
      expect(result.ok === false && result.message).toContain('https://docs.meetcuria.com/integrations/embeddings-endpoint');
      expect(result.ok === false && result.message).not.toMatch(/docker (compose|stop)/);
    });

    describe('at boot, while another session holds the instance lock', () => {
      let holder: pg.Client | undefined;

      async function holdLockAs(applicationName: string): Promise<void> {
        holder = new pg.Client({ connectionString: scratch.url, application_name: applicationName });
        await holder.connect();
        await holder.query('SELECT pg_advisory_lock($1, $2)', [...INSTANCE_LOCK_KEYS]);
      }

      afterEach(async () => {
        await holder?.end();
        holder = undefined;
      });

      it('keeps entity memory off when the holder is the re-embed command, telling the operator to restart', async () => {
        await seedNodes(OPENAI, ['a']);
        await holdLockAs(REEMBED_APPLICATION_NAME);
        const bootLogger = spyLogger();

        const release = await holdInstanceLock(pool, bootLogger);
        const result = await resolveKnowledgeGraphEmbedding(pool, endpointConfig(OPENAI.model), undefined, bootLogger, {}, fakeEndpoint);
        await release();

        expect(result).toMatchObject({ ok: false, gate: 'schema', reason: 'reembed_in_progress' });
        expect(result.ok === false && result.message).toMatch(/pnpm reembed:kg is running.*"curia-reembed-kg".*Restart Curia when it finishes/);
      });

      it('only warns when the holder is anything else', async () => {
        await seedNodes(OPENAI, ['a']);
        await holdLockAs('curia');
        const bootLogger = spyLogger();

        const release = await holdInstanceLock(pool, bootLogger);
        const result = await resolveKnowledgeGraphEmbedding(pool, endpointConfig(OPENAI.model), undefined, bootLogger, {}, fakeEndpoint);
        await release();

        expect(bootLogger.warn).toHaveBeenCalledOnce();
        expect(bootLogger.warn.mock.calls[0]![1]).toMatch(/held by "curia".*Continuing without the lock/);
        expect(result).toMatchObject({ ok: true, profile: OPENAI });
      });
    });

    it('keeps entity memory off in the test-mode stack when the stored vectors come from another model', async () => {
      await seedNodes(OPENAI, ['a']);
      const yamlConfig = loadYamlConfig(path.resolve(import.meta.dirname, '../../config'));
      const stack = await createTestModeStack({
        config: { ...loadConfig(), databaseUrl: scratch.url, ...endpointConfig(SAME_WIDTH_OTHER_MODEL.model) },
        yamlConfig: { ...yamlConfig, embedding: { profiles: { [SAME_WIDTH_OTHER_MODEL.model]: SAME_WIDTH_OTHER_MODEL } } },
        llm: 'offline',
        enablement: 'all',
      });
      try {
        expect(stack.warnings).toContainEqual(expect.stringMatching(/^Entity memory is off: .*pnpm reembed:kg/));
      } finally {
        await stack.shutdown();
      }
    }, 120_000);
  });

  describe('re-embed command', () => {
    it('resizes, re-embeds every row (archived included) with the new model, and closes the run', async () => {
      const [, archivedId] = await seedNodes(OPENAI, ['a', 'b', 'c']);
      await pool.query('UPDATE kg_nodes SET archived_at = now() WHERE id = $1', [archivedId]);

      const result = await reembedKnowledgeGraph({
        pool, embeddingService: EmbeddingService.createForTesting(NARROW), logger, dryRun: false, batchSize: 2,
      });

      expect(result).toMatchObject({ status: 'done', rowsEmbedded: 3 });
      expect(await nodeStamps()).toEqual(Array(3).fill({ model: NARROW.model, dims: 768 }));
      expect(await runs()).toEqual([{ finished: true, target_model: NARROW.model, rows_done: 3, rows_total: 3 }]);
      expect(await checkEmbeddingSchema(pool, NARROW, logger)).toEqual({ status: 'ok' });
    });

    it('re-embeds rows made under another document prefix of the same model, without a resize', async () => {
      await seedNodes(PASSAGE, ['a', 'b', 'c']);

      const result = await reembedKnowledgeGraph({
        pool, embeddingService: EmbeddingService.createForTesting(PASSAGE_CHANGED), logger, dryRun: false,
      });

      expect(result).toMatchObject({ status: 'done', rowsEmbedded: 3 });
      expect(await nodeStamps()).toEqual(Array(3).fill({ model: embeddingStamp(PASSAGE_CHANGED), dims: 1536 }));
      expect(await runs()).toEqual([
        { finished: true, target_model: embeddingStamp(PASSAGE_CHANGED), rows_done: 3, rows_total: 3 },
      ]);
      // The stored vector is the label embedded as a document, prefix included.
      const documentVector = await EmbeddingService.createForTesting(PASSAGE_CHANGED).embed('a', 'document');
      const { rows } = await pool.query<{ distance: number }>(
        "SELECT embedding <=> $1::vector AS distance FROM kg_nodes WHERE label = 'a'",
        [`[${documentVector.join(',')}]`],
      );
      expect(rows[0]!.distance).toBeLessThan(1e-6);
      expect(await checkEmbeddingSchema(pool, PASSAGE_CHANGED, logger)).toEqual({ status: 'ok' });
    });

    it('changes nothing and opens no run on --dry-run', async () => {
      await seedNodes(OPENAI, ['a', 'b']);

      const result = await reembedKnowledgeGraph({
        pool, embeddingService: EmbeddingService.createForTesting(NARROW), logger, dryRun: true,
      });

      expect(result).toMatchObject({ status: 'dry_run', widthChanges: true, rowsToEmbed: 2 });
      expect(await nodeStamps()).toEqual(Array(2).fill({ model: OPENAI.model, dims: 1536 }));
      expect(await runs()).toEqual([]);
    });

    it('leaves an interrupted run open, so boot refuses, and a rerun finishes it', async () => {
      await seedNodes(OPENAI, ['a', 'b', 'c', 'd', 'e']);
      const embeddingService = EmbeddingService.createForTesting(NARROW);
      const realEmbed = embeddingService.embed.bind(embeddingService);
      let calls = 0;
      // Fails on the second row of the second batch, so one row of that batch is already written.
      const spy = vi.spyOn(embeddingService, 'embed').mockImplementation(async (text, purpose) => {
        calls += 1;
        if (calls > 3) throw new Error('endpoint went away');
        return realEmbed(text, purpose);
      });

      await expect(reembedKnowledgeGraph({ pool, embeddingService, logger, dryRun: false, batchSize: 2 }))
        .rejects.toThrow('endpoint went away');
      expect(await runs()).toEqual([{ finished: false, target_model: NARROW.model, rows_done: 3, rows_total: 5 }]);
      // Every row now holds a NARROW vector or none, so only the run record can say it is unfinished.
      expect(await checkEmbeddingSchema(pool, NARROW, logger)).toMatchObject({ status: 'off', reason: 'open_run' });

      spy.mockRestore();
      const rerun = await reembedKnowledgeGraph({ pool, embeddingService, logger, dryRun: false, batchSize: 2 });

      expect(rerun).toMatchObject({ status: 'done', rowsEmbedded: 2 });
      expect(await runs()).toEqual([{ finished: true, target_model: NARROW.model, rows_done: 5, rows_total: 5 }]);
      expect(await nodeStamps()).toEqual(Array(5).fill({ model: NARROW.model, dims: 768 }));
      expect(await checkEmbeddingSchema(pool, NARROW, logger)).toEqual({ status: 'ok' });
    });

    describe('--force', () => {
      it('re-embeds nothing without force when every row already carries the stamp', async () => {
        await seedNodes(OPENAI, ['a', 'b', 'c']);

        const result = await reembedKnowledgeGraph({
          pool, embeddingService: EmbeddingService.createForTesting(OPENAI), logger, dryRun: false,
        });

        expect(result).toMatchObject({ status: 'done', rowsEmbedded: 0 });
      });

      it('rewrites every vector under a matching stamp, with no resize, and closes the run', async () => {
        await seedNodes(OPENAI, ['a', 'b', 'c']);
        // Plant a sentinel vector under the matching stamp so a rewrite is observable.
        await pool.query("UPDATE kg_nodes SET embedding = array_fill(0.5::real, ARRAY[1536])::vector");

        const result = await reembedKnowledgeGraph({
          pool, embeddingService: EmbeddingService.createForTesting(OPENAI), logger, dryRun: false, batchSize: 2, force: true,
        });

        expect(result).toMatchObject({ status: 'done', rowsEmbedded: 3 });
        expect(await nodeStamps()).toEqual(Array(3).fill({ model: OPENAI.model, dims: 1536 }));
        expect(await runs()).toEqual([{ finished: true, target_model: OPENAI.model, rows_done: 3, rows_total: 3 }]);
        const expected = await EmbeddingService.createForTesting(OPENAI).embed('a', 'document');
        const { rows } = await pool.query<{ distance: number }>(
          "SELECT embedding <=> $1::vector AS distance FROM kg_nodes WHERE label = 'a'",
          [`[${expected.join(',')}]`],
        );
        expect(rows[0]!.distance).toBeLessThan(1e-6);
        expect(await checkEmbeddingSchema(pool, OPENAI, logger)).toEqual({ status: 'ok' });
      });

      it('counts every row on --dry-run --force, and changes nothing', async () => {
        await seedNodes(OPENAI, ['a', 'b']);

        const plain = await reembedKnowledgeGraph({
          pool, embeddingService: EmbeddingService.createForTesting(OPENAI), logger, dryRun: true,
        });
        const forced = await reembedKnowledgeGraph({
          pool, embeddingService: EmbeddingService.createForTesting(OPENAI), logger, dryRun: true, force: true,
        });

        expect(plain).toMatchObject({ status: 'dry_run', widthChanges: false, rowsToEmbed: 0, force: false });
        expect(forced).toMatchObject({ status: 'dry_run', widthChanges: false, rowsToEmbed: 2, force: true });
        expect(await runs()).toEqual([]);
      });

      it('resumes an interrupted forced run without clearing the rows it already re-embedded', async () => {
        await seedNodes(OPENAI, ['a', 'b', 'c', 'd', 'e']);
        const embeddingService = EmbeddingService.createForTesting(OPENAI);
        const realEmbed = embeddingService.embed.bind(embeddingService);
        let calls = 0;
        const spy = vi.spyOn(embeddingService, 'embed').mockImplementation(async (text, purpose) => {
          calls += 1;
          if (calls > 3) throw new Error('endpoint went away');
          return realEmbed(text, purpose);
        });

        await expect(reembedKnowledgeGraph({ pool, embeddingService, logger, dryRun: false, batchSize: 2, force: true }))
          .rejects.toThrow('endpoint went away');
        expect(await runs()).toEqual([{ finished: false, target_model: OPENAI.model, rows_done: 3, rows_total: 5 }]);

        spy.mockRestore();
        const rerun = await reembedKnowledgeGraph({ pool, embeddingService, logger, dryRun: false, batchSize: 2, force: true });

        // Only the two rows still without a vector; the three already rewritten are kept.
        expect(rerun).toMatchObject({ status: 'done', rowsEmbedded: 2 });
        expect(await runs()).toEqual([{ finished: true, target_model: OPENAI.model, rows_done: 5, rows_total: 5 }]);
        expect(await checkEmbeddingSchema(pool, OPENAI, logger)).toEqual({ status: 'ok' });
      });

      it('warns, when --force resumes an open run to the same target, that a second --force re-embeds everything', async () => {
        await seedNodes(OPENAI, ['a', 'b', 'c', 'd', 'e']);
        // An open run toward the current stamp, as an interrupted plain run would leave.
        await pool.query(
          'INSERT INTO kg_reembed_runs (target_model, target_dimensions, rows_total) VALUES ($1, $2, 0)',
          [OPENAI.model, OPENAI.dimensions],
        );
        const warnLogger = createSilentLogger();
        const warn = vi.spyOn(warnLogger, 'warn');

        const rerun = await reembedKnowledgeGraph({
          pool, embeddingService: EmbeddingService.createForTesting(OPENAI), logger: warnLogger, dryRun: false, force: true,
        });

        // Resumed, not cleared: the stamped rows are kept.
        expect(rerun).toMatchObject({ status: 'done', rowsEmbedded: 0 });
        const messages = warn.mock.calls.map(c => String(c[1]));
        expect(messages.some(m => m.includes('--force resumes it') && m.includes('pnpm reembed:kg --force again'))).toBe(true);
      });

      it('does not warn about resuming when --force opens a fresh run', async () => {
        await seedNodes(OPENAI, ['a', 'b']);
        const warnLogger = createSilentLogger();
        const warn = vi.spyOn(warnLogger, 'warn');

        await reembedKnowledgeGraph({
          pool, embeddingService: EmbeddingService.createForTesting(OPENAI), logger: warnLogger, dryRun: false, force: true,
        });

        expect(warn.mock.calls.map(c => String(c[1])).some(m => m.includes('--force resumes it'))).toBe(false);
      });
    });

    it('exits before touching anything while another session holds the instance lock, naming it', async () => {
      await seedNodes(OPENAI, ['a']);
      const holder = new pg.Client({ connectionString: scratch.url, application_name: 'curia-under-test' });
      await holder.connect();
      try {
        await holder.query('SELECT pg_advisory_lock($1, $2)', [...INSTANCE_LOCK_KEYS]);

        const result = await reembedKnowledgeGraph({
          pool, embeddingService: EmbeddingService.createForTesting(NARROW), logger, dryRun: false,
        });

        expect(result.status).toBe('locked');
        expect(result.status === 'locked' && result.holder?.applicationName).toBe('curia-under-test');
        expect(await nodeStamps()).toEqual([{ model: OPENAI.model, dims: 1536 }]);
        expect(await runs()).toEqual([]);
      } finally {
        await holder.end();
      }
    });
  });

  describe('instance lock', () => {
    it('is held by Curia until release, and free afterwards', async () => {
      const release = await holdInstanceLock(pool, logger);
      try {
        expect(await findInstanceLockHolder(pool)).toBeDefined();
      } finally {
        await release();
      }
      expect(await findInstanceLockHolder(pool)).toBeUndefined();
    });

    it('survives its connection being ended: one error, the lock free, and release still resolves', async () => {
      const lockLogger = spyLogger();
      const release = await holdInstanceLock(pool, lockLogger);
      const held = await findInstanceLockHolder(pool);

      await pool.query('SELECT pg_terminate_backend($1)', [held!.pid]);

      await vi.waitFor(() => expect(lockLogger.error).toHaveBeenCalled());
      expect(lockLogger.error).toHaveBeenCalledOnce();
      expect(lockLogger.error.mock.calls[0]![0]).toMatch(/Instance lock lost.*Restart Curia/);
      expect(await findInstanceLockHolder(pool)).toBeUndefined();
      await expect(release()).resolves.toBeUndefined();
    });
  });
});
