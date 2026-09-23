// Historical Signal 1:1 and SMS sender backfill (#1599).
//
// Migration 090 stamps only the last 7 days inside the boot transaction.
// Recall itself only reads the local day, but the shared-conversation check
// does not: any older user row with a null sender, including an archived one,
// marks that conversation shared and hides its assistant replies. Signal 1:1
// and SMS conversation ids encode a single peer, so those rows are that
// peer's. Email, Slack, and Signal groups stay unstamped — a null sender
// there is how a multi-party thread stays closed.
//
// Runs after boot, in batches, and only updates rows that are still null.
// A second start is a no-op once the table is caught up.

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';

/** Rows rewritten per statement. Small enough that one batch is not a table rewrite. */
export const DIRECT_SENDER_BACKFILL_BATCH = 200;

const SIGNAL_UPDATE = `
UPDATE working_memory wm
SET sender_contact_id = cci.contact_id,
    channel_id = COALESCE(wm.channel_id, 'signal')
FROM contact_channel_identities cci
WHERE wm.id IN (
  SELECT wm2.id
  FROM working_memory wm2
  JOIN contact_channel_identities cci2
    ON cci2.channel = 'signal'
   AND cci2.channel_identifier = substring(wm2.conversation_id FROM '^signal:(.+)$')
  WHERE wm2.role = 'user'
    AND wm2.sender_contact_id IS NULL
    AND wm2.conversation_id LIKE 'signal:%'
    AND wm2.conversation_id NOT LIKE 'signal:group=%'
  LIMIT $1
)
AND wm.sender_contact_id IS NULL
AND cci.channel = 'signal'
AND cci.channel_identifier = substring(wm.conversation_id FROM '^signal:(.+)$')
`;

const SMS_UPDATE = `
UPDATE working_memory wm
SET sender_contact_id = cci.contact_id,
    channel_id = COALESCE(wm.channel_id, 'sms')
FROM contact_channel_identities cci
WHERE wm.id IN (
  SELECT wm2.id
  FROM working_memory wm2
  JOIN contact_channel_identities cci2
    ON cci2.channel = 'sms'
   AND cci2.channel_identifier = substring(wm2.conversation_id FROM '^sms:(.+)$')
  WHERE wm2.role = 'user'
    AND wm2.sender_contact_id IS NULL
    AND wm2.conversation_id LIKE 'sms:%'
  LIMIT $1
)
AND wm.sender_contact_id IS NULL
AND cci.channel = 'sms'
AND cci.channel_identifier = substring(wm.conversation_id FROM '^sms:(.+)$')
`;

async function runBatch(
  pool: DbPool,
  sql: string,
  batchSize: number,
  logger: Logger,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query(sql, [batchSize]);
    await client.query('COMMIT');
    return result.rowCount ?? 0;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error(
        { err: rollbackErr },
        'direct-sender backfill ROLLBACK failed — connection may be in a bad state',
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

async function backfillChannel(
  pool: DbPool,
  sql: string,
  batchSize: number,
  logger: Logger,
  channel: 'signal' | 'sms',
): Promise<number> {
  let total = 0;
  for (;;) {
    let updated = 0;
    try {
      updated = await runBatch(pool, sql, batchSize, logger);
    } catch (err) {
      logger.error(
        { err, channel, stamped: total },
        'direct-sender backfill stopped — remaining rows stay null until the next start',
      );
      return total;
    }
    if (updated === 0) return total;
    total += updated;
    logger.info({ channel, batch: updated, stamped: total }, 'direct-sender backfill batch');
  }
}

/**
 * Stamp historical Signal 1:1 and SMS user turns from channel identities.
 * Idempotent: rows that already have a sender are left alone.
 */
export async function backfillDirectChannelSenders(
  pool: DbPool,
  logger: Logger,
  options?: { batchSize?: number },
): Promise<{ signalRows: number; smsRows: number }> {
  const batchSize = options?.batchSize ?? DIRECT_SENDER_BACKFILL_BATCH;
  const signalRows = await backfillChannel(pool, SIGNAL_UPDATE, batchSize, logger, 'signal');
  const smsRows = await backfillChannel(pool, SMS_UPDATE, batchSize, logger, 'sms');
  logger.info({ signalRows, smsRows }, 'direct-sender backfill finished');
  return { signalRows, smsRows };
}
