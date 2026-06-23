import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import type { TaskOriginator } from '../contacts/types.js';

// Postgres error code for unique_violation — used to detect concurrent duplicate
// INSERT on source_message_id and recover into the dedup path instead of failing.
function isUniqueConstraintViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

// -- Public types --

export interface BullpenThread {
  id: string;
  topic: string;
  creatorAgentId: string;
  participants: string[];
  status: 'open' | 'closed';
  messageCount: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  // Stored at thread-creation time so the poll-fallback path (when the initial
  // agent.discuss publish fails) can rehydrate the originator when dispatching
  // participant tasks. null for threads opened without an authenticated originator.
  originator: TaskOriginator | null;
  // Optional dedup key. When set, openThread is idempotent: a second call with the
  // same sourceMessageId returns the existing thread instead of creating a new one.
  // Used by ceo-inbox to prevent duplicate bullpen threads when the high-water mark
  // save is interrupted and the next run re-processes the same email. (issue #708)
  sourceMessageId: string | null;
}

export interface BullpenMessage {
  id: string;
  threadId: string;
  senderType: 'agent';
  senderId: string;
  content: string;
  mentionedAgentIds: string[];
  createdAt: Date;
}

export interface PendingThreadContext {
  threadId: string;
  topic: string;
  totalMessages: number;
  recentMessages: Array<{
    senderAgentId: string;
    content: string;
    mentionedAgentIds: string[];
    createdAt: Date;
  }>;
}

// Maximum messages shown per thread in the ambient context. When a thread exceeds
// this limit, the first message (original request) is always pinned so agents never
// lose the context that gave the thread its purpose, plus the last (LIMIT-1) most
// recent messages. At 15 the tail covers most real threads in full; the first-pin
// only kicks in for genuinely long conversations. (#1090)
const RECENT_MSG_LIMIT = 15;

// -- Backend interface --

interface BullpenBackend {
  openThread(thread: BullpenThread, message: BullpenMessage): Promise<void>;
  // closeAfter, when true, marks the thread closed in the same operation that
  // persists the message — the message is always written first (see #881).
  postMessage(threadId: string, message: BullpenMessage, closeAfter?: boolean): Promise<void>;
  closeThread(threadId: string): Promise<void>;
  getThread(threadId: string): Promise<{ thread: BullpenThread; messages: BullpenMessage[] } | null>;
  findThreadBySourceMessageId(sourceMessageId: string): Promise<{ thread: BullpenThread; message: BullpenMessage } | null>;
  getPendingThreadsForAgent(agentId: string, windowMs: number): Promise<PendingThreadContext[]>;
  // Advance the per-agent read watermark for the given threads to each thread's current
  // last_message_at. Unknown thread ids are ignored. Idempotent and monotonic (#1065).
  markThreadsSeen(agentId: string, threadIds: string[]): Promise<void>;
}

// -- In-memory backend (for unit tests) --

class InMemoryBullpenBackend implements BullpenBackend {
  private threads = new Map<string, BullpenThread>();
  private messages = new Map<string, BullpenMessage[]>();
  // Maps sourceMessageId -> threadId for dedup lookups.
  private sourceIdToThreadId = new Map<string, string>();
  // Per-agent read watermark: `${threadId}:${agentId}` -> seenThrough. Mirrors the
  // bullpen_thread_reads table in the Postgres backend (#1065).
  private reads = new Map<string, Date>();

  async openThread(thread: BullpenThread, message: BullpenMessage): Promise<void> {
    if (thread.sourceMessageId && this.sourceIdToThreadId.has(thread.sourceMessageId)) {
      // Mirrors Postgres 23505 unique_violation so BullpenService.openThread's
      // catch-and-retry path exercises the same recovery logic in unit tests.
      const err = new Error('unique constraint violation (source_message_id)');
      (err as unknown as { code: string }).code = '23505';
      throw err;
    }
    this.threads.set(thread.id, { ...thread });
    this.messages.set(thread.id, [{ ...message }]);
    if (thread.sourceMessageId) {
      this.sourceIdToThreadId.set(thread.sourceMessageId, thread.id);
    }
  }

  async findThreadBySourceMessageId(sourceMessageId: string): Promise<{ thread: BullpenThread; message: BullpenMessage } | null> {
    const threadId = this.sourceIdToThreadId.get(sourceMessageId);
    if (!threadId) return null;
    const thread = this.threads.get(threadId);
    const msgs = this.messages.get(threadId);
    if (!thread || !msgs || msgs.length === 0) return null;
    return { thread: { ...thread }, message: { ...msgs[0]! } };
  }

