// complete-setup.ts — Start onboarding's database step (#2358).
//
// Marks Setup complete and moves the shared web thread to a new conversation, in one
// transaction under a row lock, so the thread rotates exactly once: a repeated or
// concurrent request after the first one commits sees 'complete' and changes nothing.

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import { noteWebThreadRotated, rotateWebThreadRow } from '../channels/http/web-thread.js';
import { markSetupComplete } from './setup-state.js';

export interface CompleteSetupResult {
  /** False when Setup was already complete: the thread was left where it is. */
  rotated: boolean;
}

export async function completeSetup(
  pool: Pool,
  logger: Logger,
  opts?: { newId?: () => string },
): Promise<CompleteSetupResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The row may not exist yet (a scripted install); the lock needs one to hold.
    await client.query(`INSERT INTO setup_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    const locked = await client.query<{ phase: string | null }>(`SELECT phase FROM setup_state WHERE id = 1 FOR UPDATE`);
    if (locked.rows[0]?.phase === 'complete') {
      await client.query('COMMIT');
      return { rotated: false };
    }
    const next = (opts?.newId ?? randomUUID)();
    await rotateWebThreadRow(client, next);
    await markSetupComplete(client);
    await client.query('COMMIT');
    // Only after the commit: a rolled-back rotation must never reach the cache.
    noteWebThreadRotated(pool, next);
    return { rotated: true };
  } catch (err) {
    // Best-effort rollback; the original error is what propagates to the route.
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
      logger.error({ err: rollbackErr }, 'completeSetup: rollback failed');
    });
    throw err;
  } finally {
    client.release();
  }
}
