// backfill-calendar-mailboxes.ts — assign the default mailbox to calendars registered before
// calendars belonged to a mailbox (#2475, Part 4, R3).
//
// Every pre-existing contact_calendars row was read through the single grant, which is the
// default mailbox's. Idempotent: it only touches rows with no mailbox, so it runs on every boot,
// after the flat-mailbox migration has had its chance to create the default mailbox.
import type { Pool } from 'pg';
import type { Logger } from '../logger.js';

/**
 * Set principal_mailbox_id = defaultId on every calendar that has none. Returns the count updated.
 * With no default mailbox (null) it skips with a warning and returns 0. A database failure is
 * logged at error and rethrown; the caller decides how loud to be.
 * Logs ids and counts only.
 */
export async function backfillCalendarMailboxes(
  pool: Pick<Pool, 'query'>,
  defaultId: string | null,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<number> {
  if (!defaultId) {
    logger.warn('Calendar mailbox backfill skipped: no default principal mailbox yet; retried next boot');
    return 0;
  }
  try {
    const result = await pool.query(
      'UPDATE contact_calendars SET principal_mailbox_id = $1, updated_at = now() WHERE principal_mailbox_id IS NULL',
      [defaultId],
    );
    const updated = result.rowCount ?? 0;
    if (updated > 0) {
      logger.info({ mailboxId: defaultId, updated }, 'Assigned the default mailbox to existing calendars');
    }
    return updated;
  } catch (err) {
    logger.error({ err, mailboxId: defaultId }, 'Calendar mailbox backfill failed');
    throw err;
  }
}
