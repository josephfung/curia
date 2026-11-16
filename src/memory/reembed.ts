// Re-embeds the knowledge graph with the configured model (ADR-051). Run by
// scripts/reembed-kg.ts (`pnpm reembed:kg`) with Curia stopped; never at boot.
//
// The run is recorded in kg_reembed_runs before any vector is cleared, in the same
// transaction, and closed only when no row is left without a vector. An interrupted run
// therefore stays open, boot keeps the knowledge graph off, and a rerun resumes it.
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { EmbeddingService } from './embedding.js';
import { tryAcquireInstanceLock, type InstanceLockHolder } from '../db/instance-lock.js';
import { embeddingStamp } from './embedding-profiles.js';
import { REEMBED_FORCE_COMMAND } from './embedding-drift.js';
import { readEmbeddingSchema, resizeEmbeddingColumn, type EmbeddingSchemaSnapshot } from './embedding-schema.js';

export const DEFAULT_REEMBED_BATCH_SIZE = 50;

export interface ReembedOptions {
  pool: DbPool;
  embeddingService: EmbeddingService;
  logger: Logger;
  /** Report what a run would do, and change nothing. */
  dryRun: boolean;
  /**
   * Re-embed every row even when its stamp matches: the recovery path when an endpoint's
   * weights changed under the same model name. Clears through the same path a width change uses.
   */
  force?: boolean;
  batchSize?: number;
}

export type ReembedResult =
  | { status: 'locked'; holder: InstanceLockHolder | undefined }
  | { status: 'dry_run'; before: EmbeddingSchemaSnapshot; widthChanges: boolean; rowsToEmbed: number; force: boolean }
  | { status: 'done'; before: EmbeddingSchemaSnapshot; runId: number; rowsEmbedded: number };

/**
 * Takes the instance lock (or returns who holds it), then re-embeds every row whose vector
 * is missing or carries another stamp (another model or document prefix). Throws when an
 * embedding call fails; the run stays open and a rerun picks up from the rows still
 * without a vector.
 */
export async function reembedKnowledgeGraph(options: ReembedOptions): Promise<ReembedResult> {
  const { pool, embeddingService, logger, dryRun } = options;
  const force = options.force ?? false;
  const batchSize = options.batchSize ?? DEFAULT_REEMBED_BATCH_SIZE;
  const profile = embeddingService.profile;
  const stamp = embeddingStamp(profile);

  const lock = await tryAcquireInstanceLock(pool, logger);
  if (!lock.acquired) return { status: 'locked', holder: lock.holder };

  try {
    const before = await readEmbeddingSchema(pool);
    const widthChanges = before.columnDimensions !== profile.dimensions;
    logger.info(
      {
        columnDimensions: before.columnDimensions,
        vectorsByModel: before.vectorsByModel,
        openRun: before.openRun,
        targetModel: stamp,
        targetDimensions: profile.dimensions,
      },
      'reembed-kg: current state',
    );

    // A forced run that is already open for this target has done its clearing; clearing again
    // would throw away the rows it re-embedded before being interrupted.
    const resumes = resumesOpenRun(before, stamp, profile.dimensions);
    const clearAll = widthChanges || (force && !resumes);
    if (force && resumes && !widthChanges) {
      // The run record does not say whether the open run was itself forced, so --force cannot
      // tell "my own interrupted forced run" (resume is right) from an interrupted plain run
      // toward the same model (whose stamped rows a force should have re-embedded). Resuming
      // is the safe choice for the first; for the second, say so, so the next boot reading
      // `weights_changed` again is not a surprise.
      logger.warn(
        { openRunId: before.openRun?.id, targetModel: stamp },
        `reembed-kg: an unfinished run toward ${stamp} is open, so --force resumes it and keeps the rows it already ` +
        're-embedded instead of clearing every vector again. If that run was not itself started with --force, ' +
        `the rows it kept still hold vectors from the old weights: once this run completes, run ${REEMBED_FORCE_COMMAND} ` +
        'again to re-embed everything.',
      );
    }

    if (dryRun) {
      const { rows } = await pool.query<{ count: number }>(
        clearAll
          ? 'SELECT count(*)::int AS count FROM kg_nodes'
          : 'SELECT count(*)::int AS count FROM kg_nodes WHERE embedding_model IS DISTINCT FROM $1',
        clearAll ? [] : [stamp],
      );
      return { status: 'dry_run', before, widthChanges, rowsToEmbed: rows[0]?.count ?? 0, force: clearAll && !widthChanges };
    }

    const runId = await openRunAndClear(pool, embeddingService, before, widthChanges, clearAll, logger);
    const rowsEmbedded = await embedMissingVectors(pool, embeddingService, runId, batchSize, logger);

    const closed = await pool.query(
      `UPDATE kg_reembed_runs SET finished_at = now()
        WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM kg_nodes WHERE embedding IS NULL)`,
      [runId],
    );
    if ((closed.rowCount ?? 0) === 0) {
      // Rows without a vector appeared after the last batch; leave the run open.
      throw new Error(`reembed-kg: rows without a vector remain; run ${runId} is still open. Run the command again.`);
    }
    logger.info({ runId, rowsEmbedded, model: stamp }, 'reembed-kg: run complete');
    return { status: 'done', before, runId, rowsEmbedded };
  } finally {
    await lock.release();
  }
}

