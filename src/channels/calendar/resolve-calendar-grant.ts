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
 * Fail closed: returns `undefined` when `ceo_nylas_grant_id` is genuinely absent
 * (missing, blank, or whitespace-only) — the calendar client is then left
 * unconstructed and calendar skills return a clean "not configured" result. We
 * deliberately do NOT fall back to the primary email account grant — that fallback is
 * exactly the delegate-identity bug this change removes.
 *
 * A vault READ failure is different from absence and is NOT swallowed here: a DB error
 * or a decrypt failure (wrong `SECRET_ENCRYPTION_KEY` / corrupt row) propagates so the
 * caller can surface it loudly. `SecretsService.get` returns `null` for a missing
 * secret but deliberately lets decrypt failures throw ("a real, loud problem"); masking
 * that here would make a whole-system encryption-key misconfiguration look like "the
 * grant simply isn't set". The boot caller (src/index.ts) catches to degrade calendar
 * without crashing boot, but logs the failure at `error` and distinguishes it from
 * genuine absence.
 */
export async function resolvePrincipalCalendarGrant(
  secrets: { get(name: string): Promise<string | null> },
): Promise<string | undefined> {
  // May throw on a DB / decrypt failure — intentionally propagated (see above).
  const grant = await secrets.get('ceo_nylas_grant_id');
  // Coalesce null -> '' before trimming so a missing entry and a whitespace-only
  // value both resolve to "not configured" rather than a grant that fails auth.
  const trimmed = (grant ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}
