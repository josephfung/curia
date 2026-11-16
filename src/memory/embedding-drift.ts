// Weight drift behind an endpoint's model name (#2023, design §7 "Weight drift").
//
// For an embedding endpoint (OpenAI, Ollama, llama.cpp…) the vector stamp proves only the
// model NAME. A server that starts serving other weights under that name (a re-pulled Ollama
// tag with another quantisation, a swapped llama.cpp file) would have new vectors compared
// with old ones silently. The stored vectors are the baseline: re-embed a few stored labels
// and compare them with what is stored. No table, no migration, nothing to keep in sync, and
// after `pnpm reembed:kg --force` the stored vectors come from the current weights, so the
// next check passes on its own.
//
// The bundled model needs none of this: its stamp carries the weights hash.
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { EmbeddingDimensionError, EmbeddingService } from './embedding.js';
import { embeddingStamp } from './embedding-profiles.js';
import { parseVector } from './knowledge-graph.js';

/** How many stored labels the check re-embeds. A handful: the cost must stay negligible. */
export const DRIFT_SAMPLE_SIZE = 5;

/*
 * Thresholds on the cosine between a stored vector and the same label embedded again.
 * Measured for #2023 with @huggingface/transformers 4.3.2 on CPU, 20 invented short labels
 * (names, `attribute: value` facts, a few words), document prefixes, normalised vectors:
 *
 *   same weights, same quantisation, embedded twice (repeat noise), all six runs below:
 *                                                   min 1.000000  mean 1.000000
 *   (a) same weights, other quantisation:
 *       EmbeddingGemma 2, q4 vs q8                  min 0.980855  mean 0.987364  max 0.991421
 *       all-MiniLM-L6-v2, q8 vs fp32                min 0.986651  mean 0.991064  max 0.994801
 *   (b) different models, same width (768):
 *       granite-embedding-english-r2 vs nomic-embed-text-v1.5 (both q8)
 *                                                   min -0.058568 mean 0.009791  max 0.064908
 *
 * Which statistic decides what (ruling R21):
 *
 * - `same` and `shifted` use the MINIMUM: every sampled row must reproduce for `same`, so one
 *   re-quantised row is enough to report `shifted`.
 * - `changed` uses the MEDIAN. It switches the knowledge graph off, so one row must not decide
 *   it: a row whose vector no longer matches its label (a node-merge survivor renamed while the
 *   graph was off, older data) scores low under any weights. A different model scores ~0.06 on
 *   every row, so the median finds it as surely as the minimum would.
 *
 * DRIFT_SAME_MIN (0.995) leaves room for hosted and GPU endpoints (OpenAI, Ollama or llama.cpp
 * on GPU), which are not bit-for-bit repeatable call to call the way the CPU runs above are: with
 * the minimum of 5 labels deciding, a tighter cutoff could read that noise as a sticky "shifted".
 * It still sits above every (a) score, max included (0.994801), so a re-quantisation reads as
 * shifted.
 *
 * DRIFT_SHIFT_FLOOR (0.9) sits ~0.08 under the lowest (a) score, leaving room for a coarser
 * quantisation than q4, and ~0.84 above the highest (b) score, so an unrelated model is never
 * taken for a shift.
 */
/** The lowest sampled cosine at or above this: the endpoint serves the weights that made the stored vectors. */
export const DRIFT_SAME_MIN = 0.995;
/** The median sampled cosine below this: the endpoint serves other weights, treated as a model mismatch. */
export const DRIFT_SHIFT_FLOOR = 0.9;

/** Boot never waits longer than this on the check (design §7: it must never block boot). */
export const DRIFT_TIMEOUT_MS = 5000;

/**
 * - `same`: the weights that made the stored vectors (or nothing stored to compare with);
 * - `shifted`: the same model at another precision (e.g. re-quantised); the graph stays on and
 *   health reports `ok` with the reason `weights_shifted` until `pnpm reembed:kg --force`;
 * - `changed`: other weights; the graph is off at boot until `pnpm reembed:kg --force`;
 * - `unchecked`: the endpoint did not answer in time, or the check could not run (network
 *   errors, timeouts, HTTP errors). A vector of the wrong width is not this: it is `changed`.
 */
export type DriftOutcome = 'same' | 'shifted' | 'changed' | 'unchecked';

/** The command that re-embeds every row, the recovery from changed or shifted weights. */
export const REEMBED_FORCE_COMMAND = 'pnpm reembed:kg --force';

/**
 * A deterministic sample (ordered by id) of stored labels carrying `stamp`, with their stored
 * vectors. Ids are random UUIDs, so the order is arbitrary but stable: the same rows are
 * compared on every run until rows are added or deleted.
 */