  async postMessage(threadId: string, message: BullpenMessage, closeAfter = false): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    thread.messageCount++;
    thread.lastMessageAt = message.createdAt;
    const msgs = this.messages.get(threadId) ?? [];
    msgs.push({ ...message });
    this.messages.set(threadId, msgs);
    // Close after the message is appended so the reply is never lost (#881).
    if (closeAfter) thread.status = 'closed';
  }

  async closeThread(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (thread) thread.status = 'closed';
  }

  async getThread(threadId: string): Promise<{ thread: BullpenThread; messages: BullpenMessage[] } | null> {
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    return { thread: { ...thread }, messages: [...(this.messages.get(threadId) ?? [])] };
  }

  async getPendingThreadsForAgent(agentId: string, windowMs: number): Promise<PendingThreadContext[]> {
    const cutoff = new Date(Date.now() - windowMs);
    const result: PendingThreadContext[] = [];

    for (const [threadId, thread] of this.threads) {
      if (thread.status !== 'open') continue;
      if (!thread.participants.includes(agentId)) continue;
      if (!thread.lastMessageAt || thread.lastMessageAt < cutoff) continue;

      // Read watermark (#1065): skip threads the agent has already seen up to their
      // current latest message — only re-surface when newer activity has arrived.
      const seenThrough = this.reads.get(`${threadId}:${agentId}`);
      if (seenThrough && thread.lastMessageAt <= seenThrough) continue;

      const msgs = this.messages.get(threadId) ?? [];
      if (msgs.length === 0) continue;

      const lastMsg = msgs[msgs.length - 1]!;
      if (lastMsg.senderId === agentId) continue;

      // Pin the first message so the original request is always visible, then fill
      // the rest of the window with the most recent messages (#1090). When the thread
      // is short enough to fit in the window we take all messages as-is.
      const selected = msgs.length <= RECENT_MSG_LIMIT
        ? msgs
        : [msgs[0]!, ...msgs.slice(-(RECENT_MSG_LIMIT - 1))];
      const recentMessages = selected.map(m => ({
        senderAgentId: m.senderId,
        content: m.content,
        mentionedAgentIds: m.mentionedAgentIds,
        createdAt: m.createdAt,
      }));

      result.push({ threadId, topic: thread.topic, totalMessages: thread.messageCount, recentMessages });
    }

    return result
      .sort((a, b) => {
        const ta = this.threads.get(a.threadId)?.lastMessageAt?.getTime() ?? 0;
        const tb = this.threads.get(b.threadId)?.lastMessageAt?.getTime() ?? 0;
        return tb - ta;
      })
      .slice(0, 5);
  }

  async markThreadsSeen(agentId: string, threadIds: string[]): Promise<void> {
    for (const threadId of threadIds) {
      const thread = this.threads.get(threadId);
      // Stamp to the thread's current latest message; ignore unknown threads and threads
      // with no messages. Monotonic: never move the watermark backwards.
      if (!thread || !thread.lastMessageAt) continue;
      const key = `${threadId}:${agentId}`;
      const existing = this.reads.get(key);
      if (!existing || thread.lastMessageAt > existing) {
        this.reads.set(key, thread.lastMessageAt);
      }
    }
  }
}

// -- Postgres backend --

class PostgresBullpenBackend implements BullpenBackend {
  constructor(private pool: Pool, private logger: Logger) {}