/** True when an unfinished run already targets this stamp and width, so a rerun continues it. */
function resumesOpenRun(before: EmbeddingSchemaSnapshot, stamp: string, dimensions: number): boolean {
  const open = before.openRun;
  return open !== undefined && open.targetModel === stamp && open.targetDimensions === dimensions;
}

/**
 * In one transaction: records the run (or takes over the open one), clears every vector
 * whose stamp is not the configured profile's, and resizes the column when the width changes.
 */
async function openRunAndClear(
  pool: DbPool,
  embeddingService: EmbeddingService,
  before: EmbeddingSchemaSnapshot,
  widthChanges: boolean,
  clearAll: boolean,
  logger: Logger,
): Promise<number> {
  const profile = embeddingService.profile;
  const stamp = embeddingStamp(profile);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (clearAll) {
      await client.query('UPDATE kg_nodes SET embedding = NULL, embedding_model = NULL WHERE embedding IS NOT NULL');
      if (widthChanges) await resizeEmbeddingColumn(client, profile.dimensions);
    } else {
      await client.query(
        `UPDATE kg_nodes SET embedding = NULL, embedding_model = NULL
          WHERE embedding IS NOT NULL AND embedding_model IS DISTINCT FROM $1`,
        [stamp],
      );
    }
    const { rows: [missing] } = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM kg_nodes WHERE embedding IS NULL',
    );
    const rowsMissing = missing?.count ?? 0;

    let runId: number;
    const open = before.openRun;
    if (open && open.targetModel === stamp && open.targetDimensions === profile.dimensions) {
      runId = open.id;
      await client.query('UPDATE kg_reembed_runs SET rows_total = rows_done + $2 WHERE id = $1', [runId, rowsMissing]);
    } else if (open) {
      // The model or document prefix changed again mid-run; the rows it embedded were cleared above.
      runId = open.id;
      await client.query(
        `UPDATE kg_reembed_runs SET target_model = $2, target_dimensions = $3, rows_done = 0, rows_total = $4
          WHERE id = $1`,
        [runId, stamp, profile.dimensions, rowsMissing],
      );
    } else {
      const { rows: [created] } = await client.query<{ id: string }>(
        `INSERT INTO kg_reembed_runs (target_model, target_dimensions, rows_total)
         VALUES ($1, $2, $3) RETURNING id`,
        [stamp, profile.dimensions, rowsMissing],
      );
      runId = Number(created!.id);
    }

    await client.query('COMMIT');
    logger.info({ runId, rowsToEmbed: rowsMissing, resumed: open !== undefined, widthChanged: widthChanges }, 'reembed-kg: run open');
    return runId;
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
      logger.error({ err: rollbackErr }, 'reembed-kg: rollback failed');
    });
    throw err;
  } finally {
    client.release();
  }
}

/** Embeds every row without a vector, archived rows included, as a stored document. */
async function embedMissingVectors(
  pool: DbPool,
  embeddingService: EmbeddingService,
  runId: number,
  batchSize: number,
  logger: Logger,
): Promise<number> {
  const stamp = embeddingStamp(embeddingService.profile);
  let embedded = 0;
  for (;;) {
    const { rows } = await pool.query<{ id: string; label: string }>(
      'SELECT id, label FROM kg_nodes WHERE embedding IS NULL ORDER BY id LIMIT $1',
      [batchSize],
    );
    if (rows.length === 0) return embedded;

    for (const row of rows) {
      let vector: number[];
      try {
        vector = await embeddingService.embed(row.label, 'document');
      } catch (err) {
        logger.error({ err, nodeId: row.id, runId }, 'reembed-kg: embedding failed; the run stays open');
        throw err;
      }
      // One statement, so rows_done never lags the rows written when a later embed fails.
      await pool.query(
        `WITH written AS (
           UPDATE kg_nodes SET embedding = $1::vector, embedding_model = $2 WHERE id = $3 AND embedding IS NULL RETURNING 1
         )
         UPDATE kg_reembed_runs SET rows_done = rows_done + (SELECT count(*) FROM written) WHERE id = $4`,
        [`[${vector.join(',')}]`, stamp, row.id, runId],
      );
    }
    embedded += rows.length;
    const { rows: [run] } = await pool.query<{ rows_done: number; rows_total: number }>(
      'SELECT rows_done, rows_total FROM kg_reembed_runs WHERE id = $1',
      [runId],
    );
    logger.info({ runId, rowsDone: run?.rows_done, rowsTotal: run?.rows_total }, 'reembed-kg: batch embedded');
  }
}
