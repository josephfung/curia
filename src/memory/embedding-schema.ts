// Whether kg_nodes is ready for the configured embedding profile (ADR-051).
//
// Boot runs this before building entity memory. A changed model or width never rewrites
// stored vectors on its own: the knowledge graph stays off and the log names the command
// that re-embeds. The one exception is a table holding no vectors, where a resize at boot
// loses nothing.
import type { DbPool, DbPoolClient } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { HNSW_MAX_DIMENSIONS, embeddingStamp, type EmbeddingProfile } from './embedding-profiles.js';
import type { EventBus } from '../bus/bus.js';
import type { ModelRegistry } from '../agents/llm/model-registry.js';
import {
  EmbeddingService,
  describeEmbeddingUnavailable,
  describeImplicitOpenAIDeprecation,
  resolveEmbedding,
  type EmbeddingConfig,
  type EmbeddingResolutionFailure,
  type EmbeddingSource,
  type StoredEmbeddingState,
} from './embedding.js';
import { BundledModelFileMissingError, hashBundledWeights } from './embedding-onnx.js';
import { REEMBED_APPLICATION_NAME, describeInstanceLockHolder, findInstanceLockHolder } from '../db/instance-lock.js';
import { REEMBED_FORCE_COMMAND, checkEmbeddingDrift, type DriftOutcome } from './embedding-drift.js';

export const REEMBED_COMMAND = 'pnpm reembed:kg';
const REEMBED_DOCS_URL = 'https://docs.meetcuria.com/integrations/embeddings-endpoint';

/** How to run the re-embed command, for a log line an operator acts on. */
export const REEMBED_INSTRUCTIONS =
  `Stop Curia, run ${REEMBED_COMMAND}, then start Curia`;

/** Where a Docker install finds how to run the command, which depends on its compose file. */
export const REEMBED_DOCKER_NOTE = `For a Docker install, see ${REEMBED_DOCS_URL}.`;

export interface ReembedRun {
  id: number;
  startedAt: Date;
  targetModel: string;
  targetDimensions: number;
  rowsTotal: number;
  rowsDone: number;
}

export interface EmbeddingSchemaSnapshot {
  /** The declared width of kg_nodes.embedding; null when the column has no width. */
  columnDimensions: number | null;
  /** Rows holding a vector, by their stamp (`embeddingStamp()` of the profile that made it). */
  vectorsByModel: Record<string, number>;
  /** The unfinished re-embed, if one is recorded. */
  openRun: ReembedRun | undefined;
}

export type EmbeddingSchemaState =
  | { status: 'ok' }
  | { status: 'resized'; fromDimensions: number | null; toDimensions: number }
  | { status: 'off'; reason: 'open_run'; run: ReembedRun }
  | { status: 'off'; reason: 'width_mismatch'; columnDimensions: number | null; profileDimensions: number; vectorCount: number }
  | { status: 'off'; reason: 'model_mismatch'; stamp: string; otherModelVectors: number; vectorsByModel: Record<string, number> };

type Queryable = DbPool | DbPoolClient;

export async function readEmbeddingSchema(db: Queryable): Promise<EmbeddingSchemaSnapshot> {
  // For pgvector's vector(n), atttypmod is n itself; -1 means no declared width.
  const column = await db.query<{ atttypmod: number }>(
    `SELECT atttypmod FROM pg_attribute
      WHERE attrelid = 'kg_nodes'::regclass AND attname = 'embedding' AND NOT attisdropped`,
  );
  const typmod = column.rows[0]?.atttypmod;
  const columnDimensions = typmod !== undefined && typmod > 0 ? typmod : null;

  const models = await db.query<{ embedding_model: string; count: number }>(
    `SELECT embedding_model, count(*)::int AS count FROM kg_nodes
      WHERE embedding IS NOT NULL GROUP BY embedding_model`,
  );
  const vectorsByModel: Record<string, number> = {};
  for (const row of models.rows) vectorsByModel[row.embedding_model] = row.count;

  const runs = await db.query<{
    id: string;
    started_at: Date;
    target_model: string;
    target_dimensions: number;
    rows_total: number;
    rows_done: number;
  }>(
    `SELECT id, started_at, target_model, target_dimensions, rows_total, rows_done
       FROM kg_reembed_runs WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 1`,
  );
  const run = runs.rows[0];
  return {
    columnDimensions,
    vectorsByModel,
    openRun: run && {
      id: Number(run.id),
      startedAt: run.started_at,
      targetModel: run.target_model,
      targetDimensions: run.target_dimensions,
      rowsTotal: run.rows_total,
      rowsDone: run.rows_done,
    },
  };
}

