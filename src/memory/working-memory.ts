import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { LLMProvider } from '../agents/llm/provider.js';

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Configuration for rolling context summarization.
 * When the active turn count exceeds `threshold`, the oldest (count - keepWindow) turns
 * are condensed into a single synthetic system turn and marked archived in the DB.
 */
export interface SummarizationConfig {
  /** Number of active turns that triggers a summarization pass. Default: 20. */
  threshold: number;
  /** Number of most-recent turns to retain as active after summarization. Default: 10. */
  keepWindow: number;
  /** LLM provider used for the condensation call — same provider the agent uses. */
  provider: LLMProvider;
}

interface StorageBackend {
  add(conversationId: string, agentId: string, turn: ConversationTurn): Promise<void>;
  get(conversationId: string, agentId: string, maxTurns?: number): Promise<ConversationTurn[]>;
}

/**
 * Working memory stores conversation turns per conversation + agent pair.
 * This is Tier 1 memory — short-lived, scoped to a conversation, survives restarts.
 *
 * Uses a backend interface so unit tests can use in-memory storage
 * while production uses Postgres.
 *
 * When a `SummarizationConfig` is provided, the Postgres backend automatically
 * summarizes old turns once the active count exceeds `threshold`. Summarized turns
 * are marked `archived = true` in the DB (retained for audit) and replaced in active
 * context by a condensed synthetic system turn. See spec §01-memory-system.md.
 */
export class WorkingMemory {
  private backend: StorageBackend;

  private constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  /** Create a Postgres-backed instance for production use */
  static createWithPostgres(
    pool: DbPool,
    logger: Logger,
    summarization?: SummarizationConfig,
  ): WorkingMemory {
    return new WorkingMemory(new PostgresBackend(pool, logger, summarization));
  }

  /** Create an in-memory instance for testing */
  static createInMemory(): WorkingMemory {
    return new WorkingMemory(new InMemoryBackend());
  }

  async addTurn(
    conversationId: string,
    agentId: string,
    turn: ConversationTurn,
  ): Promise<void> {
    await this.backend.add(conversationId, agentId, turn);
  }

  async getHistory(
    conversationId: string,
    agentId: string,
    options?: { maxTurns?: number },
  ): Promise<ConversationTurn[]> {
    return this.backend.get(conversationId, agentId, options?.maxTurns);
  }
}

/**
 * Postgres-backed storage. Conversation turns are rows in the working_memory table.
 * History is returned in chronological order (oldest first) so the LLM sees
 * the conversation in natural reading order.
 *
 * When summarization is configured, `add()` triggers a summarization check after
 * every write. Archived rows stay in the DB but are excluded from `get()` results.
 */
class PostgresBackend implements StorageBackend {
  constructor(
    private pool: DbPool,
    private logger: Logger,
    private summarization?: SummarizationConfig,
  ) {}

  async add(conversationId: string, agentId: string, turn: ConversationTurn): Promise<void> {
    this.logger.debug({ conversationId, agentId, role: turn.role }, 'working_memory: adding turn');
    await this.pool.query(
      `INSERT INTO working_memory (conversation_id, agent_id, role, content)
       VALUES ($1, $2, $3, $4)`,
      [conversationId, agentId, turn.role, turn.content],
    );

    // After writing, check whether we've crossed the summarization threshold.
    // Summarization is best-effort — a failure must not abort the agent turn since
    // the turn has already been persisted. Catch here (not inside maybeSummarize)
    // so errors propagate cleanly out of the private method and the non-fatal
    // decision is explicit and visible at the call site.
    if (this.summarization) {
      try {
        await this.maybeSummarize(conversationId, agentId, this.summarization);
      } catch (err) {
        this.logger.error(
          { err, conversationId, agentId },
          'working_memory: summarization failed — turn written, context window will grow until next successful pass',
        );
      }
    }
  }

