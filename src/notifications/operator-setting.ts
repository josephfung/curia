// operator-setting.ts — read the operator's address for notification routing (#2710, ADR-068).
//
// Kept apart from ./recipients.ts so the outbound gateway can resolve an audience without
// importing the settings store: the store is admin-only (ADR-067), and the gateway is on every
// send path. This is the one place that couples notification routing to the `operator` key.
import type { Logger } from '../logger.js';
import { getSetting, type SettingsQueryable } from '../settings/store.js';

/**
 * A reader for the `operator` setting, cached against a failing database.
 *
 * The notice that most needs this is `database_unavailable`, and that is exactly when the
 * settings read fails. So the last value read is kept: a failed read logs and answers with it,
 * which is the operator the install had a moment ago rather than the wrong person. Before the
 * first successful read there is nothing to keep, and the notice falls back to the principal
 * as it would on an install with no operator.
 */
export function createOperatorEmailLookup(
  db: SettingsQueryable,
  logger: Pick<Logger, 'warn'> & Pick<Logger, 'error'>,
): () => Promise<string | undefined> {
  let lastKnown: string | undefined;
  return async () => {
    try {
      lastKnown = (await getSetting(db, 'operator', logger))?.email;
      return lastKnown;
    } catch (err) {
      logger.warn(
        { err },
        'notifications: could not read the operator setting — using the last address read',
      );
      return lastKnown;
    }
  };
}