function totalVectors(snapshot: EmbeddingSchemaSnapshot): number {
  return Object.values(snapshot.vectorsByModel).reduce((sum, n) => sum + n, 0);
}

/** The state a snapshot puts the knowledge graph in, before any resize. */
function classify(snapshot: EmbeddingSchemaSnapshot, profile: EmbeddingProfile): EmbeddingSchemaState | 'needs_resize' {
  // An open run comes first: its rows may all look complete while some still wait for a vector.
  if (snapshot.openRun) return { status: 'off', reason: 'open_run', run: snapshot.openRun };

  const vectorCount = totalVectors(snapshot);
  if (snapshot.columnDimensions !== profile.dimensions) {
    if (vectorCount === 0) return 'needs_resize';
    return {
      status: 'off',
      reason: 'width_mismatch',
      columnDimensions: snapshot.columnDimensions,
      profileDimensions: profile.dimensions,
      vectorCount,
    };
  }

  const stamp = embeddingStamp(profile);
  const otherModelVectors = vectorCount - (snapshot.vectorsByModel[stamp] ?? 0);
  if (otherModelVectors > 0) {
    return {
      status: 'off',
      reason: 'model_mismatch',
      stamp,
      otherModelVectors,
      vectorsByModel: snapshot.vectorsByModel,
    };
  }
  return { status: 'ok' };
}

/**
 * Drops the HNSW index, sets the column's width, and recreates the index with migration
 * 004's definition. Every vector must already be null: pgvector refuses to cast a stored
 * vector to another width. Runs on the caller's client, inside the caller's transaction.
 */
export async function resizeEmbeddingColumn(client: DbPoolClient, dimensions: number): Promise<void> {
  // A type modifier cannot be a bind parameter, so the width is interpolated. It is
  // checked to be an integer in range first, which leaves nothing else to inject.
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > HNSW_MAX_DIMENSIONS) {
    throw new Error(`resizeEmbeddingColumn: width must be an integer from 1 to ${HNSW_MAX_DIMENSIONS}, got ${dimensions}`);
  }
  await client.query('DROP INDEX IF EXISTS idx_kg_nodes_embedding');
  await client.query(`ALTER TABLE kg_nodes ALTER COLUMN embedding TYPE vector(${dimensions})`);
  await client.query('CREATE INDEX idx_kg_nodes_embedding ON kg_nodes USING hnsw (embedding vector_cosine_ops)');
}

/**
 * Decides whether boot may build entity memory for `profile`. Resizes the column itself
 * only when no row holds a vector and no re-embed is open, re-checking both under a table
 * lock so a concurrent writer cannot slip a vector in between.
 */
export async function checkEmbeddingSchema(
  pool: DbPool,
  profile: EmbeddingProfile,
  logger: Logger,
): Promise<EmbeddingSchemaState> {
  const first = classify(await readEmbeddingSchema(pool), profile);
  if (first !== 'needs_resize') return first;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE kg_nodes IN ACCESS EXCLUSIVE MODE');
    const snapshot = await readEmbeddingSchema(client);
    const state = classify(snapshot, profile);
    if (state !== 'needs_resize') {
      await client.query('ROLLBACK');
      return state;
    }
    await resizeEmbeddingColumn(client, profile.dimensions);
    await client.query('COMMIT');
    logger.info(
      { fromDimensions: snapshot.columnDimensions, toDimensions: profile.dimensions, embeddingModel: embeddingStamp(profile) },
      'kg_nodes.embedding resized for the embedding profile (the table held no vectors)',
    );
    return { status: 'resized', fromDimensions: snapshot.columnDimensions, toDimensions: profile.dimensions };
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
      logger.error({ err: rollbackErr }, 'checkEmbeddingSchema: rollback failed');
    });
    throw err;
  } finally {
    client.release();
  }
}

