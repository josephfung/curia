import type { Pool, PoolClient } from 'pg';
import type { EventBus } from '../bus/bus.js';
import { createMemoryDecayWarning } from '../bus/events.js';
import type { MemoryDecayWarningPayload } from '../bus/events.js';
import type { Logger } from '../logger.js';
import type { AutonomyScoringPass } from '../autonomy/scoring-pass.js';

// Config shape mirrors YamlConfig.dreaming.decay — all fields required at construction
// time (caller resolves defaults before passing in).
export interface DecayConfig {
  intervalMs: number;
  archiveThreshold: number;
  halfLifeDays: {
    permanent: null;
    slow_decay: number;
    fast_decay: number;
  };
  /** Percentile (0–1) used to compute the edge-count threshold for "high connectivity".
   *  A node is high-connectivity if its edge count >= percentile_disc(edgeCountPercentile)
   *  across all non-archived nodes, subject to edgeCountFloor. Default: 0.95 (top 5%). */
  edgeCountPercentile: number;
  /** Minimum edge count for the high-connectivity criterion regardless of percentile.
   *  Prevents warnings on trivially-connected nodes in a sparse graph. Default: 5. */
  edgeCountFloor: number;
  /** Days a warned node is held back from archiving while awaiting CEO re-confirmation.
   *  After this window, the node is archived by the next decay pass. Default: 7. */
  warnHoldBackDays: number;
}

export interface DecayPassResult {
  nodesDecayed: number;
  edgesDecayed: number;
  nodesWarned: number;    // nodes newly flagged in this pass
  nodesExpired: number;   // warned nodes archived because hold-back expired
  nodesArchived: number;
  edgesArchived: number;
  durationMs: number;
}

/**
 * DreamEngine — background knowledge graph maintenance.
 *
 * Named after the neuroscience analogy: sleep is when the brain consolidates
 * short-term experiences into long-term memory and prunes weak connections.
 *
 * Currently implements one pass: memory decay (issue #27).
 * Future passes (decay warning #280, contradiction resolution, synthesis) will
 * be added as sibling methods with their own config keys under `dreaming`.
 *
 * EventBus is injected and used by the decay warning pass (#280) to emit
 * `memory.decay_warning` before archiving important nodes.
 */
export class DreamEngine {
  private pool: Pool;
  private bus: EventBus;
  private logger: Logger;
  private config: DecayConfig;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private scoringIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private scoringPass?: AutonomyScoringPass;
  // Guard flag: prevents a new scoring pass from starting while the previous one
  // is still awaiting LLM responses. Without this, a slow judge call (e.g. rate
  // limit backoff) could let two passes read the same unscored rows concurrently,
  // wasting LLM spend and applying the adjustment formula twice.
  private scoringPassInFlight = false;

  constructor(pool: Pool, bus: EventBus, logger: Logger, config: DecayConfig, scoringPass?: AutonomyScoringPass) {
    this.pool = pool;
    this.bus = bus;
    this.logger = logger;
    this.config = config;
    this.scoringPass = scoringPass;
  }

  /**
   * Start the recurring decay interval.
   * Logs the configured cadence so operators can verify the schedule at startup.
   *
   * The decay pass and scoring pass run on independent intervals so a slow scoring
   * pass (e.g. waiting on an LLM judge) never blocks the decay pass from running.
   */
  start(): void {
    this.intervalHandle = setInterval(() => {
      this.runDecayPass().catch((err) => {
        this.logger.error({ err }, 'DreamEngine: unhandled error in runDecayPass');
      });
    }, this.config.intervalMs);

    if (this.scoringPass) {
      this.scoringIntervalHandle = setInterval(() => {
        // Skip this tick if the previous scoring run is still in flight.
        // setInterval fires again regardless of whether the previous callback has
        // resolved; skipping prevents concurrent runs from judging the same rows.
        if (this.scoringPassInFlight) {
          this.logger.warn('DreamEngine: skipping AutonomyScoringPass tick — previous run still in flight');
          return;
        }
        this.scoringPassInFlight = true;
        this.scoringPass!.run()
          .catch((err) => {
            this.logger.error({ err }, 'DreamEngine: unhandled error in AutonomyScoringPass');
          })
          .finally(() => {
            this.scoringPassInFlight = false;
          });
      }, this.scoringPass.intervalMs);  // ← use scoring-specific interval, not decay interval
    }

    this.logger.info(
      {
        intervalMs: this.config.intervalMs,
        scoringIntervalMs: this.scoringPass?.intervalMs ?? null,
        archiveThreshold: this.config.archiveThreshold,
        hasScoringPass: !!this.scoringPass,
      },
      'DreamEngine started (decay pass scheduled)',
    );
  }

