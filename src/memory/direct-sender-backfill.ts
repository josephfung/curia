// Historical Signal 1:1 and SMS sender backfill (#1599).
//
// Migration 090 stamps only the last 7 days inside the boot transaction.
// The recall read is bounded per channel. The shared-conversation check is
// not: any older user row with a null sender, including an archived one,
// marks that conversation shared and hides its assistant replies. Signal 1:1
// and SMS conversation ids encode a single peer, so those rows are that
// peer's. Email, Slack, and Signal groups stay unstamped — a null sender
// there is how a multi-party thread stays closed.
//
// Synthetic user turns are excluded (#1892). A conversation id says who the
// human peer is, but not every user row in that thread is from them: the voice
// cue, the content-filter rewrite brief, a late specialist result, and the
// secret-capture resume are all rows Curia wrote to itself. Stamping those with
// the peer's contact id would later recall Curia's own control messages as that
// person's words. `working_memory.synthetic` is what says so — the same column
// the recall read tests, so the two cannot disagree about what counts as a
// participant.
//
// The count of rows skipped that way is logged next to the count stamped. Both
// are needed to read a run: a pass that correctly skips every synthetic row and
// a pass whose filter silently stopped working produce the same `stamped` number
// and differ only here.
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
    AND wm2.synthetic = false
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
    AND wm2.synthetic = false
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

/** Rows this pass deliberately left alone because Curia wrote them (#1892). */
const SKIPPED_SYNTHETIC_COUNT = `
SELECT count(*)::int AS n
FROM working_memory
WHERE role = 'user'
  AND sender_contact_id IS NULL
  AND synthetic = true
  AND (
    (conversation_id LIKE 'signal:%' AND conversation_id NOT LIKE 'signal:group=%')
    OR conversation_id LIKE 'sms:%'
  )
`;

/**
 * Count the rows the exclusion is holding back. A failure to count must not fail
 * the backfill — the stamping already succeeded — but it must not quietly report
 * zero either, so the caller gets null and the log says the count is unknown.
 */
async function countSkippedSynthetic(pool: DbPool, logger: Logger): Promise<number | null> {
  try {
    const result = await pool.query<{ n: number }>(SKIPPED_SYNTHETIC_COUNT);
    return result.rows[0]?.n ?? 0;
  } catch (err) {
    logger.warn({ err }, 'direct-sender backfill: could not count skipped synthetic rows');
    return null;
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
): Promise<{ signalRows: number; smsRows: number; skippedSynthetic: number | null }> {
  const batchSize = options?.batchSize ?? DIRECT_SENDER_BACKFILL_BATCH;
  const signalRows = await backfillChannel(pool, SIGNAL_UPDATE, batchSize, logger, 'signal');
  const smsRows = await backfillChannel(pool, SMS_UPDATE, batchSize, logger, 'sms');
  const skippedSynthetic = await countSkippedSynthetic(pool, logger);
  logger.info(
    { signalRows, smsRows, skippedSynthetic },
    'direct-sender backfill finished — skippedSynthetic is how many rows the synthetic exclusion held back',
  );
  return { signalRows, smsRows, skippedSynthetic };
}