/** The warn line for a knowledge graph the schema check turned off. */
export function describeEmbeddingSchemaOff(state: Extract<EmbeddingSchemaState, { status: 'off' }>): string {
  switch (state.reason) {
    case 'open_run':
      return `A knowledge-graph re-embed started ${state.run.startedAt.toISOString()} did not finish ` +
        `(${state.run.rowsDone} of ${state.run.rowsTotal} rows embedded with ${state.run.targetModel}). ` +
        `To finish it: ${REEMBED_INSTRUCTIONS}. ${REEMBED_DOCKER_NOTE}`;
    case 'width_mismatch':
      return `kg_nodes.embedding holds ${state.vectorCount} vectors of width ${state.columnDimensions ?? 'unset'}, ` +
        `but the embedding profile needs ${state.profileDimensions}. ${REEMBED_INSTRUCTIONS}. ${REEMBED_DOCKER_NOTE}`;
    case 'model_mismatch':
      return `${state.otherModelVectors} knowledge-graph vectors were made by another model or document prefix than ${state.stamp} ` +
        `(${JSON.stringify(state.vectorsByModel)}). ${REEMBED_INSTRUCTIONS}. ${REEMBED_DOCKER_NOTE}`;
  }
}

/** What resolution needs from a snapshot: the stored stamps and an unfinished run's target. */
export function storedStateFromSnapshot(snapshot: EmbeddingSchemaSnapshot): StoredEmbeddingState {
  return {
    stamps: Object.keys(snapshot.vectorsByModel),
    ...(snapshot.openRun ? { openRunTarget: snapshot.openRun.targetModel } : {}),
  };
}

/** Why the bundled model is unusable: its files are not there, or they are and will not load. */
export type BundledFailureReason = 'bundled_weights_missing' | 'bundled_load_failed';

export type KnowledgeGraphEmbedding =
  | {
    ok: true;
    source: EmbeddingSource;
    /** For a bundled source, carries the weightsSha256 of the file actually loaded. */
    profile: EmbeddingProfile;
    /** Built and, for the bundled model, loaded: the bundled load is where a bad file shows up. */
    service: EmbeddingService;
    deprecation?: 'implicit_openai';
    /**
     * Endpoint sources only: what the boot drift check found when it was not `same`. The
     * knowledge graph runs either way; health reports the reason.
     */
    drift?: Extract<DriftOutcome, 'shifted' | 'unchecked'>;
  }
  // The resolution's own reason and fields (model, storedModel), so health maps by code.
  | (EmbeddingResolutionFailure & { gate: 'config'; message: string })
  | { ok: false; gate: 'bundled'; message: string; reason: BundledFailureReason; err: unknown }
  | {
    ok: false;
    gate: 'schema';
    message: string;
    state?: Extract<EmbeddingSchemaState, { status: 'off' }>;
    err?: unknown;
    /** Set when `pnpm reembed:kg` holds the instance lock (there is then no `state`). */
    reason?: 'reembed_in_progress';
  }
  // The endpoint serves other weights than made the stored vectors (design §7).
  | { ok: false; gate: 'drift'; message: string; reason: 'weights_changed' };

export interface KnowledgeGraphEmbeddingDeps {
  /** Test seam: builds the service. Production uses `EmbeddingService.create`. */
  createService?: typeof EmbeddingService.create;
}

function bundledFailure(err: unknown): Extract<KnowledgeGraphEmbedding, { gate: 'bundled' }> {
  const reason: BundledFailureReason = err instanceof BundledModelFileMissingError ? 'bundled_weights_missing' : 'bundled_load_failed';
  return { ok: false, gate: 'bundled', reason, err, message: `The bundled embedding model is unusable: ${(err as Error).message}.` };
}

