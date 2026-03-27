// src/contacts/held-messages.ts
//
// HeldMessageService: stores and manages messages from unknown senders.
//
// Follows the backend-interface pattern from ContactService / WorkingMemory:
// - Private constructor, static factory methods
// - InMemoryHeldMessageBackend for tests, PostgresHeldMessageBackend for production
// - Business logic (rate limiting, status transitions) lives in HeldMessageService,
//   backends are pure storage

import { randomUUID } from 'node:crypto';
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { HeldMessage, HeldMessageStatus } from './types.js';

// -- Default cap --
// 20 held messages per channel. Once the cap is hit, the oldest pending
// message for that channel is discarded to make room for the new one.
const DEFAULT_MAX_PER_CHANNEL = 20;

// -- Options --

export interface HoldOptions {
  channel: string;
  senderId: string;
  conversationId: string;
  content: string;
  subject: string | null;
  metadata: Record<string, unknown>;
}

// -- Backend interface --

interface HeldMessageBackend {
  /** Insert a new held message row. */
  insert(message: HeldMessage): Promise<void>;
  /** Count pending messages for a given channel. */
  countPending(channel: string): Promise<number>;
  /** Discard (mark discarded) the oldest pending message for a channel. */
  discardOldest(channel: string): Promise<void>;
  /** List all pending messages, optionally filtered by channel, sorted chronologically. */
  listPending(channel?: string): Promise<HeldMessage[]>;
  /** Retrieve a message by its ID, or null if not found. */
  getById(id: string): Promise<HeldMessage | null>;
  /** Transition a pending message to 'processed' and record the resolved contact.
   *  Returns true if the update succeeded (message was pending), false otherwise. */
  markProcessed(id: string, resolvedContactId: string, processedAt: Date): Promise<boolean>;
  /** Transition a pending message to 'discarded'.
   *  Returns true if the update succeeded (message was pending), false otherwise. */
  discard(id: string): Promise<boolean>;
}

/**
 * HeldMessageService stores messages from unknown senders while the CEO decides
 * what to do with them.
 *
 * Rate limiting: each channel has a cap (default 20). When the cap is reached,
 * the oldest pending message for that channel is automatically discarded to make
 * room. This prevents unbounded growth from spam without losing recent messages.
 *
 * TODO: Held message expiration/auto-discard timeout is deferred.
 * Messages are held indefinitely until the CEO acts. A future discard
 * process will need judgment and oversight — not a simple timer.
 */
export class HeldMessageService {
  private constructor(
    private backend: HeldMessageBackend,
    private maxPerChannel: number,
  ) {}

  /** Create a Postgres-backed instance for production use. */
  static createWithPostgres(pool: DbPool, logger: Logger, maxPerChannel = DEFAULT_MAX_PER_CHANNEL): HeldMessageService {
    return new HeldMessageService(new PostgresHeldMessageBackend(pool, logger), maxPerChannel);
  }

  /** Create an in-memory instance for testing. */
  static createInMemory(maxPerChannel = DEFAULT_MAX_PER_CHANNEL): HeldMessageService {
    return new HeldMessageService(new InMemoryHeldMessageBackend(), maxPerChannel);
  }

  /**
   * Hold an inbound message from an unknown sender.
   *
   * If the channel is already at the rate limit cap, the oldest pending
   * message for that channel is discarded before inserting the new one,
   * so the cap is never exceeded.
   *
   * Returns the new message's ID.
   */
  async hold(options: HoldOptions): Promise<string> {
    const now = new Date();
    const id = randomUUID();

    // Enforce rate limit: if at cap, discard oldest pending for this channel
    // before inserting. This keeps the per-channel queue bounded.
    const count = await this.backend.countPending(options.channel);
    if (count >= this.maxPerChannel) {
      await this.backend.discardOldest(options.channel);
    }

    const message: HeldMessage = {
      id,
      channel: options.channel,
      senderId: options.senderId,
      conversationId: options.conversationId,
      content: options.content,
      subject: options.subject,
      metadata: options.metadata,
      status: 'pending',
      resolvedContactId: null,
      createdAt: now,
      processedAt: null,
    };

    await this.backend.insert(message);
    return id;
  }