  /** Stop all interval timers for clean shutdown. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.scoringIntervalHandle) {
      clearInterval(this.scoringIntervalHandle);
      this.scoringIntervalHandle = null;
    }
    this.logger.info('DreamEngine stopped');
  }

  /**
   * Run one full decay pass:
   *   1. Decay confidence on slow_decay and fast_decay nodes and edges
   *   2. Archive nodes whose confidence is at or below archiveThreshold
   *   3. Archive edges whose endpoints were archived, or whose own confidence crossed the threshold
   *
   * All queries run inside a single transaction so partial failures leave no torn state
   * (e.g. nodes archived but their dangling edges left live).
   * Per node-postgres docs, all statements in a transaction must share the same client.
   */
  async runDecayPass(): Promise<DecayPassResult> {
    const start = Date.now();
    this.logger.info('DreamEngine: decay pass starting');

    const { archiveThreshold, halfLifeDays } = this.config;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await this._runDecayPassOnClient(client, archiveThreshold, halfLifeDays);

      await client.query('COMMIT');

      const durationMs = Date.now() - start;
      this.logger.info(
        { ...result, durationMs },
        'DreamEngine: decay pass complete',
      );

      return { ...result, durationMs };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async _runDecayPassOnClient(
    client: PoolClient,
    archiveThreshold: number,
    halfLifeDays: DecayConfig['halfLifeDays'],
  ): Promise<Omit<DecayPassResult, 'durationMs'>> {
    // Pass 1a: Decay slow_decay nodes
    // Uses COALESCE(last_decayed_at, last_confirmed_at) so each run only applies
    // decay for the interval since the last run rather than re-applying the full
    // decay from last_confirmed_at to the already-decayed value (which would
    // compound faster than intended). Also sets last_decayed_at = now() so the
    // next run uses this timestamp as the reference point.
    const slowNodeResult = await client.query(
      `UPDATE kg_nodes
         SET confidence = confidence * power(0.5,
             EXTRACT(EPOCH FROM (now() - COALESCE(last_decayed_at, last_confirmed_at))) / 86400.0 / $1),
             last_decayed_at = now()
       WHERE archived_at IS NULL
         AND decay_class = $2
         AND confidence > $3`,
      [halfLifeDays.slow_decay, 'slow_decay', archiveThreshold],
    );

    // Pass 1b: Decay fast_decay nodes
    const fastNodeResult = await client.query(
      `UPDATE kg_nodes
         SET confidence = confidence * power(0.5,
             EXTRACT(EPOCH FROM (now() - COALESCE(last_decayed_at, last_confirmed_at))) / 86400.0 / $1),
             last_decayed_at = now()
       WHERE archived_at IS NULL
         AND decay_class = $2
         AND confidence > $3`,
      [halfLifeDays.fast_decay, 'fast_decay', archiveThreshold],
    );

    // Pass 1c: Decay slow_decay edges
    const slowEdgeResult = await client.query(
      `UPDATE kg_edges
         SET confidence = confidence * power(0.5,
             EXTRACT(EPOCH FROM (now() - COALESCE(last_decayed_at, last_confirmed_at))) / 86400.0 / $1),
             last_decayed_at = now()
       WHERE archived_at IS NULL
         AND decay_class = $2
         AND confidence > $3`,
      [halfLifeDays.slow_decay, 'slow_decay', archiveThreshold],
    );

    // Pass 1d: Decay fast_decay edges
    const fastEdgeResult = await client.query(
      `UPDATE kg_edges
         SET confidence = confidence * power(0.5,
             EXTRACT(EPOCH FROM (now() - COALESCE(last_decayed_at, last_confirmed_at))) / 86400.0 / $1),
             last_decayed_at = now()
       WHERE archived_at IS NULL
         AND decay_class = $2
         AND confidence > $3`,
      [halfLifeDays.fast_decay, 'fast_decay', archiveThreshold],
    );

    const nodesDecayed = (slowNodeResult.rowCount ?? 0) + (fastNodeResult.rowCount ?? 0);
    const edgesDecayed = (slowEdgeResult.rowCount ?? 0) + (fastEdgeResult.rowCount ?? 0);

    // Pass 1.5: Warn pass — flag important nodes approaching archive threshold.
    // "Important" = high sensitivity (confidential/restricted) OR high edge-count.
    // Edge-count threshold computed dynamically as p95 of all non-archived nodes,
    // with a floor of edgeCountFloor so the bar stays calibrated as the graph grows.

    // Step A: compute the edge-count threshold for this pass
    const thresholdResult = await client.query<{ threshold: number }>(
      `SELECT GREATEST(
         (SELECT percentile_disc($1) WITHIN GROUP (ORDER BY edge_count)
            FROM (
              SELECT n.id, COUNT(e.id) AS edge_count
                FROM kg_nodes n
                LEFT JOIN kg_edges e
                  ON (e.source_node_id = n.id OR e.target_node_id = n.id)
                 AND e.archived_at IS NULL
               WHERE n.archived_at IS NULL
               GROUP BY n.id
            ) sub
         ),
         $2
       ) AS threshold`,
      [this.config.edgeCountPercentile, this.config.edgeCountFloor],
    );
    const edgeCountThreshold = thresholdResult.rows[0]?.threshold ?? this.config.edgeCountFloor;

    // Step B: flag important nodes (skip already-warned nodes for idempotency)
    const warnResult = await client.query<{
      id: string;
      type: string;
      label: string;
      confidence: number;
      sensitivity: string;
      edge_count: string;
      warn_reason: string;
      warned_at: Date;
    }>(
      `WITH candidates AS (
         SELECT n.id, n.type, n.label, n.confidence, n.sensitivity,
                COUNT(e.id) AS edge_count,
                CASE
                  WHEN n.sensitivity IN ('confidential', 'restricted')
                   AND COUNT(e.id) >= $2 THEN 'both'
                  WHEN n.sensitivity IN ('confidential', 'restricted') THEN 'high_sensitivity'
                  ELSE 'high_connectivity'
                END AS reason
           FROM kg_nodes n
           LEFT JOIN kg_edges e
                  ON (e.source_node_id = n.id OR e.target_node_id = n.id)
                 AND e.archived_at IS NULL
          WHERE n.archived_at IS NULL
            AND n.warned_at IS NULL
            AND n.decay_class != 'permanent'
            AND n.confidence <= $1
          GROUP BY n.id, n.type, n.label, n.confidence, n.sensitivity
         HAVING n.sensitivity IN ('confidential', 'restricted')
             OR COUNT(e.id) >= $2
       )
       UPDATE kg_nodes
          SET warned_at = now(),
              warn_reason = candidates.reason
         FROM candidates
        WHERE kg_nodes.id = candidates.id
       RETURNING candidates.id,
                 candidates.type,
                 candidates.label,
                 candidates.confidence,
                 candidates.sensitivity,
                 candidates.edge_count,
                 candidates.reason AS warn_reason,
                 kg_nodes.warned_at`,
      [archiveThreshold, edgeCountThreshold],
    );

    const nodesWarned = warnResult.rowCount ?? 0;

    // Emit a bus event for each warned node (audit trail + future subscriber hooks)
    for (const row of warnResult.rows) {
      await this.bus.publish('system', createMemoryDecayWarning({
        nodeId: row.id,
        nodeType: row.type as MemoryDecayWarningPayload['nodeType'],
        label: row.label,
        confidence: row.confidence,
        sensitivity: row.sensitivity as MemoryDecayWarningPayload['sensitivity'],
        edgeCount: parseInt(row.edge_count, 10),
        reason: row.warn_reason as 'high_sensitivity' | 'high_connectivity' | 'both',
      }));
    }

    // Pass 2a: Archive expired warnings — nodes whose hold-back window has closed
    // without a CEO response. These were warned but never confirmed or dismissed.
    const archiveExpiredResult = await client.query(
      `UPDATE kg_nodes
          SET archived_at = now(),
              warned_at = NULL,
              warn_reason = NULL
        WHERE archived_at IS NULL
          AND warned_at IS NOT NULL
          AND warned_at <= now() - ($1 || ' days')::INTERVAL`,
      [this.config.warnHoldBackDays],
    );
    const nodesExpired = archiveExpiredResult.rowCount ?? 0;

    // Pass 2b: Archive regular nodes at or below threshold. Excludes:
    // - permanent nodes (never archived by design)
    // - nodes with an active warning still within hold-back window (warned_at IS NOT NULL)
    const archiveNodeResult = await client.query(
      `UPDATE kg_nodes
          SET archived_at = now()
        WHERE archived_at IS NULL
          AND decay_class != 'permanent'
          AND confidence <= $1
          AND warned_at IS NULL`,
      [archiveThreshold],
    );

    const nodesArchived = archiveNodeResult.rowCount ?? 0;

    // Pass 3: Archive edges whose endpoint was just archived, OR whose own confidence
    // is at or below threshold. Using archived_at IS NOT NULL for nodes catches both
    // the just-archived nodes from Passes 2a/2b and any previously archived nodes,
    // ensuring no edge is left dangling to an archived endpoint.
    const archiveEdgeResult = await client.query(
      `UPDATE kg_edges
         SET archived_at = now()
       WHERE archived_at IS NULL
         AND (
           confidence <= $1
           OR source_node_id IN (SELECT id FROM kg_nodes WHERE archived_at IS NOT NULL)
           OR target_node_id IN (SELECT id FROM kg_nodes WHERE archived_at IS NOT NULL)
         )`,
      [archiveThreshold],
    );

    const edgesArchived = archiveEdgeResult.rowCount ?? 0;

    return { nodesDecayed, edgesDecayed, nodesWarned, nodesExpired, nodesArchived, edgesArchived };
  }
}
