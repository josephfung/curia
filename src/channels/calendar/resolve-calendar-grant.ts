import type { Logger } from '../../logger.js';

/**
 * Resolve the Nylas grant the calendar client operates as.
 *
 * Calendar is FIRST-PERSON: Nylas/Google `sendRsvp` records the response of the
 * attendee whose identity matches the authenticated grant. So the calendar client
 * must bind to the CEO's OWN grant (`ceo_nylas_grant_id`) — the same identity the
 * ceo-inbox skills use — not to Curia's mailbox grant. Binding to Curia's mailbox
 * made Curia a third-party delegate, and Google rejected RSVPs with
 * `omittedAttendeesSpecified` (#1217).
 *
 * Fail closed: with no `ceo_nylas_grant_id` configured there is no principal to act
 * as, so this returns `undefined` and the calendar client is left unconstructed
 * (calendar skills then return a clean "not configured" result). We deliberately do
 * NOT fall back to the primary email account grant — that fallback is exactly the
 * delegate-identity bug this change removes.
 */
export async function resolvePrincipalCalendarGrant(
  secrets: { get(name: string): Promise<string | null> },
  logger: Logger,
): Promise<string | undefined> {
  let grant: string | null;
  try {
    grant = await secrets.get('ceo_nylas_grant_id');
  } catch (err) {
    // A vault read failure must not crash boot; calendar degrades to disabled.
    logger.warn({ err }, 'ceo_nylas_grant_id lookup failed — calendar will be disabled this boot');
    return undefined;
  }
  // Coalesce null -> '' before trimming so a missing entry and a whitespace-only
  // value both resolve to "not configured" rather than a grant that fails auth.
  const trimmed = (grant ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}
