import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import type { TaskOriginator } from '../contacts/types.js';
import { toLocalIso } from '../time/timestamp.js';

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
  /**
   * True when an earlier wake already showed this message state and left an open
   * handoff untouched. The oldest pending slot skips these so a retry cannot pin
   * it (#1901). Absent on hand-built fixtures; treated as not yet shown.
   */
  alreadyInjected?: boolean;
}

// Maximum messages shown per thread in the ambient context. When a thread exceeds
// this limit, the first message (original request) is always pinned so agents never
// lose the context that gave the thread its purpose, plus the last (LIMIT-1) most
// recent messages. At 15 the tail covers most real threads in full; the first-pin
// only kicks in for genuinely long conversations. (#1090)
const RECENT_MSG_LIMIT = 15;

// How far back pending-thread injection looks, in minutes. Seven days covers the
// slowest scheduled participant (contacts, twice a week) with slack for a missed
// run, and still drops abandoned threads. The read watermark and the "latest
// sender is not me" guard stop re-actioning; this bound is only a backstop.
// Scheduler-channel tasks do not inject this tier (#1609). ADR-043. (#1899)
export const BULLPEN_PENDING_WINDOW_MINUTES = 7 * 24 * 60;

// Ambient injection cap. Four slots stay newest-first so a busy participant still
// sees current threads; the fifth is the oldest eligible thread, so a missed
// handoff is not crowded out of the widened window by newer traffic (#1899).
const PENDING_THREAD_CAP = 5;

function capPendingThreads<T>(
  threads: T[],
  lastMessageAt: (thread: T) => number,
  alreadyShown: (thread: T) => boolean = () => false,
): T[] {
  const newestFirst = [...threads].sort((a, b) => lastMessageAt(b) - lastMessageAt(a));
  if (newestFirst.length <= PENDING_THREAD_CAP) return newestFirst;
  // Age slot: oldest thread not yet shown for this message state. A handoff that
  // was already injected and left untouched must not pin the slot for the rest
  // of the window (#1901). If every thread was already shown, use the oldest.
  let oldest = newestFirst[newestFirst.length - 1]!;
  for (let i = newestFirst.length - 1; i >= 0; i--) {
    const candidate = newestFirst[i]!;
    if (!alreadyShown(candidate)) {
      oldest = candidate;
      break;
    }
  }
  const recency = newestFirst.slice(0, PENDING_THREAD_CAP - 1);
  if (recency.includes(oldest)) return recency;
  return [...recency, oldest];
}

// -- Backend interface --

interface BullpenBackend {
  openThread(thread: BullpenThread, message: BullpenMessage): Promise<void>;
  // closeAfter, when true, marks the thread closed in the same operation that
  // persists the message — the message is always written first (see #881).
  postMessage(threadId: string, message: BullpenMessage, closeAfter?: boolean): Promise<void>;
  closeThread(threadId: string): Promise<void>;
  getThread(threadId: string): Promise<{ thread: BullpenThread; messages: BullpenMessage[] } | null>;
  findThreadBySourceMessageId(sourceMessageId: string): Promise<{ thread: BullpenThread; message: BullpenMessage } | null>;
  getPendingThreadsForAgent(agentId: string, windowMinutes: number): Promise<PendingThreadContext[]>;
  // Advance the per-agent read watermark. Unknown thread ids are ignored.
  // Idempotent and monotonic (#1065). `shownThroughByThread` caps the stamp at the
  // newest message the caller actually showed (#1901); ids absent from the map use
  // the thread's live last_message_at.
  markThreadsSeen(
    agentId: string,
    threadIds: readonly string[],
    shownThroughByThread?: ReadonlyMap<string, Date>,
  ): Promise<void>;
  // Record that an open handoff was shown and left untouched, without advancing
  // seen_through. A later wake of the same messages can then give up (#1901).
  recordUnhandledInjection(
    agentId: string,
    threads: readonly { threadId: string; shownThrough: Date }[],
  ): Promise<void>;
}

