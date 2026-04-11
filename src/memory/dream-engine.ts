import type { Pool, PoolClient } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';

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
}

export interface DecayPassResult {
  nodesDecayed: number;
  edgesDecayed: number;
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
 * EventBus is injected now but unused — reserved for the decay warning pass (#280)
 * which will emit `memory.decay_warning` before archiving important nodes.
 */
export class DreamEngine {
  private pool: Pool;
  // EventBus reserved for decay warning pass (issue #280) — injected now so the
  // constructor signature doesn't need to change when that feature lands.
  private _bus: EventBus;
  private logger: Logger;
  private config: DecayConfig;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(pool: Pool, bus: EventBus, logger: Logger, config: DecayConfig) {
    this.pool = pool;
    this._bus = bus;
    this.logger = logger;
    this.config = config;
  }

  /**
   * Start the recurring decay interval.
   * Logs the configured cadence so operators can verify the schedule at startup.
   */
  start(): void {
    this.intervalHandle = setInterval(() => {
      this.runDecayPass().catch((err) => {
        this.logger.error({ err }, 'DreamEngine: unhandled error in runDecayPass');
      });
    }, this.config.intervalMs);

    this.logger.info(
      { intervalMs: this.config.intervalMs, archiveThreshold: this.config.archiveThreshold },
      'DreamEngine started (decay pass scheduled)',
    );
  }

  /** Stop the interval timer for clean shutdown. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
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

    // Pass 2: Archive nodes at or below threshold (permanent nodes are never archived)
    const archiveNodeResult = await client.query(
      `UPDATE kg_nodes
         SET archived_at = now()
       WHERE archived_at IS NULL
         AND decay_class != 'permanent'
         AND confidence <= $1`,
      [archiveThreshold],
    );

    const nodesArchived = archiveNodeResult.rowCount ?? 0;

    // Pass 3: Archive edges whose endpoint was just archived, OR whose own confidence
    // is at or below threshold. Using archived_at IS NOT NULL for nodes catches both
    // the just-archived nodes from Pass 2 and any previously archived nodes, ensuring
    // no edge is left dangling to an archived endpoint.
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

    return { nodesDecayed, edgesDecayed, nodesArchived, edgesArchived };
  }
}
