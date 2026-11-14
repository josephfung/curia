// timezone-repair.ts — boot-time self-heal for contact timezones stored before writes were
// normalized.
//
// Until every write went through normalizeTimezone(), any string could land in
// contacts.timezone. A Google Calendar invite footer ("Eastern Time - Toronto") was
// extracted as the principal's timezone on one install, and inbox triage threw on every
// tick. Runs on every boot and is idempotent: once rows are clean it reads and writes nothing.
//
// A value that maps to one zone is rewritten. A value that does not ("Eastern Time - US &
// Canada") is left as is and logged by contact id: nulling it would erase information an
// operator can still correct in the console. The principal's readers (inbox triage, meeting
// minutes, the activity view) fall back to the instance zone through usableTimezone().
// Values are not logged: a timezone label can name where a person lives.

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { isValidTimezone, normalizeTimezone } from '../time/timezone-normalize.js';

export interface TimezoneRepairResult {
  repaired: number;
  unrecognized: number;
  /** Rows whose UPDATE threw; they keep their stored value and are retried next boot. */
  failed: number;
}

export async function repairStoredTimezones(pool: DbPool, logger: Logger): Promise<TimezoneRepairResult> {
  // Validity is decided in JS (Luxon/ICU), not SQL: Postgres' pg_timezone_names is a
  // different zone database and would disagree at the edges.
  const { rows } = await pool.query<{ id: string; timezone: string }>(
    'SELECT id, timezone FROM contacts WHERE timezone IS NOT NULL',
  );
  const repairedIds: string[] = [];
  const unrecognizedIds: string[] = [];
  const failedIds: string[] = [];
  for (const row of rows) {
    if (isValidTimezone(row.timezone)) continue;
    const normalized = normalizeTimezone(row.timezone);
    if (normalized === null) {
      unrecognizedIds.push(row.id);
      continue;
    }
    try {
      // Guarded on the value we read, so a concurrent console edit is never overwritten.
      const result = await pool.query(
        'UPDATE contacts SET timezone = $1, updated_at = now() WHERE id = $2 AND timezone = $3',
        [normalized, row.id, row.timezone],
      );
      // 0 rows: someone changed it since the read; their value wins and is not ours to count.
      if (result.rowCount === 1) repairedIds.push(row.id);
    } catch (err) {
      // One row's failure must not stop the rest, or hide the ones already repaired.
      failedIds.push(row.id);
      logger.error(
        { contactId: row.id, errName: err instanceof Error ? err.name : typeof err },
        'Contact timezone repair: could not update this contact; its stored value is unchanged and will be retried next boot',
      );
    }
  }
  if (repairedIds.length > 0) {
    logger.info({ contactIds: repairedIds }, 'Contact timezone repair: mapped stored timezone labels to IANA zones');
  }
  if (unrecognizedIds.length > 0) {
    logger.warn(
      { contactIds: unrecognizedIds },
      'Contact timezone repair: stored value is not a recognized timezone and could not be mapped; set an IANA zone (e.g. America/Toronto) in the console',
    );
  }
  return { repaired: repairedIds.length, unrecognized: unrecognizedIds.length, failed: failedIds.length };
}
