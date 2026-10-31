// web-thread.ts — the principal's one web conversation (#2341, ADR-055).
//
// Every browser and paired phone reads this id. It is created once: the most
// recently active `web` row in working_memory is adopted, and a fresh id is
// minted only when there is no history. A client-supplied id is not consulted.

import { randomUUID } from 'node:crypto';

export interface WebThreadQueryable {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

function conversationIdOf(row: Record<string, unknown> | undefined): string | null {
  const value = row?.['conversation_id'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Return the shared conversation id, creating the row if this is the first call.
 * Concurrent callers collide on the primary key; the loser reads the winner.
 */
export async function getOrCreateWebThread(
  pool: WebThreadQueryable,
  opts?: { newId?: () => string },
): Promise<string> {
  const existing = await pool.query(
    `SELECT conversation_id FROM web_thread WHERE id = 1`,
  );
  const stored = conversationIdOf(existing.rows[0]);
  if (stored) return stored;

  const recent = await pool.query(
    `SELECT conversation_id
     FROM working_memory
     WHERE channel_id = 'web'
       AND archived = false
       AND conversation_id IS NOT NULL
       AND conversation_id <> ''
     GROUP BY conversation_id
     ORDER BY MAX(created_at) DESC
     LIMIT 1`,
  );
  const adopted = conversationIdOf(recent.rows[0]) ?? (opts?.newId ?? randomUUID)();

  const inserted = await pool.query(
    `INSERT INTO web_thread (id, conversation_id)
     VALUES (1, $1)
     ON CONFLICT (id) DO NOTHING
     RETURNING conversation_id`,
    [adopted],
  );
  const won = conversationIdOf(inserted.rows[0]);
  if (won) return won;

  const winner = await pool.query(
    `SELECT conversation_id FROM web_thread WHERE id = 1`,
  );
  const resolved = conversationIdOf(winner.rows[0]);
  if (!resolved) throw new Error('web_thread insert lost the race and the row is missing');
  return resolved;
}

/** A client message id is an opaque token the sender uses to ignore its own echo. */
export function readClientMessageId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) return null;
  return id;
}