interface AgentThreadRead {
  seenThrough: Date | null;
  injectedThrough: Date | null;
}

// -- In-memory backend (for unit tests) --

class InMemoryBullpenBackend implements BullpenBackend {
  private threads = new Map<string, BullpenThread>();
  private messages = new Map<string, BullpenMessage[]>();
  // Maps sourceMessageId -> threadId for dedup lookups.
  private sourceIdToThreadId = new Map<string, string>();
  // Per-agent read row: `${threadId}:${agentId}`. Mirrors bullpen_thread_reads (#1065, #1901).
  private reads = new Map<string, AgentThreadRead>();

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
    if (!thread) throw new Error(`No bullpen thread with ID ${threadId} exists`);
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

  async getPendingThreadsForAgent(agentId: string, windowMinutes: number): Promise<PendingThreadContext[]> {
    // Inclusive of the newest instant, exclusive of the far edge — matches the
    // Postgres predicate `last_message_at > NOW() - window`.
    const cutoffMs = Date.now() - windowMinutes * 60 * 1000;
    const result: PendingThreadContext[] = [];

    for (const [threadId, thread] of this.threads) {
      if (thread.status !== 'open') continue;
      if (!thread.participants.includes(agentId)) continue;
      if (!thread.lastMessageAt || thread.lastMessageAt.getTime() <= cutoffMs) continue;

      // Read watermark (#1065): skip threads the agent has already seen up to their
      // current latest message — only re-surface when newer activity has arrived.
      const read = this.reads.get(`${threadId}:${agentId}`);
      if (read?.seenThrough && thread.lastMessageAt <= read.seenThrough) continue;
      const injectedThrough = read?.injectedThrough ?? null;
      const alreadyInjected = injectedThrough !== null && thread.lastMessageAt <= injectedThrough;

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

      result.push({
        threadId,
        topic: thread.topic,
        totalMessages: thread.messageCount,
        recentMessages,
        alreadyInjected,
      });
    }

    return capPendingThreads(
      result,
      (thread) => this.threads.get(thread.threadId)?.lastMessageAt?.getTime() ?? 0,
      (thread) => thread.alreadyInjected === true,
    );
  }

  async markThreadsSeen(
    agentId: string,
    threadIds: readonly string[],
    shownThroughByThread?: ReadonlyMap<string, Date>,
  ): Promise<void> {
    for (const threadId of threadIds) {
      const thread = this.threads.get(threadId);
      // Ignore unknown threads and threads with no messages. Stamp the live latest
      // message, capped at the shown instant when the caller has one, so a message
      // that landed after the snapshot stays unseen (#1901). Monotonic.
      if (!thread?.lastMessageAt) continue;
      const shown = shownThroughByThread?.get(threadId);
      const stamp = shown !== undefined && shown < thread.lastMessageAt ? shown : thread.lastMessageAt;
      const key = `${threadId}:${agentId}`;
      const existing = this.reads.get(key) ?? { seenThrough: null, injectedThrough: null };
      if (!existing.seenThrough || stamp > existing.seenThrough) {
        existing.seenThrough = stamp;
      }
      this.reads.set(key, existing);
    }
  }

  async recordUnhandledInjection(
    agentId: string,
    threads: readonly { threadId: string; shownThrough: Date }[],
  ): Promise<void> {
    for (const { threadId, shownThrough } of threads) {
      const thread = this.threads.get(threadId);
      if (!thread?.lastMessageAt) continue;
      const stamp = shownThrough < thread.lastMessageAt ? shownThrough : thread.lastMessageAt;
      const key = `${threadId}:${agentId}`;
      const existing = this.reads.get(key) ?? { seenThrough: null, injectedThrough: null };
      if (!existing.injectedThrough || stamp > existing.injectedThrough) {
        existing.injectedThrough = stamp;
      }
      this.reads.set(key, existing);
    }
  }
}

