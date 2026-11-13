// triage-dedupe.ts — cross-mailbox message dedupe for triage (#2475, D4).
//
// The same message sent to two of the principal's addresses lands in both inboxes under different
// Nylas ids. Triage claims the RFC Message-ID; the first claim wins and the other mailbox's copy is
// skipped. Headers are normalised (trim, strip angle brackets, lowercase) so `<A@x>` and `a@x`
// collide. An empty header is refused, never claimed: empty strings would all collide.
//
// Retention is 30 days. claim() treats an older row as expired and replaces it in the same
// statement, so correctness never depends on sweep() having run; sweep() only bounds table size.
// Logs carry mailbox ids and counts only; the Message-ID is logged at debug.
import type pg from 'pg';
import type { Logger } from '../logger.js';

export const DEDUPE_RETENTION_DAYS = 30;

export type DedupeClaim = { first: true } | { first: false; mailboxId: string; nylasMessageId: string };

function normalizeHeader(raw: string): string {
  let h = raw.trim();
  if (h.startsWith('<')) h = h.slice(1);
  if (h.endsWith('>')) h = h.slice(0, -1);
  h = h.trim().toLowerCase();
  if (h === '') {
    throw new Error('Cannot dedupe a message with an empty Message-ID header');
  }
  return h;
}

export class TriageDedupe {
  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger,
  ) {}

  async claim(header: string, mailboxId: string, nylasMessageId: string): Promise<DedupeClaim> {
    const key = normalizeHeader(header);
    // Two attempts: the winner row can be swept between the insert and the select.
    for (let attempt = 0; attempt < 2; attempt++) {
      const inserted = await this.pool.query(
        `INSERT INTO principal_mail_dedupe (message_id_header, mailbox_id, nylas_message_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id_header) DO UPDATE
           SET mailbox_id = EXCLUDED.mailbox_id,
               nylas_message_id = EXCLUDED.nylas_message_id,
               triaged_at = now()
           WHERE principal_mail_dedupe.triaged_at < now() - make_interval(days => $4::int)
         RETURNING 1`,
        [key, mailboxId, nylasMessageId, DEDUPE_RETENTION_DAYS],
      );
      if (inserted.rows.length > 0) {
        this.logger.debug({ messageId: key, mailboxId }, 'Triage dedupe: first claim');
        return { first: true };
      }
      const { rows } = await this.pool.query<{ mailbox_id: string; nylas_message_id: string }>(
        `SELECT mailbox_id, nylas_message_id FROM principal_mail_dedupe WHERE message_id_header = $1`,
        [key],
      );
      const winner = rows[0];
      if (winner) {
        this.logger.debug(
          { messageId: key, mailboxId, winnerMailboxId: winner.mailbox_id },
          'Triage dedupe: duplicate across mailboxes',
        );
        return { first: false, mailboxId: winner.mailbox_id, nylasMessageId: winner.nylas_message_id };
      }
    }
    throw new Error('Triage dedupe claim lost a race twice; the winner row kept vanishing');
  }

  async sweep(olderThanDays = DEDUPE_RETENTION_DAYS): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM principal_mail_dedupe WHERE triaged_at < now() - make_interval(days => $1::int)`,
      [olderThanDays],
    );
    const removed = res.rowCount ?? 0;
    this.logger.info({ removed, olderThanDays }, 'Triage dedupe sweep');
    return removed;
  }
}