  /**
   * List pending held messages, optionally filtered by channel.
   * Results are sorted chronologically (oldest first).
   */
  async listPending(channel?: string): Promise<HeldMessage[]> {
    return this.backend.listPending(channel);
  }

  /** Retrieve a held message by ID. Returns null if not found. */
  async getById(id: string): Promise<HeldMessage | null> {
    return this.backend.getById(id);
  }

  /**
   * Mark a held message as processed after the CEO has identified the sender.
   * Records the resolved contact ID and timestamps the action.
   *
   * Only transitions messages with status 'pending' — returns false if the
   * message was already processed/discarded (defense-in-depth against races).
   */
  async markProcessed(id: string, resolvedContactId: string): Promise<boolean> {
    return this.backend.markProcessed(id, resolvedContactId, new Date());
  }

  /**
   * Discard a held message (e.g. CEO determined it is spam or irrelevant).
   *
   * Only transitions messages with status 'pending' — returns false if the
   * message was already processed/discarded.
   */
  async discard(id: string): Promise<boolean> {
    return this.backend.discard(id);
  }
}

// -- Postgres backend --

/**
 * Postgres-backed storage for held messages.
 * Uses parameterized queries throughout — never interpolates user input into SQL.
 */
class PostgresHeldMessageBackend implements HeldMessageBackend {
  constructor(
    private pool: DbPool,
    private logger: Logger,
  ) {}