export async function sampleStoredLabels(
  pool: DbPool,
  stamp: string,
  n: number = DRIFT_SAMPLE_SIZE,
): Promise<Array<{ id: string; label: string; embedding: number[] }>> {
  const { rows } = await pool.query<{ id: string; label: string; embedding: string }>(
    `SELECT id, label, embedding::text AS embedding FROM kg_nodes
      WHERE embedding_model = $1 AND embedding IS NOT NULL ORDER BY id LIMIT $2`,
    [stamp, n],
  );
  return rows.map((row) => ({ id: row.id, label: row.label, embedding: parseVector(row.embedding) }));
}

/** Thrown inside the race when the deadline passes first; never escapes this module. */
class DriftTimeoutError extends Error {
  constructor(ms: number) {
    super(`the drift check did not finish within ${ms} ms`);
    this.name = 'DriftTimeoutError';
  }
}

/** One sampled row's score: its id (never its label, which is user data) and its cosine. */
interface SampledCosine {
  id: string;
  cosine: number;
}

async function sampleCosines(pool: DbPool, service: EmbeddingService): Promise<SampledCosine[]> {
  const sample = await sampleStoredLabels(pool, embeddingStamp(service.profile));
  const scores: SampledCosine[] = [];
  // One at a time: a local server is often single-threaded, and five labels are cheap.
  for (const { id, label, embedding } of sample) {
    // The stored vectors were made with the document purpose (KnowledgeGraphStore).
    const fresh = await service.embed(label, 'document');
    scores.push({ id, cosine: EmbeddingService.cosineSimilarity(embedding, fresh) });
  }
  return scores;
}

/** The median of a non-empty list: the middle value, or the mean of the two middle values. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Indexes are in range: the caller never passes an empty list.
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Re-embeds a few stored labels through `service` and classifies their cosines against the
 * stored vectors: the minimum decides same/shifted, the median decides changed (see the
 * thresholds above). Never throws and never waits longer than `timeoutMs`: an endpoint that is
 * down, slow or erroring gives `unchecked`, which leaves the knowledge graph on.
 * (An embed still in flight at the deadline is abandoned, not cancelled; the HTTP backend's
 * own fetch timeout ends it.)
 */
export async function checkEmbeddingDrift(
  pool: DbPool,
  service: EmbeddingService,
  logger: Logger,
  timeoutMs: number = DRIFT_TIMEOUT_MS,
): Promise<DriftOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DriftTimeoutError(timeoutMs)), timeoutMs);
  });
  let scores: SampledCosine[];
  try {
    scores = await Promise.race([sampleCosines(pool, service), deadline]);
  } catch (err) {
    // A vector of another width is not an unreachable endpoint: the endpoint answered, with a
    // different model under the same name. No cosine can be computed, and none is needed.
    if (err instanceof EmbeddingDimensionError) {
      logger.info(
        { embeddingModel: embeddingStamp(service.profile), expectedDimensions: err.expected, actualDimensions: err.actual, outcome: 'changed' },
        'Embedding weight drift check: the endpoint returns vectors of another width, so it serves another model',
      );
      return 'changed';
    }
    // Advisory check: a failure must not turn the knowledge graph off, but it is never
    // silent either. Health reports `drift_unchecked` and the canary retries.
    logger.warn(
      { err, embeddingModel: embeddingStamp(service.profile), timeoutMs },
      'Embedding weight drift check could not run; the knowledge graph stays on and the check retries on the canary schedule',
    );
    return 'unchecked';
  } finally {
    clearTimeout(timer);
  }

  // No stored rows with this stamp: nothing to compare, and nothing to protect.
  if (scores.length === 0) return 'same';
  const cosines = scores.map((s) => s.cosine);
  const minimumCosine = Math.min(...cosines);
  if (minimumCosine >= DRIFT_SAME_MIN) return 'same';
  const medianCosine = median(cosines);
  const outcome: DriftOutcome = medianCosine < DRIFT_SHIFT_FLOOR ? 'changed' : 'shifted';
  const embeddingModel = embeddingStamp(service.profile);

  if (outcome === 'shifted') {
    // Rows below the floor while the median is above it: most likely rows whose vector no
    // longer matches their label, not other weights. Named by id so an operator can look at
    // them; labels are user data and stay out of the log.
    const outliers = scores.filter((s) => s.cosine < DRIFT_SHIFT_FLOOR);
    if (outliers.length > 0) {
      logger.warn(
        { embeddingModel, medianCosine, outliers },
        'Embedding weight drift check: some sampled knowledge-graph rows no longer match their stored vectors, ' +
        'but most do, so this reads as shifted weights rather than another model. ' +
        `${REEMBED_FORCE_COMMAND} re-embeds every row, these included`,
      );
    }
  }
  logger.info(
    { embeddingModel, minimumCosine, medianCosine, outcome },
    'Embedding weight drift check: the endpoint no longer reproduces the stored vectors',
  );
  return outcome;
}
