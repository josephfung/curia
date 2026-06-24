// console-originator.ts — resolve the principal TaskOriginator to stamp on rows
// created from the console (dashboard) surface. Issue #1127.
//
// The console's bootstrap secret is CEO-only, so any authenticated console request is
// unambiguously the principal. Tasks and scheduled_jobs created from console routes must
// therefore carry principal **lineage** (#1125's TaskOriginator) — otherwise, under the
// woken-task-authorization model, a missing originator defaults to the conservative agent /
// no-bypass standing and would silently strand console-created work in propose-only mode.
//
// This stamps lineage only. It deliberately never sets the `liveTurn` signal: these are
// persisted, async-wakeable rows, never a live principal turn (see the design note §4).

import type { ContactService } from '../../contacts/contact-service.js';
import { makePrincipalOriginator } from '../../contacts/principal.js';
import type { TaskOriginator } from '../../contacts/types.js';
import type { Logger } from '../../logger.js';

/** Channel value stamped on the originator for console-created rows. */
export const CONSOLE_CHANNEL = 'console';

/**
 * Resolve the principal TaskOriginator for a console-initiated row.
 *
 * Returns a principal-lineage originator when the principal contact can be resolved.
 * Returns null — and logs a warning — when no principal contact exists yet (e.g. a fresh
 * install before seeding) or the lookup fails. A null degrades gracefully to the
 * pre-#1127 behaviour (conservative agent / no-bypass standing); it does not fail the
 * request, because creating the task/job is more important than stamping its lineage.
 */
export async function resolveConsoleOriginator(
  contactService: ContactService,
  logger: Logger,
): Promise<TaskOriginator | null> {
  try {
    const principal = await contactService.findContactBySystemRole('principal');
    if (!principal) {
      logger.warn(
        'console-originator: no principal contact found — console row will carry no lineage (conservative default)',
      );
      return null;
    }
    return makePrincipalOriginator(principal.id, CONSOLE_CHANNEL);
  } catch (err) {
    // Don't fail the create on a lineage-stamp failure; fall back to the conservative default.
    logger.error({ err }, 'console-originator: failed to resolve principal — stamping no lineage');
    return null;
  }
}