/**
 * Whether entity memory may run, and the service it runs on. In order:
 * 1. reads the stored state (the same snapshot the schema check reads) and resolves the
 *    source from it (design §1), logging the deprecation when the OpenAI compatibility
 *    rule applied;
 * 2. for the bundled model, hashes the weight file it will load into the profile, so the
 *    stamp the schema check compares names those weights;
 * 3. refuses while `pnpm reembed:kg` holds the instance lock, since the command takes it
 *    before it clears vectors;
 * 4. runs the schema check, which may resize an empty table;
 * 5. builds the service. The bundled model loads here, eagerly, after the gate passes (so a
 *    graph that is off anyway never loads the native runtime);
 * 6. for an endpoint (OpenAI included), re-embeds a few stored labels and compares them with
 *    the stored vectors (`checkEmbeddingDrift`, design §7). Other weights under the same model
 *    name turn the graph off with `gate: 'drift'`; a shift or an unreachable endpoint leaves it
 *    on with `drift` set. Bounded by DRIFT_TIMEOUT_MS, so it never holds boot for long.
 *
 * A bundled model that cannot be hashed or loaded (missing or corrupt files, a profile with
 * no pooling, a native runtime that will not load) turns the knowledge graph off with
 * `gate: 'bundled'`. It never throws for that: boot carries on without entity memory.
 */
export async function resolveKnowledgeGraphEmbedding(
  pool: DbPool,
  config: EmbeddingConfig,
  profileOverrides: Readonly<Record<string, EmbeddingProfile>> | undefined,
  logger: Logger,
  telemetry: { bus?: EventBus; modelRegistry?: ModelRegistry } = {},
  deps: KnowledgeGraphEmbeddingDeps = {},
): Promise<KnowledgeGraphEmbedding> {
  const createService = deps.createService ?? EmbeddingService.create;

  // The snapshot is read before resolution: an install whose graph holds another model's
  // vectors must not be switched to the bundled model. A failure here is the schema gate's.
  let snapshot: EmbeddingSchemaSnapshot;
  try {
    snapshot = await readEmbeddingSchema(pool);
  } catch (err) {
    return { ok: false, gate: 'schema', message: 'The embedding schema check failed.', err };
  }

  const embedding = resolveEmbedding(config, profileOverrides, storedStateFromSnapshot(snapshot));
  if (!embedding.ok) return { ...embedding, gate: 'config', message: `${describeEmbeddingUnavailable(embedding)}.` };
  if (embedding.deprecation === 'implicit_openai') logger.warn(describeImplicitOpenAIDeprecation());

  let profile = embedding.profile;
  if (embedding.source.kind === 'bundled') {
    try {
      profile = { ...profile, weightsSha256: await hashBundledWeights(embedding.source.modelDir, logger) };
    } catch (err) {
      return bundledFailure(err);
    }
  }

  let state: EmbeddingSchemaState;
  try {
    const holder = await findInstanceLockHolder(pool);
    if (holder?.applicationName === REEMBED_APPLICATION_NAME) {
      return {
        ok: false,
        gate: 'schema',
        reason: 'reembed_in_progress',
        message: `${REEMBED_COMMAND} is running against this database (it holds the instance lock: ` +
          `${describeInstanceLockHolder(holder)}). Restart Curia when it finishes.`,
      };
    }
    state = await checkEmbeddingSchema(pool, profile, logger);
  } catch (err) {
    return { ok: false, gate: 'schema', message: 'The embedding schema check failed.', err };
  }
  if (state.status === 'off') return { ok: false, gate: 'schema', message: describeEmbeddingSchemaOff(state), state };

  let service: EmbeddingService;
  try {
    service = await createService(embedding.source, profile, logger, telemetry.bus, telemetry.modelRegistry);
  } catch (err) {
    // Building an endpoint service only constructs a client, so a throw there is a bug,
    // not a configuration problem: let it surface.
    if (embedding.source.kind !== 'bundled') throw err;
    return bundledFailure(err);
  }

  // The bundled stamp carries the weights hash, so only an endpoint needs the drift check.
  const drift = embedding.source.kind === 'endpoint' ? await checkEmbeddingDrift(pool, service, logger) : 'same';
  if (drift === 'changed') {
    return {
      ok: false,
      gate: 'drift',
      reason: 'weights_changed',
      message: `The embedding endpoint now serves different weights under the model name ${embeddingStamp(profile)} ` +
        'from those that made the stored knowledge-graph vectors. To re-embed every row with the current weights: ' +
        `stop Curia, run ${REEMBED_FORCE_COMMAND}, then start Curia. ${REEMBED_DOCKER_NOTE}`,
    };
  }
  return {
    ok: true,
    source: embedding.source,
    profile,
    service,
    ...(embedding.deprecation ? { deprecation: embedding.deprecation } : {}),
    ...(drift === 'same' ? {} : { drift }),
  };
}
