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

// The row is written once and then only read, until starting onboarding rotates it
// (OnboardingService.start, #2360, which updates this cache too). A process-local cache skips the
// SELECT on later messages. Keyed by pool so tests with a fresh stub do not
// share an id. Rows written before migration 090 have a NULL channel_id and
// are not adopted; an upgrade from that era starts a new thread.
const threadIds = new WeakMap<WebThreadQueryable, string>();
// Bumped by every rotation. An uncached read caches its result only when no rotation
// happened while it ran, so a read that saw the old row can never overwrite the new id.
const generations = new WeakMap<WebThreadQueryable, number>();

/** Drop a cached id. Tests delete the row and need the next call to read again. */
export function clearWebThreadCache(pool: WebThreadQueryable): void {
  threadIds.delete(pool);
}

/**
 * Return the shared conversation id, creating the row if this is the first call.
 * Concurrent callers collide on the primary key; the loser reads the winner.
 */
export async function getOrCreateWebThread(
  pool: WebThreadQueryable,
  opts?: { newId?: () => string },
): Promise<string> {
  const cached = threadIds.get(pool);
  if (cached) return cached;
  const generation = generations.get(pool) ?? 0;
  const resolved = await readOrCreateWebThread(pool, opts);
  // A rotation finished while this read ran: what it read may be the old row. The rotation
  // already cached the new id, so return that.
  if ((generations.get(pool) ?? 0) !== generation) return threadIds.get(pool) ?? getOrCreateWebThread(pool, opts);
  threadIds.set(pool, resolved);
  return resolved;
}

async function readOrCreateWebThread(
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

/**
 * Point the shared thread at a new conversation (#2358), in the caller's transaction. The
 * caller calls noteWebThreadRotated once it commits. Starting onboarding does this
 * (OnboardingService.start, #2360; not finishing Setup) so the principal never opens on the
 * operator's Setup chat; the old conversation stays in
 * working_memory and the audit log.
 */
export async function rotateWebThreadRow(db: WebThreadQueryable, conversationId: string): Promise<void> {
  await db.query(
    `INSERT INTO web_thread (id, conversation_id) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET conversation_id = EXCLUDED.conversation_id, created_at = now()`,
    [conversationId],
  );
}

/** After a committed rotation: every later read in this process gets the new id. */
export function noteWebThreadRotated(pool: WebThreadQueryable, conversationId: string): void {
  generations.set(pool, (generations.get(pool) ?? 0) + 1);
  threadIds.set(pool, conversationId);
}

/** Rotate outside a transaction (tests, tools). Returns the new id. */
export async function rotateWebThread(
  pool: WebThreadQueryable,
  opts?: { newId?: () => string },
): Promise<string> {
  const next = (opts?.newId ?? randomUUID)();
  await rotateWebThreadRow(pool, next);
  noteWebThreadRotated(pool, next);
  return next;
}

/**
 * The shared thread and the Setup phase, read in one statement (#2358), so a chat message
 * is bound to one side of Setup: either the Setup thread while Setup runs, or the shared
 * thread after. Finishing Setup changes only the phase; starting onboarding (#2360) later
 * rotates the thread.
 */
export async function readWebThreadAndSetupPhase(
  pool: WebThreadQueryable,
): Promise<{ conversationId: string; setupPhase: string | null }> {
  // Creates the row on first use; the snapshot below is what binds the message.
  await getOrCreateWebThread(pool);
  const snapshot = await pool.query(
    `SELECT w.conversation_id, s.phase
     FROM web_thread w LEFT JOIN setup_state s ON s.id = 1
     WHERE w.id = 1`,
  );
  const row = snapshot.rows[0];
  const conversationId = conversationIdOf(row);
  if (!conversationId) throw new Error('web_thread row is missing after it was created');
  const phase = row?.['phase'];
  return { conversationId, setupPhase: typeof phase === 'string' ? phase : null };
}

/** A client message id is an opaque token the sender uses to ignore its own echo. */
export function readClientMessageId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) return null;
  return id;
}