  async insert(message: HeldMessage): Promise<void> {
    this.logger.debug({ messageId: message.id, channel: message.channel, senderId: message.senderId }, 'held_messages: inserting');
    await this.pool.query(
      `INSERT INTO held_messages
         (id, channel, sender_id, conversation_id, content, subject, metadata, status, resolved_contact_id, created_at, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        message.id,
        message.channel,
        message.senderId,
        message.conversationId,
        message.content,
        message.subject,
        JSON.stringify(message.metadata),
        message.status,
        message.resolvedContactId,
        message.createdAt,
        message.processedAt,
      ],
    );
  }

  async countPending(channel: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM held_messages WHERE channel = $1 AND status = 'pending'`,
      [channel],
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /**
   * Discard the oldest pending message for a channel in a single atomic UPDATE.
   * Uses a subquery to find the oldest row's ID, then updates it in one statement
   * — avoids a race between SELECT and UPDATE in concurrent scenarios.
   */
  async discardOldest(channel: string): Promise<void> {
    this.logger.debug({ channel }, 'held_messages: discarding oldest pending to enforce rate limit');
    await this.pool.query(
      `UPDATE held_messages SET status = 'discarded'
       WHERE id = (
         SELECT id FROM held_messages
         WHERE channel = $1 AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1
       )`,
      [channel],
    );
  }

  async listPending(channel?: string): Promise<HeldMessage[]> {
    if (channel !== undefined) {
      const result = await this.pool.query<HeldMessageRow>(
        `SELECT id, channel, sender_id, conversation_id, content, subject, metadata, status,
                resolved_contact_id, created_at, processed_at
         FROM held_messages
         WHERE status = 'pending' AND channel = $1
         ORDER BY created_at ASC`,
        [channel],
      );
      return result.rows.map((row) => this.rowToMessage(row));
    }

    const result = await this.pool.query<HeldMessageRow>(
      `SELECT id, channel, sender_id, conversation_id, content, subject, metadata, status,
              resolved_contact_id, created_at, processed_at
       FROM held_messages
       WHERE status = 'pending'
       ORDER BY created_at ASC`,
    );
    return result.rows.map((row) => this.rowToMessage(row));
  }

  async getById(id: string): Promise<HeldMessage | null> {
    const result = await this.pool.query<HeldMessageRow>(
      `SELECT id, channel, sender_id, conversation_id, content, subject, metadata, status,
              resolved_contact_id, created_at, processed_at
       FROM held_messages WHERE id = $1`,
      [id],
    );

    const row = result.rows[0];
    if (!row) return null;
    return this.rowToMessage(row);
  }

  async markProcessed(id: string, resolvedContactId: string, processedAt: Date): Promise<boolean> {
    this.logger.debug({ messageId: id, resolvedContactId }, 'held_messages: marking processed');
    // Atomic status guard: only transition pending → processed.
    // Prevents double-processing if two requests race on the same message.
    const result = await this.pool.query(
      `UPDATE held_messages
       SET status = 'processed', resolved_contact_id = $2, processed_at = $3
       WHERE id = $1 AND status = 'pending'`,
      [id, resolvedContactId, processedAt],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async discard(id: string): Promise<boolean> {
    this.logger.debug({ messageId: id }, 'held_messages: discarding');
    // Atomic status guard: only transition pending → discarded.
    const result = await this.pool.query(
      `UPDATE held_messages SET status = 'discarded' WHERE id = $1 AND status = 'pending'`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // -- Row mapping --

  private rowToMessage(row: HeldMessageRow): HeldMessage {
    return {
      id: row.id,
      channel: row.channel,
      senderId: row.sender_id,
      conversationId: row.conversation_id,
      content: row.content,
      subject: row.subject,
      // metadata is stored as JSON text in Postgres; pg driver may return it
      // as a string or already-parsed object depending on column type.
      metadata: typeof row.metadata === 'string'
        ? (JSON.parse(row.metadata) as Record<string, unknown>)
        : (row.metadata as Record<string, unknown>),
      status: row.status,
      resolvedContactId: row.resolved_contact_id,
      createdAt: row.created_at,
      processedAt: row.processed_at,
    };
  }
}

// Shape of a raw Postgres row from held_messages
interface HeldMessageRow {
  id: string;
  channel: string;
  sender_id: string;
  conversation_id: string;
  content: string;
  subject: string | null;
  metadata: unknown;
  status: HeldMessageStatus;
  resolved_contact_id: string | null;
  created_at: Date;
  processed_at: Date | null;
}

// -- In-memory backend --

/**
 * In-memory storage for testing. No database required.
 * Uses a Map keyed by message ID; list/filter operations do array scans.
 */
class InMemoryHeldMessageBackend implements HeldMessageBackend {
  private messages = new Map<string, HeldMessage>();

  async insert(message: HeldMessage): Promise<void> {
    this.messages.set(message.id, { ...message });
  }

  async countPending(channel: string): Promise<number> {
    let count = 0;
    for (const msg of this.messages.values()) {
      if (msg.channel === channel && msg.status === 'pending') {
        count++;
      }
    }
    return count;
  }

  async discardOldest(channel: string): Promise<void> {
    // Find the oldest pending message for the channel by scanning and tracking
    // the minimum createdAt. Insertion order of the Map doesn't guarantee
    // chronological order if messages arrive out of order.
    let oldest: HeldMessage | undefined;
    for (const msg of this.messages.values()) {
      if (msg.channel === channel && msg.status === 'pending') {
        if (!oldest || msg.createdAt < oldest.createdAt) {
          oldest = msg;
        }
      }
    }
    if (oldest) {
      this.messages.set(oldest.id, { ...oldest, status: 'discarded' });
    }
  }

  async listPending(channel?: string): Promise<HeldMessage[]> {
    const results: HeldMessage[] = [];
    for (const msg of this.messages.values()) {
      if (msg.status !== 'pending') continue;
      if (channel !== undefined && msg.channel !== channel) continue;
      results.push(msg);
    }
    // Sort chronologically — oldest first
    results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return results;
  }

  async getById(id: string): Promise<HeldMessage | null> {
    return this.messages.get(id) ?? null;
  }

  async markProcessed(id: string, resolvedContactId: string, processedAt: Date): Promise<boolean> {
    const msg = this.messages.get(id);
    // Status guard: only transition pending → processed (matches Postgres backend behavior)
    if (msg && msg.status === 'pending') {
      this.messages.set(id, { ...msg, status: 'processed', resolvedContactId, processedAt });
      return true;
    }
    return false;
  }

  async discard(id: string): Promise<boolean> {
    const msg = this.messages.get(id);
    // Status guard: only transition pending → discarded (matches Postgres backend behavior)
    if (msg && msg.status === 'pending') {
      this.messages.set(id, { ...msg, status: 'discarded' });
      return true;
    }
    return false;
  }
}
