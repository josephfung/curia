// backfill-calendar-mailboxes.ts — assign the default mailbox to calendars registered before
// calendars belonged to a mailbox (#2475, Part 4, R3, R72).
//
// Every pre-existing contact_calendars row was read through the single grant, which is the
// default mailbox's. Idempotent: it only touches rows with no mailbox, so it runs on every boot,
// after the flat-mailbox migration has had its chance to create the default mailbox, and again
// after a migration that succeeds at runtime.
//
// One row at a time (SF-M6): a row that would break the one-primary-per-contact-per-mailbox index
// (a primary registered with no mailbox while the contact already has one under the default) is
// left unassigned and counted, instead of failing every other row on every boot.
import type { Pool } from 'pg';
import type { Logger } from '../logger.js';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

export interface CalendarBackfillResult {
  updated: number;
  /** Rows left with no mailbox because the default already has a primary for their contact. */
  skipped: number;
}

/**
 * Set principal_mailbox_id = defaultId on every calendar that has none. With no default mailbox
 * (null) it skips with a warning. A row that conflicts with the default's primary is skipped and
 * counted (warned); any other database failure is logged at error and rethrown, and the caller
 * decides how loud to be. Logs ids and counts only.
 */
export async function backfillCalendarMailboxes(
  pool: Pick<Pool, 'query'>,
  defaultId: string | null,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<CalendarBackfillResult> {
  if (!defaultId) {
    logger.warn('Calendar mailbox backfill skipped: no default principal mailbox yet; retried next boot');
    return { updated: 0, skipped: 0 };
  }
  let updated = 0;
  let skipped = 0;
  try {
    const rows = await pool.query<{ id: string }>(
      'SELECT id FROM contact_calendars WHERE principal_mailbox_id IS NULL ORDER BY created_at, id',
    );
    for (const { id } of rows.rows) {
      try {
        const result = await pool.query(
          'UPDATE contact_calendars SET principal_mailbox_id = $1, updated_at = now() WHERE id = $2 AND principal_mailbox_id IS NULL',
          [defaultId, id],
        );
        updated += result.rowCount ?? 0;
      } catch (err) {
        if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
        skipped++;
      }
    }
  } catch (err) {
    logger.error({ err, mailboxId: defaultId, updated }, 'Calendar mailbox backfill failed');
    throw err;
  }
  if (updated > 0) logger.info({ mailboxId: defaultId, updated }, 'Assigned the default mailbox to existing calendars');
  if (skipped > 0) {
    logger.warn(
      { mailboxId: defaultId, skipped },
      'Calendar mailbox backfill left primary calendars unassigned: their contact already has a primary under the default mailbox. They route only with a stated mailbox until an operator removes the duplicate primary.',
    );
  }
  return { updated, skipped };
}