  async get(conversationId: string, agentId: string, maxTurns?: number): Promise<ConversationTurn[]> {
    const limit = maxTurns ?? 50;

    // Subquery gets the most recent N active (non-archived) rows (newest first),
    // then the outer query reverses to chronological order for LLM context.
    // Archived rows are excluded — they're represented by the synthetic summary turn.
    const result = await this.pool.query<{ role: string; content: string }>(
      `SELECT role, content FROM (
         SELECT role, content, created_at
         FROM working_memory
         WHERE conversation_id = $1
           AND agent_id = $2
           AND archived = false
         ORDER BY created_at DESC
         LIMIT $3
       ) sub ORDER BY created_at ASC`,
      [conversationId, agentId, limit],
    );

    return result.rows.map((row) => ({
      role: row.role as ConversationTurn['role'],
      content: row.content,
    }));
  }

  /**
   * Check whether the active turn count has crossed the summarization threshold.
   * If so, archive the oldest (count - keepWindow) turns and replace them with
   * a condensed synthetic system turn at the head of the kept window.
   *
   * Failures are logged but do NOT propagate — a failed summarization is preferable
   * to aborting the agent turn. The next add() will retry automatically.
   */
  private async maybeSummarize(
    conversationId: string,
    agentId: string,
    config: SummarizationConfig,
  ): Promise<void> {
    const { threshold, keepWindow, provider } = config;

    // Count active (non-archived) turns for this conversation+agent
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM working_memory
       WHERE conversation_id = $1
         AND agent_id = $2
         AND archived = false`,
      [conversationId, agentId],
    );

    // COUNT(*) always returns exactly one row — if it doesn't, something is structurally wrong.
    const countRow = countResult.rows[0];
    if (!countRow) {
      throw new Error('working_memory: COUNT(*) returned no rows — unexpected database driver behavior');
    }
    const activeCount = parseInt(countRow.count, 10);
    if (isNaN(activeCount)) {
      throw new Error(`working_memory: COUNT(*) returned non-numeric value: ${countRow.count}`);
    }

    if (activeCount <= threshold) {
      return; // Below threshold — nothing to do
    }

    const toArchiveCount = activeCount - keepWindow;
    if (toArchiveCount <= 0) {
      return;
    }

    this.logger.info(
      { conversationId, agentId, activeCount, toArchiveCount, keepWindow },
      'working_memory: threshold exceeded, summarizing oldest turns',
    );

    // Fetch the oldest toArchiveCount active rows in chronological order.
    // Existing synthetic summary turns (role = 'system') are included so the new
    // summary absorbs prior summaries rather than leaving orphaned ones behind.
    const turnsResult = await this.pool.query<{ id: string; role: string; content: string; created_at: Date }>(
      `SELECT id, role, content, created_at
       FROM working_memory
       WHERE conversation_id = $1
         AND agent_id = $2
         AND archived = false
       ORDER BY created_at ASC
       LIMIT $3`,
      [conversationId, agentId, toArchiveCount],
    );

    const turnsToArchive = turnsResult.rows;
    if (turnsToArchive.length === 0) {
      return;
    }

    // Build the summarization prompt from the turns being archived.
    // Prior summaries (system role) are labelled distinctly so the LLM carries them forward.
    const transcript = turnsToArchive
      .map((t) => {
        const label = t.role === 'system' ? 'PRIOR SUMMARY' : t.role.toUpperCase();
        return `[${label}]: ${t.content}`;
      })
      .join('\n\n');

    const summaryPrompt = [
      'You are a precise summarizer. Condense the following conversation excerpt into a concise narrative.',
      'Preserve: key decisions made, entities discussed (people, projects, companies), and any commitments or action items.',
      'Omit: small talk, repeated questions, verbatim tool outputs.',
      'Output only the summary — no preamble, no meta-commentary.',
      '',
      transcript,
    ].join('\n');

    const response = await provider.chat({
      messages: [{ role: 'user', content: summaryPrompt }],
    });

    if (response.type === 'error') {
      // Propagates to add()'s catch — full AgentError struct preserved in the log there.
      throw Object.assign(
        new Error(`working_memory: summarization LLM call failed — ${response.error.message}`),
        { agentError: response.error },
      );
    }
    if (response.type !== 'text' || !response.content.trim()) {
      throw new Error(
        `working_memory: summarization LLM call returned unexpected non-text response type "${response.type}"`,
      );
    }
    const summaryContent = response.content.trim();

    // The synthetic summary is inserted 1ms before the oldest *kept* turn so that
    // chronological ordering places it at the head of the active window.
    const oldestKeptResult = await this.pool.query<{ created_at: Date }>(
      `SELECT created_at
       FROM working_memory
       WHERE conversation_id = $1
         AND agent_id = $2
         AND archived = false
         AND id != ALL($3::uuid[])
       ORDER BY created_at ASC
       LIMIT 1`,
      [conversationId, agentId, turnsToArchive.map((t) => t.id)],
    );

    // If toArchiveCount < activeCount, there must always be at least one kept row.
    // No kept row means a concurrent write changed the count between our COUNT query
    // and this SELECT — abort to avoid inserting a misanchored summary.
    if (!oldestKeptResult.rows[0]) {
      throw new Error(
        'working_memory: kept-row invariant violated (possible concurrent write) — aborting summarization',
      );
    }
    const summaryTimestamp = new Date(oldestKeptResult.rows[0].created_at.getTime() - 1);

    // Atomic transaction: archive old turns + insert synthetic summary.
    // If either step fails the whole operation rolls back — no partial state.
    const archiveIds = turnsToArchive.map((t) => t.id);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE working_memory
         SET archived = true
         WHERE id = ANY($1::uuid[])`,
        [archiveIds],
      );

