// Integration test — the endpoint weight drift check through the shared boot gate against a
// live Postgres (#2023, design §7 "Weight drift"). The stored vectors are the baseline, so
// there is no baseline step: after `reembed:kg --force` the next resolution passes on its own.
// Runs in a scratch database because the gate may resize kg_nodes.embedding. Skips without
// DATABASE_URL. No endpoint is called: the createService seam hands the gate a fake service.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { createScratchDatabase, type ScratchDatabase } from './scratch-database.js';
import { createSilentLogger } from '../../src/logger.js';
import { EmbeddingService, type EmbeddingConfig } from '../../src/memory/embedding.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { OPENAI_TEXT_EMBEDDING_3_SMALL, type EmbeddingPurpose } from '../../src/memory/embedding-profiles.js';
import { resizeEmbeddingColumn, resolveKnowledgeGraphEmbedding } from '../../src/memory/embedding-schema.js';
import { reembedKnowledgeGraph } from '../../src/memory/reembed.js';
import { knowledgeGraphReasonFrom } from '../../src/memory/kg-health.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const logger = createSilentLogger();

/** Every node this suite writes carries this source, so cleanup deletes only those rows. */
const SOURCE = 'embedding-drift-test';
const PROFILE = OPENAI_TEXT_EMBEDDING_3_SMALL;
const LABELS = ['Marigold Ventures', 'role: head of procurement', 'Project Bluefin', 'prefers morning meetings', 'Larkspur Analytics', 'spouse: Rowan'];

/** OpenAI configured explicitly: an endpoint source, so the drift check runs. */
const ENDPOINT: EmbeddingConfig = {
  embeddingBaseUrl: 'https://api.openai.com/v1',
  embeddingModel: PROFILE.model,
  embeddingApiKey: 'sk-embedding-test',
  openaiApiKey: undefined,
  embeddingModelDir: '/nonexistent',
};

/** The weights that made the stored vectors: deterministic per string. */
const matching = () => EmbeddingService.createForTesting(PROFILE);

/**
 * Other weights under the same model name: the matching vector, reversed. Unrelated to the
 * stored one (cosine near 0), yet deterministic, so a re-embed with it is reproducible.
 */
function perturbed(): EmbeddingService {
  const base = matching();
  return {
    profile: PROFILE,
    embed: async (text: string, purpose: EmbeddingPurpose) => (await base.embed(text, purpose)).reverse(),
  } as unknown as EmbeddingService;
}

/** An endpoint that is down. */
function unreachable(): EmbeddingService {
  return {
    profile: PROFILE,
    embed: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); },
  } as unknown as EmbeddingService;
}

describeIf('endpoint weight drift check (stored vectors as the baseline)', () => {
  let scratch: ScratchDatabase;
  let pool: pg.Pool;
  /** What the "endpoint" serves for the next resolution. */
  let serving: EmbeddingService;
  const createService: typeof EmbeddingService.create = async () => serving;

  const resolve = () => resolveKnowledgeGraphEmbedding(pool, ENDPOINT, undefined, logger, {}, { createService });

  beforeAll(async () => {
    scratch = await createScratchDatabase(DATABASE_URL!, 'embeddrift');
    pool = new pg.Pool({ connectionString: scratch.url });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await scratch?.drop();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM kg_nodes WHERE source = $1', [SOURCE]);
    const client = await pool.connect();
    try {
      await resizeEmbeddingColumn(client, PROFILE.dimensions);
    } finally {
      client.release();
    }
    // Rows stamped with the endpoint's model, made by the weights it served then.
    const store = KnowledgeGraphStore.createWithPostgres(pool, matching(), logger);
    for (const label of LABELS) await store.createNode({ type: 'concept', label, properties: {}, source: SOURCE });
  });

  it('keeps the graph on, with no drift, while the endpoint reproduces the stored vectors', async () => {
    serving = matching();

    const result = await resolve();

    expect(result).toMatchObject({ ok: true, source: { kind: 'endpoint' } });
    expect(result.ok && result.drift).toBeUndefined();
    expect(knowledgeGraphReasonFrom(result)).toEqual({ result: 'ok' });
  });

  it('turns the graph off when the endpoint serves other weights, and pnpm reembed:kg --force recovers with no baseline step', async () => {
    serving = perturbed();

    const before = await resolve();
    expect(before).toMatchObject({ ok: false, gate: 'drift', reason: 'weights_changed' });
    expect(before.ok === false && before.message).toContain('pnpm reembed:kg --force');
    expect(knowledgeGraphReasonFrom(before)).toEqual({ result: 'fail', reason: 'weights_changed' });

    // What `pnpm reembed:kg --force` does with the endpoint's current weights.
    const reembedded = await reembedKnowledgeGraph({ pool, embeddingService: perturbed(), logger, dryRun: false, force: true });
    expect(reembedded).toMatchObject({ status: 'done', rowsEmbedded: LABELS.length });

    // The stored vectors now come from the current weights, so the next check passes.
    const after = await resolve();
    expect(after).toMatchObject({ ok: true, source: { kind: 'endpoint' } });
    expect(after.ok && after.drift).toBeUndefined();
  });

  it('keeps the graph on with drift unchecked when the endpoint is unreachable at boot', async () => {
    serving = unreachable();

    const result = await resolve();

    expect(result).toMatchObject({ ok: true, drift: 'unchecked' });
    expect(knowledgeGraphReasonFrom(result)).toEqual({ result: 'ok', reason: 'drift_unchecked' });
  });

  it('reports same for an endpoint graph with no stored vectors yet', async () => {
    await pool.query('DELETE FROM kg_nodes WHERE source = $1', [SOURCE]);
    serving = perturbed();

    const result = await resolve();

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.drift).toBeUndefined();
  });
});