// -- Postgres backend --

// JS Dates are millisecond precision. A timestamptz read from Postgres can be up
// to 1ms finer, so a shown instant that falls in the same millisecond as
// last_message_at is that message — snap up to it. An earlier millisecond stays
// earlier, which is what keeps a message posted after the snapshot unseen.
// $3 NULL means "no shown cap" (stamp the live latest message).
const SHOWN_THROUGH_SQL = `CASE
  WHEN $3::timestamptz IS NULL THEN t.last_message_at
  WHEN date_trunc('milliseconds', t.last_message_at) = date_trunc('milliseconds', $3::timestamptz)
    THEN t.last_message_at
  ELSE LEAST(t.last_message_at, $3::timestamptz)
END`;

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

  async getPendingThreadsForAgent(agentId: string, windowMinutes: number): Promise<PendingThreadContext[]> {
    // Minutes in, seconds at the SQL boundary. A millisecond parameter here is
    // what made a 60-minute window look like 60ms (#1899).
    const windowSeconds = windowMinutes * 60;
    const threadsRes = await this.pool.query<{
      id: string; topic: string; message_count: number; last_message_at: Date;
      already_injected: boolean;
    }>(
      // LEFT JOIN the per-agent read watermark and skip threads the agent has already
      // seen up to their current latest message (#1065): a thread re-surfaces only when
      // last_message_at advances past seen_through, so a handled out-of-band request is
      // not re-actioned on a later wake. seen_through is null on an injection-only row
      // (the handoff was shown once and left untouched, #1901).
      // age_rank = 1 keeps the oldest not-yet-shown eligible thread inside
      // PENDING_THREAD_CAP so newer traffic cannot crowd a missed handoff out of the
      // widened window (#1899). A thread already shown and left untouched sorts after
      // those, so a retry cannot pin the slot (#1901). $3 is the newest-slot count
      // (cap - 1); $4 is the cap itself. Both are bound parameters so the SQL cannot
      // drift from the in-memory cap.
      `WITH eligible AS (
         SELECT t.id, t.topic, t.message_count, t.last_message_at,
           (r.injected_through IS NOT NULL AND t.last_message_at <= r.injected_through) AS already_injected
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
       ),
       ranked AS (
         SELECT id, topic, message_count, last_message_at, already_injected,
           ROW_NUMBER() OVER (
             ORDER BY already_injected ASC, last_message_at ASC, id ASC
           ) AS age_rank,
           ROW_NUMBER() OVER (ORDER BY last_message_at DESC, id DESC) AS recency_rank
         FROM eligible
       )
       SELECT id, topic, message_count, last_message_at, already_injected
       FROM ranked
       WHERE age_rank = 1 OR recency_rank <= $3
       ORDER BY last_message_at DESC, id DESC
       LIMIT $4`,
      [agentId, windowSeconds, PENDING_THREAD_CAP - 1, PENDING_THREAD_CAP],
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
           SELECT id, sender_id, content, mentioned_agent_ids, created_at,
             ROW_NUMBER() OVER (ORDER BY created_at ASC,  id ASC)  AS rn_asc,
             ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS rn_desc
           FROM bullpen_messages
           WHERE thread_id = $1
         )
         SELECT sender_id, content, mentioned_agent_ids, created_at
         FROM ranked
         WHERE rn_asc = 1 OR rn_desc <= $2
         ORDER BY created_at ASC, id ASC`,
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
      results.push({
        threadId: row.id,
        topic: row.topic,
        totalMessages: row.message_count,
        recentMessages,
        alreadyInjected: row.already_injected === true,
      });
    }
    return results;
  }

  async markThreadsSeen(
    agentId: string,
    threadIds: readonly string[],
    shownThroughByThread?: ReadonlyMap<string, Date>,
  ): Promise<void> {
    if (threadIds.length === 0) return;
    // Stamp seen_through through the shown instant, never past the live latest
    // message. The same millisecond as last_message_at counts as that message
    // (JS dates are millisecond precision). Callers that omit a shown instant
    // (the #1065 id-only path) stamp the live latest message. GREATEST keeps the
    // watermark monotonic; COALESCE so an injection-only row (seen_through NULL)
    // can advance. Threads with a NULL last_message_at are skipped. (#1065, #1901)
    for (const threadId of threadIds) {
      const shown = shownThroughByThread?.get(threadId) ?? null;
      await this.pool.query(
        `INSERT INTO bullpen_thread_reads (thread_id, agent_id, seen_through, updated_at)
         SELECT t.id, $1, ${SHOWN_THROUGH_SQL}, now()
         FROM bullpen_threads t
         WHERE t.id = $2::uuid AND t.last_message_at IS NOT NULL
         ON CONFLICT (thread_id, agent_id)
         DO UPDATE SET seen_through = GREATEST(
                          COALESCE(bullpen_thread_reads.seen_through, EXCLUDED.seen_through),
                          EXCLUDED.seen_through
                        ),
                        updated_at = now()`,
        [agentId, threadId, shown],
      );
    }
  }

  async recordUnhandledInjection(
    agentId: string,
    threads: readonly { threadId: string; shownThrough: Date }[],
  ): Promise<void> {
    if (threads.length === 0) return;
    // injected_through records the newest message shown on a wake that left the
    // handoff untouched. seen_through is left alone so the thread can return once.
    // GREATEST keeps the injection mark monotonic. (#1901)
    for (const { threadId, shownThrough } of threads) {
      await this.pool.query(
        `INSERT INTO bullpen_thread_reads (thread_id, agent_id, seen_through, injected_through, updated_at)
         SELECT t.id, $1, NULL, ${SHOWN_THROUGH_SQL}, now()
         FROM bullpen_threads t
         WHERE t.id = $2::uuid AND t.last_message_at IS NOT NULL
         ON CONFLICT (thread_id, agent_id)
         DO UPDATE SET injected_through = GREATEST(
                          COALESCE(bullpen_thread_reads.injected_through, EXCLUDED.injected_through),
                          EXCLUDED.injected_through
                        ),
                        updated_at = now()`,
        [agentId, threadId, shownThrough],
      );
    }
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
    // Agent-facing copy (incl. job-UUID → scheduler-report redirect) is owned by
    // skills/bullpen/handler.ts via classifyBullpenThreadMiss. Keep this generic
    // so non-handler callers never see the old "Thread X not found" implication (#1828).
    if (!existing) throw new Error(`No bullpen thread with ID ${threadId} exists`);
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
    // See postMessage — agent-facing not-found wording is owned by the skill handler (#1828).
    if (!existing) throw new Error(`No bullpen thread with ID ${threadId} exists`);
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
    return this.backend.getPendingThreadsForAgent(agentId, windowMinutes);
  }

  /**
   * Advance the per-agent read watermark (#1065). After this, getPendingThreadsForAgent
   * will not re-surface those threads until a newer message arrives — preventing the
   * re-action of an already-handled out-of-band request. Idempotent, monotonic, unknown
   * ids ignored.
   *
   * `shownThroughByThread` caps each stamp at the newest message the agent was shown.
   * A message posted after that instant stays unseen (#1901). Ids absent from the map
   * stamp the thread's live last_message_at.
   *
   * Callers choose which threads to stamp. An ambient @mention the agent did not act
   * on, and that has not already been shown once, must not be passed here (#1901);
   * `selectThreadsToWatermark` is that choice.
   */
  async markThreadsSeen(
    agentId: string,
    threadIds: readonly string[],
    shownThroughByThread?: ReadonlyMap<string, Date>,
  ): Promise<void> {
    return this.backend.markThreadsSeen(agentId, threadIds, shownThroughByThread);
  }

  /**
   * Record that these open handoffs were shown and left untouched (#1901). Does not
   * advance seen_through. The next wake of the same messages treats them as a repeat
   * and watermarks them, so a missed out-of-band paraphrase costs one extra look,
   * not a week of repeats.
   */
  async recordUnhandledInjection(
    agentId: string,
    threads: readonly { threadId: string; shownThrough: Date }[],
  ): Promise<void> {
    return this.backend.recordUnhandledInjection(agentId, threads);
  }
}

// -- Read-watermark selection (#1901) --

/**
 * How much of a handoff must appear in an out-of-band tool call before that call
 * counts as handling the thread. A window counts only when it does not also appear
 * in another handoff shown on the same turn — a shared template prefix is not a
 * hit (#1901). The scan steps by THREAD_ACTION_EXCERPT_STEP so a long message
 * does not walk the tool input one character at a time.
 */
const THREAD_ACTION_EXCERPT_CHARS = 32;
const THREAD_ACTION_EXCERPT_STEP = 16;

/** One thread the completion-time watermark decision may stamp or defer. */
export interface BullpenWatermarkStamp {
  threadId: string;
  /** Newest message the agent was shown. Absent only for a woke thread with no snapshot. */
  shownThrough?: Date;
}

/** A pending thread as shown to the agent, for the completion-time watermark decision. */
export interface BullpenWatermarkThread {
  threadId: string;
  /**
   * True when any message after this agent's own latest post @mentions them.
   * A later note that mentions nobody does not clear an earlier unanswered mention.
   */
  mentionsAgent: boolean;
  /** Body of the latest such mention. The agent's own messages are not candidates. */
  handoffText?: string;
  /** createdAt of the newest message included in the injection. */
  shownThrough: Date;
  /** A previous wake already showed this message state and left the handoff untouched. */
  alreadyInjected: boolean;
}

/** One tool call from the task. `success` is false for handler failures and soft-failures. */
export interface BullpenToolTouch {
  name: string;
  input: unknown;
  success: boolean;
}

/**
 * Snapshot a pending thread for watermark selection (#1901).
 *
 * An open handoff is any message at or after the agent's own latest post that
 * @mentions them. A follow-up that mentions nobody leaves that handoff open.
 * Excerpt matching uses only the latest such mention, never the agent's own text.
 */
export function pendingThreadWatermarkSnapshot(
  agentId: string,
  thread: PendingThreadContext,
): BullpenWatermarkThread {
  const messages = thread.recentMessages;
  let lastOwn = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.senderAgentId === agentId) lastOwn = i;
  }
  const openSpan = messages.slice(lastOwn + 1);
  const mentions = openSpan.filter(
    m => m.senderAgentId !== agentId && m.mentionedAgentIds.includes(agentId),
  );
  const latestMention = mentions[mentions.length - 1];
  const latest = messages[messages.length - 1];
  return {
    threadId: thread.threadId,
    mentionsAgent: latestMention !== undefined,
    ...(latestMention ? { handoffText: latestMention.content } : {}),
    shownThrough: latest?.createdAt ?? new Date(0),
    alreadyInjected: thread.alreadyInjected === true,
  };
}

/**
 * A soft-failure (`success: true` with `data.failed`) did not do the work. Treat it
 * as not actionable so a failed handoff cannot retire the @mention (#1901).
 */
export function toBullpenToolTouch(
  name: string,
  input: unknown,
  result: { success: boolean; data?: unknown },
): BullpenToolTouch {
  let success = result.success;
  const data = result.data;
  if (
    success
    && data !== null
    && typeof data === 'object'
    && !Array.isArray(data)
    && 'failed' in data
    && data.failed === true
  ) {
    success = false;
  }
  return { name, input, success };
}

export interface BullpenWatermarkDecision {
  /** Stamp seen_through through shownThrough (or live last_message_at when omitted). */
  watermark: BullpenWatermarkStamp[];
  /** First untouched showing of an open handoff. Record the injection; do not stamp seen. */
  defer: BullpenWatermarkStamp[];
}

/**
 * Which shown threads to stamp, and which open handoffs to remember as shown, after
 * a successful task (#1065, #1901).
 *
 * - The thread this task was woken for is always stamped, including when the agent
 *   chooses not to reply. That is the bullpen-origin wake.
 * - An ambient thread that is not an open handoff is awareness and is stamped.
 * - An ambient handoff this turn acted on is stamped: a successful bullpen reply or
 *   close for that thread, or any other successful tool call that carries the thread
 *   id or a distinctive excerpt of the mention (the out-of-band send/write). A read
 *   (`get_thread`) and an unrelated tool call do not count. An excerpt that also
 *   appears in another handoff shown this turn is not distinctive.
 * - An ambient handoff left untouched stays pending the first time those messages
 *   are shown. The same messages shown again, still untouched, are stamped, so a
 *   paraphrased miss is not repeated for the rest of the window.
 */
export function selectThreadsToWatermark(args: {
  wokeThreadId?: string;
  /** Fallback shown instant for the woke thread when it is not in `ambient`. */
  wokeShownThrough?: Date;
  ambient: readonly BullpenWatermarkThread[];
  toolTouches: readonly BullpenToolTouch[];
}): BullpenWatermarkDecision {
  const watermark: BullpenWatermarkStamp[] = [];
  const defer: BullpenWatermarkStamp[] = [];
  const seen = new Set<string>();
  const addWatermark = (stamp: BullpenWatermarkStamp): void => {
    if (seen.has(stamp.threadId)) return;
    seen.add(stamp.threadId);
    watermark.push(stamp);
  };

  if (args.wokeThreadId) {
    const fromAmbient = args.ambient.find(t => t.threadId === args.wokeThreadId);
    addWatermark({
      threadId: args.wokeThreadId,
      shownThrough: fromAmbient?.shownThrough ?? args.wokeShownThrough,
    });
  }

  const handoffs = args.ambient.filter(t => t.handoffText !== undefined);
  const shared = sharedHandoffNeedles(handoffs.map(t => t.handoffText!));

  for (const thread of args.ambient) {
    if (thread.threadId === args.wokeThreadId) continue;
    const stamp = { threadId: thread.threadId, shownThrough: thread.shownThrough };
    if (!thread.mentionsAgent || thread.alreadyInjected || toolTouchesActOnThread(args.toolTouches, thread, shared)) {
      addWatermark(stamp);
      continue;
    }
    if (seen.has(thread.threadId)) continue;
    seen.add(thread.threadId);
    defer.push(stamp);
  }
  return { watermark, defer };
}

function toolTouchesActOnThread(
  touches: readonly BullpenToolTouch[],
  thread: BullpenWatermarkThread,
  sharedNeedles: ReadonlySet<string>,
): boolean {
  return touches.some(touch => touchActsOnThread(touch, thread, sharedNeedles));
}

function touchActsOnThread(
  touch: BullpenToolTouch,
  thread: BullpenWatermarkThread,
  sharedNeedles: ReadonlySet<string>,
): boolean {
  if (!touch.success) return false;
  if (touch.name === 'bullpen') {
    if (!isPlainRecord(touch.input)) return false;
    const action = touch.input['action'];
    const threadId = touch.input['thread_id'];
    // get_thread is a read. post opens a different thread. Neither retires this @mention.
    return (action === 'reply' || action === 'close') && threadId === thread.threadId;
  }
  const blob = collectStrings(touch.input).join('\n');
  if (blob.includes(thread.threadId)) return true;
  if (!thread.handoffText) return false;
  return textCarriesHandoff(blob, thread.handoffText, sharedNeedles);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectStrings(value: unknown): string[] {
  const out: string[] = [];
  walkStrings(value, out);
  return out;
}

function walkStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, out);
    return;
  }
  if (isPlainRecord(value)) {
    for (const nested of Object.values(value)) walkStrings(nested, out);
  }
}

function normalizeForExcerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function excerptNeedles(normalized: string): string[] {
  if (normalized.length < THREAD_ACTION_EXCERPT_CHARS) return [];
  const needles: string[] = [normalized];
  for (let i = 0; i + THREAD_ACTION_EXCERPT_CHARS <= normalized.length; i += THREAD_ACTION_EXCERPT_STEP) {
    needles.push(normalized.slice(i, i + THREAD_ACTION_EXCERPT_CHARS));
  }
  return needles;
}

/** Needles that occur in more than one handoff shown this turn. Those cannot identify a thread. */
function sharedHandoffNeedles(handoffTexts: readonly string[]): Set<string> {
  const normalized = handoffTexts.map(normalizeForExcerpt);
  const shared = new Set<string>();
  for (let i = 0; i < normalized.length; i++) {
    for (const needle of excerptNeedles(normalized[i]!)) {
      if (shared.has(needle)) continue;
      for (let j = 0; j < normalized.length; j++) {
        if (j === i) continue;
        if (normalized[j]!.includes(needle)) {
          shared.add(needle);
          break;
        }
      }
    }
  }
  return shared;
}

function textCarriesHandoff(haystackRaw: string, handoffRaw: string, sharedNeedles: ReadonlySet<string>): boolean {
  const haystack = normalizeForExcerpt(haystackRaw);
  const handoff = normalizeForExcerpt(handoffRaw);
  if (handoff.length < THREAD_ACTION_EXCERPT_CHARS || haystack.length < THREAD_ACTION_EXCERPT_CHARS) {
    return false;
  }
  for (const needle of excerptNeedles(handoff)) {
    if (sharedNeedles.has(needle)) continue;
    if (haystack.includes(needle)) return true;
  }
  return false;
}

// -- Context formatter --

/**
 * Formats pending Bullpen threads as a compact system-message block for LLM context injection.
 * Shows up to 5 threads × up to RECENT_MSG_LIMIT messages each. For threads that exceed the
 * limit, the first message (original request) is always pinned alongside the most recent ones
 * so agents never lose the founding context of a long conversation (#1090).
 *
 * `timezone` is the principal's IANA zone. Stamps use `toLocalIso` so the model reads
 * wall-clock digits instead of converting UTC (#1899).
 */
export function formatBullpenContext(pending: PendingThreadContext[], timezone?: string): string {
  if (pending.length === 0) return '';
  const lines: string[] = [`[Bullpen — ${pending.length} active thread${pending.length === 1 ? '' : 's'}]`];
  for (const thread of pending) {
    const showing = thread.recentMessages.length < thread.totalMessages
      ? ` — first + last ${thread.recentMessages.length - 1} of ${thread.totalMessages}`
      : '';
    lines.push('');
    lines.push(`Thread "${thread.topic}" (thread_id: ${thread.threadId}, ${thread.totalMessages} total messages${showing}):`);
    for (const msg of thread.recentMessages) {
      const ts = formatBullpenStamp(msg.createdAt, timezone);
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
  // The ambient line rides with the block (#1609, #1899): widening the window puts
  // older internal threads on human-channel turns, and channel suppression only
  // covers scheduler runs.
  lines.push('');
  lines.push('These are ambient internal threads. Reply only via the bullpen tools, never in your response to the user.');
  lines.push('When your bullpen reply concludes a thread, pass close_after: true so it is closed atomically. Leave it off (or false) if the discussion is still going.');
  return lines.join('\n');
}

function formatBullpenStamp(createdAt: Date, timezone: string | undefined): string {
  const unixSeconds = Math.floor(createdAt.getTime() / 1000);
  const zone = timezone?.trim() || undefined;
  // TIMEZONE is rejected at startup, so a bad zone never reaches this call.
  // toLocalIso throws on one anyway; the null fallback is only for an
  // implausible unix timestamp, which is not a valid message time.
  return toLocalIso(unixSeconds, zone) ?? createdAt.toISOString();
}