      await client.query(
        `INSERT INTO working_memory (conversation_id, agent_id, role, content, created_at)
         VALUES ($1, $2, 'system', $3, $4)`,
        [conversationId, agentId, `[Conversation summary]\n${summaryContent}`, summaryTimestamp],
      );

      await client.query('COMMIT');
      this.logger.info(
        { conversationId, agentId, archivedCount: archiveIds.length },
        'working_memory: summarization complete',
      );
    } catch (err) {
      // Guard the ROLLBACK itself — if the connection was dropped it may throw.
      // We still want to log and propagate the original error, not replace it.
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        this.logger.error(
          { err: rollbackErr, conversationId, agentId },
          'working_memory: ROLLBACK failed after transaction error — connection may be in bad state',
        );
      }
      // Propagate to add()'s catch so the non-fatal policy is applied at the call site.
      throw err;
    } finally {
      // Guard release() so it cannot replace the original error with its own exception.
      try {
        client.release();
      } catch (releaseErr) {
        this.logger.error(
          { err: releaseErr, conversationId, agentId },
          'working_memory: pg client release failed — connection may leak from pool',
        );
      }
    }
  }
}

/**
 * In-memory storage for testing. No database required.
 * Maintains insertion order so chronological retrieval works naturally.
 * Does not implement summarization — use integration tests for end-to-end coverage.
 */
class InMemoryBackend implements StorageBackend {
  private store = new Map<string, ConversationTurn[]>();

  private key(conversationId: string, agentId: string): string {
    return `${conversationId}:${agentId}`;
  }

  async add(conversationId: string, agentId: string, turn: ConversationTurn): Promise<void> {
    const k = this.key(conversationId, agentId);
    const turns = this.store.get(k) ?? [];
    turns.push(turn);
    this.store.set(k, turns);
  }

  async get(conversationId: string, agentId: string, maxTurns?: number): Promise<ConversationTurn[]> {
    const k = this.key(conversationId, agentId);
    const turns = this.store.get(k) ?? [];
    if (maxTurns && turns.length > maxTurns) {
      // Return the last N turns (most recent), preserving chronological order
      return turns.slice(-maxTurns);
    }
    return [...turns];
  }
}