  async openThread(thread: BullpenThread, message: BullpenMessage): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO bullpen_threads (id, topic, creator_agent_id, participants, status, message_count, last_message_at, created_at, originator, source_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [thread.id, thread.topic, thread.creatorAgentId, thread.participants, thread.status, thread.messageCount, thread.lastMessageAt, thread.createdAt, thread.originator ? JSON.stringify(thread.originator) : null, thread.sourceMessageId ?? null],
      );
      await client.query(
        `INSERT INTO bullpen_messages (id, thread_id, sender_type, sender_id, content, mentioned_agent_ids, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [message.id, message.threadId, message.senderType, message.senderId, JSON.stringify(message.content), message.mentionedAgentIds, message.createdAt],
      );
      await client.query('COMMIT');
    } catch (err) {
      this.logger.error({ err, threadId: thread.id, sourceMessageId: thread.sourceMessageId }, 'Bullpen openThread transaction failed');
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async postMessage(threadId: string, message: BullpenMessage, closeAfter = false): Promise<void> {
    // Atomically insert the message and conditionally increment message_count.
    // The UPDATE uses WHERE status='open' AND message_count<100 so that concurrent
    // close or cap-reaching posts are rejected at the DB level, not just app level.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO bullpen_messages (id, thread_id, sender_type, sender_id, content, mentioned_agent_ids, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [message.id, threadId, message.senderType, message.senderId, JSON.stringify(message.content), message.mentionedAgentIds, message.createdAt],
      );
      // When closeAfter is set, flip status to 'closed' in the same UPDATE that
      // records the message — the INSERT above runs first, so the reply is always
      // persisted, and the close is atomic with it (#881). The WHERE status='open'
      // guard means we only ever close a thread that was open at write time.
      const updateRes = await client.query<{ message_count: number }>(
        `UPDATE bullpen_threads
         SET message_count = message_count + 1,
             last_message_at = $1,
             status = CASE WHEN $3 THEN 'closed' ELSE status END
         WHERE id = $2 AND status = 'open' AND message_count < 100
         RETURNING message_count`,
        [message.createdAt, threadId, closeAfter],
      );
      if (updateRes.rows.length === 0) {
        // Thread is closed or at cap — roll back the message insert.
        throw new Error(`Thread ${threadId} is closed or has reached the message cap`);
      }
      await client.query('COMMIT');
    } catch (err) {
      this.logger.error({ err, threadId }, 'Bullpen postMessage transaction failed');
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async closeThread(threadId: string): Promise<void> {
    await this.pool.query(
      `UPDATE bullpen_threads SET status = 'closed' WHERE id = $1`,
      [threadId],
    );
  }

  async getThread(threadId: string): Promise<{ thread: BullpenThread; messages: BullpenMessage[] } | null> {
    const threadRes = await this.pool.query<{
      id: string; topic: string; creator_agent_id: string; participants: string[];
      status: string; message_count: number; last_message_at: Date | null; created_at: Date;
      originator: Record<string, unknown> | null; source_message_id: string | null;
    }>(
      `SELECT id, topic, creator_agent_id, participants, status, message_count, last_message_at, created_at, originator, source_message_id
       FROM bullpen_threads WHERE id = $1`,
      [threadId],
    );
    if (threadRes.rows.length === 0) return null;
    const row = threadRes.rows[0]!;
    const thread: BullpenThread = {
      id: row.id, topic: row.topic, creatorAgentId: row.creator_agent_id,
      participants: row.participants, status: row.status as 'open' | 'closed',
      messageCount: row.message_count, lastMessageAt: row.last_message_at, createdAt: row.created_at,
      originator: row.originator as TaskOriginator | null,
      sourceMessageId: row.source_message_id,
    };

    const msgRes = await this.pool.query<{
      id: string; thread_id: string; sender_type: string; sender_id: string;
      content: unknown; mentioned_agent_ids: string[]; created_at: Date;
    }>(
      `SELECT id, thread_id, sender_type, sender_id, content, mentioned_agent_ids, created_at
       FROM bullpen_messages WHERE thread_id = $1 ORDER BY created_at ASC`,
      [threadId],
    );
    const messages: BullpenMessage[] = msgRes.rows.map(m => ({
      id: m.id, threadId: m.thread_id, senderType: 'agent' as const,
      senderId: m.sender_id,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      mentionedAgentIds: m.mentioned_agent_ids, createdAt: m.created_at,
    }));

    return { thread, messages };
  }

  async findThreadBySourceMessageId(sourceMessageId: string): Promise<{ thread: BullpenThread; message: BullpenMessage } | null> {
    // Single JOIN avoids the two-query split-snapshot window: if the thread row and
    // its first message row are in the same committed transaction, this query reads
    // them atomically. If the thread exists but has no messages (data corruption),
    // the JOIN returns no rows and we return null.
    const res = await this.pool.query<{
      id: string; topic: string; creator_agent_id: string; participants: string[];
      status: string; message_count: number; last_message_at: Date | null; created_at: Date;
      originator: Record<string, unknown> | null; source_message_id: string | null;
      msg_id: string; msg_sender_id: string; msg_content: unknown;
      msg_mentioned_agent_ids: string[]; msg_created_at: Date;
    }>(
      `SELECT t.id, t.topic, t.creator_agent_id, t.participants, t.status,
              t.message_count, t.last_message_at, t.created_at, t.originator, t.source_message_id,
              m.id AS msg_id, m.sender_id AS msg_sender_id, m.content AS msg_content,
              m.mentioned_agent_ids AS msg_mentioned_agent_ids, m.created_at AS msg_created_at
       FROM bullpen_threads t
       JOIN bullpen_messages m ON m.thread_id = t.id
       WHERE t.source_message_id = $1
       ORDER BY m.created_at ASC
       LIMIT 1`,
      [sourceMessageId],
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0]!;
    const thread: BullpenThread = {
      id: row.id, topic: row.topic, creatorAgentId: row.creator_agent_id,
      participants: row.participants, status: row.status as 'open' | 'closed',
      messageCount: row.message_count, lastMessageAt: row.last_message_at, createdAt: row.created_at,
      originator: row.originator as TaskOriginator | null,
      sourceMessageId: row.source_message_id,
    };
    const message: BullpenMessage = {
      id: row.msg_id, threadId: row.id, senderType: 'agent' as const,
      senderId: row.msg_sender_id,
      content: typeof row.msg_content === 'string' ? row.msg_content : JSON.stringify(row.msg_content),
      mentionedAgentIds: row.msg_mentioned_agent_ids, createdAt: row.msg_created_at,
    };
    return { thread, message };
  }

  async getPendingThreadsForAgent(agentId: string, windowMs: number): Promise<PendingThreadContext[]> {
    const windowSeconds = windowMs / 1000;
    const threadsRes = await this.pool.query<{
      id: string; topic: string; message_count: number; last_message_at: Date;
    }>(
      // LEFT JOIN the per-agent read watermark and skip threads the agent has already
      // seen up to their current latest message (#1065): a thread re-surfaces only when
      // last_message_at advances past seen_through, so a handled out-of-band request is
      // not re-actioned on a later wake.
      `SELECT t.id, t.topic, t.message_count, t.last_message_at
       FROM bullpen_threads t
       LEFT JOIN bullpen_thread_reads r ON r.thread_id = t.id AND r.agent_id = $1
       WHERE t.status = 'open'
         AND t.participants @> ARRAY[$1]::text[]
         AND t.last_message_at > NOW() - ($2::numeric * INTERVAL '1 second')
         AND (r.seen_through IS NULL OR t.last_message_at > r.seen_through)
         AND (
           SELECT sender_id FROM bullpen_messages
           WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1
         ) != $1
       ORDER BY t.last_message_at DESC
       LIMIT 5`,
      [agentId, windowSeconds],
    );

    const results: PendingThreadContext[] = [];
    for (const row of threadsRes.rows) {
      // Pin the first message (original request) plus the last (LIMIT-1) most recent
      // messages so agents on long threads always have the founding context (#1090).
      // ROW_NUMBER() produces exactly one row per physical message, so the WHERE
      // (rn_asc=1 OR rn_desc<=14) selects a disjoint or overlapping subset with no
      // duplicates — DISTINCT is intentionally omitted (it would collapse genuinely
      // distinct messages that happen to share payload values).
      const msgsRes = await this.pool.query<{
        sender_id: string; content: unknown; mentioned_agent_ids: string[]; created_at: Date;
      }>(
        `WITH ranked AS (
           SELECT sender_id, content, mentioned_agent_ids, created_at,
             ROW_NUMBER() OVER (ORDER BY created_at ASC)  AS rn_asc,
             ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn_desc
           FROM bullpen_messages
           WHERE thread_id = $1
         )
         SELECT sender_id, content, mentioned_agent_ids, created_at
         FROM ranked
         WHERE rn_asc = 1 OR rn_desc <= $2
         ORDER BY created_at ASC`,
        [row.id, RECENT_MSG_LIMIT - 1],
      );
      if (msgsRes.rows.length === 0) {
        // The outer query confirmed this thread has messages, but the CTE found none —
        // data inconsistency or a very tight race with deletion. Skip rather than inject
        // an empty context block that would confuse the agent.
        this.logger.error({ threadId: row.id }, 'Bullpen getPendingThreadsForAgent: CTE returned 0 rows for thread with messages — skipping');
        continue;
      }
      const recentMessages = msgsRes.rows.map(m => ({
        senderAgentId: m.sender_id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        mentionedAgentIds: m.mentioned_agent_ids,
        createdAt: m.created_at,
      }));
      results.push({ threadId: row.id, topic: row.topic, totalMessages: row.message_count, recentMessages });
    }
    return results;
  }

  async markThreadsSeen(agentId: string, threadIds: string[]): Promise<void> {
    if (threadIds.length === 0) return;
    // Stamp seen_through to each thread's *current* last_message_at, read inside the
    // upsert so the caller only passes ids. GREATEST keeps the watermark monotonic so a
    // concurrent stamp from an earlier-state task can't move it backwards. Threads with a
    // NULL last_message_at (no messages) are skipped by the SELECT's WHERE. (#1065)
    await this.pool.query(
      `INSERT INTO bullpen_thread_reads (thread_id, agent_id, seen_through, updated_at)
       SELECT t.id, $1, t.last_message_at, now()
       FROM bullpen_threads t
       WHERE t.id = ANY($2::uuid[]) AND t.last_message_at IS NOT NULL
       ON CONFLICT (thread_id, agent_id)
       DO UPDATE SET seen_through = GREATEST(bullpen_thread_reads.seen_through, EXCLUDED.seen_through),
                     updated_at = now()`,
      [agentId, threadIds],
    );
  }
}

// -- BullpenService --

export class BullpenService {
  private backend: BullpenBackend;

  private constructor(backend: BullpenBackend) {
    this.backend = backend;
  }

  static createWithPostgres(pool: Pool, logger: Logger): BullpenService {
    return new BullpenService(new PostgresBullpenBackend(pool, logger));
  }

  static createInMemory(): BullpenService {
    return new BullpenService(new InMemoryBullpenBackend());
  }

  async openThread(
    topic: string,
    creatorAgentId: string,
    participants: string[],
    initialContent: string,
    mentionedAgentIds: string[],
    originator?: TaskOriginator,
    sourceMessageId?: string,
  ): Promise<{ thread: BullpenThread; message: BullpenMessage; deduplicated: boolean }> {
    // Idempotency: if a sourceMessageId was provided and a thread already exists for
    // that message, return it instead of creating a duplicate. Protects against the
    // ceo-inbox race where the high-water mark save is interrupted between runs. (#708)
    if (sourceMessageId) {
      const existing = await this.backend.findThreadBySourceMessageId(sourceMessageId);
      if (existing) return { ...existing, deduplicated: true };
    }

    // Normalize: always include the creator, deduplicate, preserve order.
    const normalizedParticipants = [...new Set([creatorAgentId, ...participants])];
    const now = new Date();
    const thread: BullpenThread = {
      id: randomUUID(), topic, creatorAgentId, participants: normalizedParticipants,
      status: 'open', messageCount: 1, lastMessageAt: now, createdAt: now,
      // Persist originator so BullpenDispatcher can rehydrate it on the poll-fallback
      // path if the initial agent.discuss event publish fails.
      originator: originator ?? null,
      sourceMessageId: sourceMessageId ?? null,
    };
    const message: BullpenMessage = {
      id: randomUUID(), threadId: thread.id, senderType: 'agent',
      senderId: creatorAgentId, content: initialContent,
      mentionedAgentIds, createdAt: now,
    };
    try {
      await this.backend.openThread(thread, message);
    } catch (err: unknown) {
      // If a concurrent openThread call won the race and its INSERT committed
      // first, we hit the unique constraint on source_message_id (Postgres error
      // code 23505). Re-fetch the winning thread and return it as a dedup hit
      // rather than propagating a skill failure to the caller.
      if (sourceMessageId && isUniqueConstraintViolation(err)) {
        const existing = await this.backend.findThreadBySourceMessageId(sourceMessageId);
        if (existing) return { ...existing, deduplicated: true };
      }
      throw err;
    }
    return { thread, message, deduplicated: false };
  }

  async postMessage(
    threadId: string,
    senderAgentId: string,
    content: string,
    mentionedAgentIds: string[],
    // When true, the thread is closed atomically with this reply (#881). Unlike the
    // explicit closeThread action, close_after is a soft conclusion signal available
    // to any replying participant — the participant check below is the only gate.
    closeAfter = false,
  ): Promise<BullpenMessage> {
    const existing = await this.backend.getThread(threadId);
    if (!existing) throw new Error(`Thread ${threadId} not found`);
    if (existing.thread.status === 'closed') {
      throw new Error(`Cannot post to closed thread ${threadId}`);
    }
    if (existing.thread.messageCount >= 100) {
      throw new Error(`Thread ${threadId} has reached the message cap (100)`);
    }
    if (!existing.thread.participants.includes(senderAgentId)) {
      throw new Error(`Agent '${senderAgentId}' is not a participant of thread ${threadId}`);
    }
    // NOTE: The above checks run before the DB write; under concurrent load the
    // Postgres backend re-validates status and cap atomically in the UPDATE WHERE
    // clause, so a race can only overshoot by rejecting — not by persisting extra messages.
    const message: BullpenMessage = {
      id: randomUUID(), threadId, senderType: 'agent',
      senderId: senderAgentId, content, mentionedAgentIds,
      createdAt: new Date(),
    };
    await this.backend.postMessage(threadId, message, closeAfter);
    return message;
  }

  async closeThread(threadId: string, requestingAgentId: string): Promise<void> {
    const existing = await this.backend.getThread(threadId);
    if (!existing) throw new Error(`Thread ${threadId} not found`);
    if (requestingAgentId !== existing.thread.creatorAgentId && requestingAgentId !== 'coordinator') {
      throw new Error(
        `Agent '${requestingAgentId}' is not authorized to close thread ${threadId} — only the creator or coordinator may close threads`,
      );
    }
    await this.backend.closeThread(threadId);
  }

  async getThread(threadId: string): Promise<{ thread: BullpenThread; messages: BullpenMessage[] } | null> {
    return this.backend.getThread(threadId);
  }

  async getPendingThreadsForAgent(agentId: string, windowMinutes: number): Promise<PendingThreadContext[]> {
    return this.backend.getPendingThreadsForAgent(agentId, windowMinutes * 60 * 1000);
  }

  /**
   * Advance the per-agent read watermark for the given threads to each thread's current
   * last_message_at (#1065). After this, getPendingThreadsForAgent will not re-surface
   * those threads to the agent until a newer message arrives — preventing the re-action
   * of an already-handled out-of-band request. Idempotent, monotonic, unknown ids ignored.
   */
  async markThreadsSeen(agentId: string, threadIds: string[]): Promise<void> {
    return this.backend.markThreadsSeen(agentId, threadIds);
  }
}

// -- Context formatter --

/**
 * Formats pending Bullpen threads as a compact system-message block for LLM context injection.
 * Shows up to 5 threads × up to RECENT_MSG_LIMIT messages each. For threads that exceed the
 * limit, the first message (original request) is always pinned alongside the most recent ones
 * so agents never lose the founding context of a long conversation (#1090).
 */
export function formatBullpenContext(pending: PendingThreadContext[]): string {
  if (pending.length === 0) return '';
  const lines: string[] = [`[Bullpen — ${pending.length} active thread${pending.length === 1 ? '' : 's'}]`];
  for (const thread of pending) {
    const showing = thread.recentMessages.length < thread.totalMessages
      ? ` — first + last ${thread.recentMessages.length - 1} of ${thread.totalMessages}`
      : '';
    lines.push('');
    lines.push(`Thread "${thread.topic}" (thread_id: ${thread.threadId}, ${thread.totalMessages} total messages${showing}):`);
    for (const msg of thread.recentMessages) {
      const ts = msg.createdAt.toTimeString().slice(0, 5);
      const mentions = msg.mentionedAgentIds.length > 0
        ? msg.mentionedAgentIds.map(id => `@${id}`).join(' ') + ' '
        : '';
      lines.push(`  ${msg.senderAgentId} [${ts}]: "${mentions}${msg.content}"`);
    }
    if (thread.recentMessages.length < thread.totalMessages) {
      lines.push(`  → Middle messages omitted. Call bullpen get_thread for full history.`);
    }
  }
  // Thread-closure convention (#881): bullpen threads tend to be left open because
  // nothing prompts agents to close them. Surfacing this line on every turn that
  // injects bullpen state gives all agents the convention without per-agent prompt edits.
  lines.push('');
  lines.push('When your bullpen reply concludes a thread, pass close_after: true so it is closed atomically. Leave it off (or false) if the discussion is still going.');
  return lines.join('\n');
}
