import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from '../logger.js';

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

// -- Backend interface --

interface BullpenBackend {
  openThread(thread: BullpenThread, message: BullpenMessage): Promise<void>;
  postMessage(threadId: string, message: BullpenMessage): Promise<void>;
  closeThread(threadId: string): Promise<void>;
  getThread(threadId: string): Promise<{ thread: BullpenThread; messages: BullpenMessage[] } | null>;
  getPendingThreadsForAgent(agentId: string, windowMs: number): Promise<PendingThreadContext[]>;
}

// -- In-memory backend (for unit tests) --

class InMemoryBullpenBackend implements BullpenBackend {
  private threads = new Map<string, BullpenThread>();
  private messages = new Map<string, BullpenMessage[]>();

  async openThread(thread: BullpenThread, message: BullpenMessage): Promise<void> {
    this.threads.set(thread.id, { ...thread });
    this.messages.set(thread.id, [{ ...message }]);
  }

  async postMessage(threadId: string, message: BullpenMessage): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    thread.messageCount++;
    thread.lastMessageAt = message.createdAt;
    const msgs = this.messages.get(threadId) ?? [];
    msgs.push({ ...message });
    this.messages.set(threadId, msgs);
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

      const msgs = this.messages.get(threadId) ?? [];
      if (msgs.length === 0) continue;

      const lastMsg = msgs[msgs.length - 1]!;
      if (lastMsg.senderId === agentId) continue;

      const recentMessages = msgs.slice(-5).map(m => ({
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
}

// -- Postgres backend --

class PostgresBullpenBackend implements BullpenBackend {
  constructor(private pool: Pool, private logger: Logger) {}

  async openThread(thread: BullpenThread, message: BullpenMessage): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO bullpen_threads (id, topic, creator_agent_id, participants, status, message_count, last_message_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [thread.id, thread.topic, thread.creatorAgentId, thread.participants, thread.status, thread.messageCount, thread.lastMessageAt, thread.createdAt],
      );
      await client.query(
        `INSERT INTO bullpen_messages (id, thread_id, sender_type, sender_id, content, mentioned_agent_ids, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [message.id, message.threadId, message.senderType, message.senderId, JSON.stringify(message.content), message.mentionedAgentIds, message.createdAt],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async postMessage(threadId: string, message: BullpenMessage): Promise<void> {
    // Two separate statements wrapped in a transaction for atomicity.
    // (A CTE that does INSERT + UPDATE requires the INSERT to be in the CTE's WITH clause,
    // which Postgres supports, but requires careful parameter numbering.)
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO bullpen_messages (id, thread_id, sender_type, sender_id, content, mentioned_agent_ids, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [message.id, threadId, message.senderType, message.senderId, JSON.stringify(message.content), message.mentionedAgentIds, message.createdAt],
      );
      await client.query(
        `UPDATE bullpen_threads
         SET message_count = message_count + 1,
             last_message_at = $1
         WHERE id = $2`,
        [message.createdAt, threadId],
      );
      await client.query('COMMIT');
    } catch (err) {
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
    }>(
      `SELECT id, topic, creator_agent_id, participants, status, message_count, last_message_at, created_at
       FROM bullpen_threads WHERE id = $1`,
      [threadId],
    );
    if (threadRes.rows.length === 0) return null;
    const row = threadRes.rows[0]!;
    const thread: BullpenThread = {
      id: row.id, topic: row.topic, creatorAgentId: row.creator_agent_id,
      participants: row.participants, status: row.status as 'open' | 'closed',
      messageCount: row.message_count, lastMessageAt: row.last_message_at, createdAt: row.created_at,
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

  async getPendingThreadsForAgent(agentId: string, windowMs: number): Promise<PendingThreadContext[]> {
    const windowSeconds = windowMs / 1000;
    const threadsRes = await this.pool.query<{
      id: string; topic: string; message_count: number; last_message_at: Date;
    }>(
      `SELECT t.id, t.topic, t.message_count, t.last_message_at
       FROM bullpen_threads t
       WHERE t.status = 'open'
         AND $1 = ANY(t.participants)
         AND t.last_message_at > NOW() - ($2 || ' seconds')::INTERVAL
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
      const msgsRes = await this.pool.query<{
        sender_id: string; content: unknown; mentioned_agent_ids: string[]; created_at: Date;
      }>(
        `SELECT sender_id, content, mentioned_agent_ids, created_at
         FROM bullpen_messages WHERE thread_id = $1
         ORDER BY created_at DESC LIMIT 5`,
        [row.id],
      );
      const recentMessages = msgsRes.rows.reverse().map(m => ({
        senderAgentId: m.sender_id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        mentionedAgentIds: m.mentioned_agent_ids,
        createdAt: m.created_at,
      }));
      results.push({ threadId: row.id, topic: row.topic, totalMessages: row.message_count, recentMessages });
    }
    return results;
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
  ): Promise<{ thread: BullpenThread; message: BullpenMessage }> {
    const now = new Date();
    const thread: BullpenThread = {
      id: randomUUID(), topic, creatorAgentId, participants,
      status: 'open', messageCount: 1, lastMessageAt: now, createdAt: now,
    };
    const message: BullpenMessage = {
      id: randomUUID(), threadId: thread.id, senderType: 'agent',
      senderId: creatorAgentId, content: initialContent,
      mentionedAgentIds, createdAt: now,
    };
    await this.backend.openThread(thread, message);
    return { thread, message };
  }

  async postMessage(
    threadId: string,
    senderAgentId: string,
    content: string,
    mentionedAgentIds: string[],
  ): Promise<BullpenMessage> {
    const existing = await this.backend.getThread(threadId);
    if (!existing) throw new Error(`Thread ${threadId} not found`);
    if (existing.thread.status === 'closed') {
      throw new Error(`Cannot post to closed thread ${threadId}`);
    }
    if (existing.thread.messageCount >= 100) {
      throw new Error(`Thread ${threadId} has reached the message cap (100)`);
    }
    const message: BullpenMessage = {
      id: randomUUID(), threadId, senderType: 'agent',
      senderId: senderAgentId, content, mentionedAgentIds,
      createdAt: new Date(),
    };
    await this.backend.postMessage(threadId, message);
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
}

// -- Context formatter --

/**
 * Formats pending Bullpen threads as a compact system-message block for LLM context injection.
 * Shows up to 5 threads × 5 recent messages each.
 */
export function formatBullpenContext(pending: PendingThreadContext[]): string {
  if (pending.length === 0) return '';
  const lines: string[] = [`[Bullpen — ${pending.length} active thread${pending.length === 1 ? '' : 's'}]`];
  for (const thread of pending) {
    const showing = thread.recentMessages.length < thread.totalMessages
      ? ` — showing last ${thread.recentMessages.length}`
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
      lines.push(`  → Call bullpen get_thread for full history.`);
    }
  }
  return lines.join('\n');
}
