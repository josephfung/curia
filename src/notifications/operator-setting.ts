// operator-setting.ts — read the operator's address for notification routing (#2710, ADR-068).
//
// Kept apart from ./recipients.ts so the outbound gateway can resolve an audience without
// importing the settings store: the store is admin-only (ADR-067), and the gateway is on every
// send path. This is the one place that couples notification routing to the `operator` key.
import type { Logger } from '../logger.js';
import { getSetting, type SettingsQueryable } from '../settings/store.js';
import type { OperatorSetting } from '../settings/registry.js';

/** The operator's notification address, kept current against a failing database. */
export interface OperatorEmailLookup {
  /** The operator's email, or undefined when there is none. Never throws. */
  read(): Promise<string | undefined>;
  /**
   * Record a value just written, without reading the database. The console and Setup call this
   * after a save or a clear so a later failing read cannot answer with the previous operator —
   * an EA who left must not keep receiving `database_unavailable`.
   */
  remember(operator: OperatorSetting | null): void;
}

/**
 * A reader for the `operator` setting, cached against a failing database.
 *
 * The notice that most needs this is `database_unavailable`, and that is exactly when the
 * settings read fails. So the value is kept: a failed read answers with it, which is the operator
 * the install had a moment ago rather than the wrong person. `remember` keeps it current on
 * every write, so the cache only ages while nothing changes.
 *
 * Before the first successful read there is nothing to answer with, and the notice falls back to
 * the principal as it would on an install with no operator — so that read is logged at error
 * level: it means a notice may be going to the wrong person while the database is down.
 */
export function createOperatorEmailLookup(
  db: SettingsQueryable,
  logger: Pick<Logger, 'warn'> & Pick<Logger, 'error'>,
): OperatorEmailLookup {
  let lastKnown: string | undefined;
  /** Whether any read has succeeded, so `undefined` means "no operator" rather than "unknown". */
  let everRead = false;
  /** Bumped by `remember`, so a read that started before a save or clear cannot overwrite it. */
  let revision = 0;

  return {
    async read() {
      const startRevision = revision;
      try {
        const email = (await getSetting(db, 'operator', logger))?.email;
        // A save or clear landed while this read was in flight: it is newer, keep it.
        if (startRevision !== revision) return lastKnown;
        lastKnown = email;
        everRead = true;
        return lastKnown;
      } catch (err) {
        if (everRead) {
          logger.warn(
            { err, hasOperator: lastKnown !== undefined },
            'notifications: could not read the operator setting — using the last address read',
          );
        } else {
          // No read has ever succeeded, so we cannot tell whether an operator exists: an
          // operator-routed notice will fall back to the principal, which may be the wrong person.
          logger.error(
            { err },
            'notifications: the operator setting has never been read and cannot be now — operator notices fall back to the principal',
          );
        }
        return lastKnown;
      }
    },
    remember(operator) {
      revision += 1;
      lastKnown = operator?.email;
      everRead = true;
    },
  };
}
