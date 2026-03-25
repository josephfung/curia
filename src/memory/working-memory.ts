import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
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
 */
export class WorkingMemory {
  private backend: StorageBackend;

  private constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  /** Create a Postgres-backed instance for production use */
  static createWithPostgres(pool: DbPool, logger: Logger): WorkingMemory {
    return new WorkingMemory(new PostgresBackend(pool, logger));
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
 */
class PostgresBackend implements StorageBackend {
  constructor(private pool: DbPool, private logger: Logger) {}

  async add(conversationId: string, agentId: string, turn: ConversationTurn): Promise<void> {
    this.logger.debug({ conversationId, agentId, role: turn.role }, 'working_memory: adding turn');
    await this.pool.query(
      `INSERT INTO working_memory (conversation_id, agent_id, role, content)
       VALUES ($1, $2, $3, $4)`,
      [conversationId, agentId, turn.role, turn.content],
    );
  }

  async get(conversationId: string, agentId: string, maxTurns?: number): Promise<ConversationTurn[]> {
    const limit = maxTurns ?? 50;

    // Subquery gets the most recent N rows (newest first by created_at),
    // then outer query reverses to chronological order for LLM context.
    // This ensures we always get the LAST N turns, not the first N.
    const result = await this.pool.query<{ role: string; content: string }>(
      `SELECT role, content FROM (
         SELECT role, content, created_at
         FROM working_memory
         WHERE conversation_id = $1 AND agent_id = $2
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
}

/**
 * In-memory storage for testing. No database required.
 * Maintains insertion order so chronological retrieval works naturally.
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
