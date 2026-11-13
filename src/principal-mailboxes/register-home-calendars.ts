// register-home-calendars.ts — every live principal mailbox has a registered home calendar
// (#2475, R103).
//
// Adding a mailbox in the console registers its home calendar, but a mailbox that came in another
// way (the flat-key migration, an add whose registration failed) may have none. The principal's
// agenda and the debrief scans read registered calendars, so such an account would go missing
// once a second one is added. This idempotent step registers the home calendar of any live
// mailbox whose principal has no primary calendar under it. It runs at boot, after the calendar
// backfill, and again after a deferred migration succeeds at runtime.
//
// One mailbox's failure never stops the others: it is logged at error (mailbox id only) and
// retried on the next run. Logs carry mailbox ids and counts only, never grant or calendar ids.
import type { Logger } from '../logger.js';
import type { HomeCalendarOutcome } from './calendar-hooks.js';
import { grantSafeErrorFields, mayCarryGrantId } from './error-fields.js';

export interface RegisterHomeCalendarsDeps {
  /** The live registry mailboxes (never the deferred-migration fallback, which has no row). */
  liveMailboxes: () => Promise<Array<{ id: string; label: string }>>;
  /** True when the principal has a primary calendar registered under this mailbox. */
  hasHome: (mailboxId: string) => Promise<boolean>;
  registerHome: (mailboxId: string, label: string) => Promise<HomeCalendarOutcome>;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface RegisterHomeCalendarsResult {
  registered: number;
  failed: number;
}

/** Register the home calendar of every live mailbox that lacks one. Never throws. */
export async function registerMissingHomeCalendars(deps: RegisterHomeCalendarsDeps): Promise<RegisterHomeCalendarsResult> {
  const { logger } = deps;
  let mailboxes: Array<{ id: string; label: string }>;
  try {
    mailboxes = await deps.liveMailboxes();
  } catch (err) {
    logger.error({ ...safeFields(err) }, 'Home calendar registration: could not list the principal mailboxes; retried next boot');
    return { registered: 0, failed: 1 };
  }
  let registered = 0;
  let failed = 0;
  for (const m of mailboxes) {
    try {
      if (await deps.hasHome(m.id)) continue;
      const outcome = await deps.registerHome(m.id, m.label);
      if (outcome === 'no_primary_calendar') {
        failed++;
        logger.error({ mailboxId: m.id }, 'Home calendar registration: the mailbox lists no primary calendar; its agenda is read from its grant until one exists; retried next boot');
      } else {
        // 'already_registered': the home calendar is registered to this mailbox, not as primary.
        // It is listed with the principal's calendars, so the account is covered either way.
        if (outcome !== 'already_registered') registered++;
        logger.info({ mailboxId: m.id, outcome }, 'Home calendar registration: the mailbox now has its home calendar');
      }
    } catch (err) {
      failed++;
      logger.error({ mailboxId: m.id, ...safeFields(err) }, 'Home calendar registration failed for one mailbox; retried next boot');
    }
  }
  return { registered, failed };
}

/** The class and status, plus the message only when it cannot echo a grant id. */
function safeFields(err: unknown): Record<string, unknown> {
  return { ...grantSafeErrorFields(err), ...(err instanceof Error && !mayCarryGrantId(err) ? { errMessage: err.message } : {}) };
}
