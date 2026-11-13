// skills/calendar-holds-sweep/handler.ts
//
// calendar-holds-sweep — recurring maintenance skill that deletes stale calendar holds.
//
// A "hold" is a tentative Nylas event tagged with metadata['curia-hold'] === 'true'.
// Holds are placed by calendar-create-hold to block a slot while an offer is outstanding.
// This skill sweeps them once they are no longer needed:
//
//   Stale condition 1: slot end is already in the past (the hold served its purpose or lapsed)
//   Stale condition 2: created-at age exceeds maxAgeDays (offer was never accepted, free the slot)
//
// Design decisions:
//   - action_risk: "low" — this only deletes Curia's own internal holds (no attendees, no
//     notifications). It never touches real calendar events or sends any messages. Using
//     "high" (80) would silently stall cleanup when autonomy dips, which is worse than
//     the risk of the deletion itself.
//   - Per-event try/catch: one failing deleteEvent does not abort the rest of the sweep.
//     A transient Nylas error on one event should not cause the scheduler to retry the
//     entire run; we log failures and continue.
//   - Per-calendar try/catch: a revoked grant on one calendar doesn't prevent sweeping
//     the others. listEvents failures are logged and skipped.
//   - Never throws: skills always return { success, data/error }.
//   - nowMs input seam: the optional nowMs input allows tests to inject a fixed "now"
//     for deterministic staleness checks. In production, this input is always absent
//     and Date.now() is used. Do NOT set this in the scheduler payload.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { holdHasAttendees, isHoldEvent, isHoldStale } from '../../../../src/channels/calendar/holds.js';
import { isUnresolvedPlaceholder, unresolvedPlaceholderError } from '../../../../src/skills/_shared/placeholder-guard.js';
import { isUuid } from '../../../../src/util/uuid.js';
import { CalendarRouteError, type RoutedCalendar } from '../../../../src/channels/calendar/calendar-router.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';
import { calendarRouteErrorMessage, readCalendarMailbox } from '../../../_shared/calendar-route.js';

// Default maximum hold age in days.
const DEFAULT_MAX_AGE_DAYS = 7;

// Sweep window: list events from 14 days in the past through 14 days ahead (symmetric ±14d).
// The lookback into the past is critical for AC #6: Nylas filters out events that have
// already ended, so a forward-only window (timeMin=now) would never return holds whose
// slot has already elapsed — the "slot end in the past" staleness branch would never fire
// in production. By starting 14 days ago, we ensure past-slot holds are returned by
// listEvents and can be detected and deleted by isHoldStale condition 1.
const SWEEP_WINDOW_DAYS = 14;

export class CalendarHoldsSweepHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    // Validate required inputs.
    const { contactId, maxAgeDays: maxAgeDaysInput, nowMs: nowMsInput } = ctx.input as {
      contactId?: string;
      maxAgeDays?: number;
      nowMs?: number;
    };

    if (!contactId || typeof contactId !== 'string') {
      return { success: false, error: 'Missing required input: contactId' };
    }

    // This skill's only caller is the daily cron in agents/calendar.yaml, whose payload
    // carried an uninterpolated `${principal_contact_id}` until #1800 — and there was no
    // UUID check here, so the token went straight to a uuid column as a Postgres parse
    // error. Name the template case explicitly; it is the one a model can act on.
    if (isUnresolvedPlaceholder(contactId)) {
      return { success: false, error: unresolvedPlaceholderError('contactId', contactId) };
    }
    // contactId reaches Postgres as a uuid column, where a non-UUID string is a parse
    // error rather than an empty result. Same check as calendar-list-events.
    if (!isUuid(contactId)) {
      return { success: false, error: `Invalid contactId — must be a UUID, got "${contactId}"` };
    }

    // Guard: the calendar router must be configured.
    const router = ctx.calendarRouter;
    if (!router) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }
    const mailbox = readCalendarMailbox(ctx.input);
    if (!mailbox.ok) return { success: false, error: mailbox.error };
    // A bad mailbox is the caller's input error, checked once: per calendar it would fail every
    // calendar and still report success (a typo'd scheduled sweep would sweep nothing forever).
    if (mailbox.mailbox !== undefined) {
      try {
        await router.mailbox(mailbox.mailbox);
      } catch (err) {
        ctx.log.warn(err instanceof CalendarRouteError ? { code: err.code } : grantSafeErrorFields(err), 'calendar-holds-sweep: the mailbox input is not a live mailbox');
        return { success: false, error: calendarRouteErrorMessage(err) };
      }
    }

    // nowMs: UNDOCUMENTED test-only seam — not part of the skill's public contract and
    // NOT listed in tool.json. Tests inject it via ctx.input.nowMs for deterministic
    // staleness checks. In production this input is always absent; Date.now() is used.
    // nowUnix is seconds; isHoldStale takes seconds for the current time.
    const nowMs = typeof nowMsInput === 'number' ? nowMsInput : Date.now();
    const nowUnix = nowMs / 1000;

    // Convert maxAgeDays (days) to milliseconds for isHoldStale.
    // isHoldStale expects maxAgeMs in milliseconds — this is the critical unit conversion.
    const maxAgeDays = typeof maxAgeDaysInput === 'number' && maxAgeDaysInput > 0
      ? maxAgeDaysInput
      : DEFAULT_MAX_AGE_DAYS;
    const maxAgeMs = maxAgeDays * 86_400_000; // days → ms

    // Build the symmetric ±14d time window for listEvents.
    // timeMin reaches 14 days into the past so that holds whose slot has already elapsed
    // are included in the Nylas response (AC #6: "holds whose slot is past" must be swept).
    // timeMax reaches 14 days into the future to catch recently-placed pending holds.
    const windowStartMs = nowMs - SWEEP_WINDOW_DAYS * 86_400_000;
    const windowEndMs = nowMs + SWEEP_WINDOW_DAYS * 86_400_000;
    const windowStartIso = new Date(windowStartMs).toISOString();
    const windowEndIso = new Date(windowEndMs).toISOString();

    // Resolve the contact's registered calendars.
    // If contactService is absent, surface a clear error (should not happen given
    // the capabilities declaration, but guard defensively).
    if (!ctx.contactService) {
      return { success: false, error: 'contactService not available — cannot look up calendars' };
    }

    let calendars: Array<{ nylasCalendarId: string }>;
    try {
      calendars = await ctx.contactService.getCalendarsForContact(contactId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, contactId }, 'calendar-holds-sweep: failed to resolve calendars');
      return { success: false, error: `Failed to resolve calendars: ${msg}` };
    }

    // Sweep counters.
    let scanned = 0;          // curia-hold events examined
    let expired = 0;          // holds successfully deleted
    let failed = 0;           // stale holds where deleteEvent threw (partial failure)
    let calendarErrors = 0;   // calendars whose listEvents threw / were skipped
    let skippedWithAttendees = 0; // stale holds left in place because someone added attendees

    // Each calendar goes through its own mailbox (#2475); one that cannot be routed (its
    // mailbox removed, say) is skipped and counted like a calendar whose listing failed.
    const targets: RoutedCalendar[] = [];
    for (const cal of calendars) {
      try {
        targets.push(await router.route(cal.nylasCalendarId, mailbox.mailbox));
      } catch (err) {
        ctx.log.error(
          err instanceof CalendarRouteError ? { code: err.code } : grantSafeErrorFields(err),
          'calendar-holds-sweep: could not route a calendar to its mailbox, skipping',
        );
        calendarErrors++;
      }
    }

    // With several mailboxes, holds sit on each mailbox's home calendar (D7), which need not be
    // registered (a grant's own primary is used until it is): the principal's sweep adds every
    // live home calendar it does not already cover. With one mailbox: the registered calendars only, as before.
    try {
      if (contactId === router.principalContactId && (await router.liveMailboxes()).length > 1) {
        for (const home of await router.homeCalendars()) {
          if (home.removed) continue;
          const covered = targets.some((t) => t.mailboxId === home.mailboxId && t.calendarId.toLowerCase() === home.calendarId.toLowerCase());
          if (!covered) targets.push({ mailboxId: home.mailboxId, calendarId: home.calendarId, client: home.client });
        }
      }
    } catch (err) {
      // The registered calendars are still swept; the miss is counted, never silent.
      ctx.log.error(err instanceof CalendarRouteError ? { code: err.code } : grantSafeErrorFields(err), 'calendar-holds-sweep: could not read the mailboxes\' home calendars');
      calendarErrors++;
    }

    // A stated mailbox sweeps that mailbox's calendars only.
    const sweep = mailbox.mailbox === undefined ? targets : targets.filter((t) => t.mailboxId === mailbox.mailbox);

    // Nothing to do if the contact has no calendars.
    if (sweep.length === 0 && calendarErrors === 0) {
      ctx.log.info({ contactId }, 'calendar-holds-sweep: no calendars registered, skipping');
      return { success: true, data: { scanned: 0, expired: 0, failed: 0, calendarErrors: 0, skippedWithAttendees: 0 } };
    }

    // Process each calendar independently.
    // A failure on one calendar (revoked grant, temporary Nylas error) does not
    // prevent sweeping the others — we log and continue.
    for (const routed of sweep) {

      let events: Array<{ id: string; startTime: number | null; endTime: number | null; metadata: Record<string, string> | null; participants: readonly unknown[] }>;
      try {
        events = await routed.client.listEvents(routed.calendarId, windowStartIso, windowEndIso);
      } catch (err) {
        // One calendar failed — log it, increment the counter, and move on to the next.
        ctx.log.error({ ...grantSafeErrorFields(err), mailboxId: routed.mailboxId }, 'calendar-holds-sweep: failed to list events for calendar, skipping');
        calendarErrors++;
        continue;
      }

      // Filter to Curia holds only, then check each for staleness.
      for (const event of events) {
        // Skip non-hold events (regular meetings, all-day events, etc.)
        if (!isHoldEvent(event)) {
          continue;
        }

        scanned++;

        // isHoldStale: returns true when slot end is in the past OR age exceeds maxAgeMs.
        // Note: nowUnix is seconds; maxAgeMs is milliseconds — matches isHoldStale's signature.
        if (!isHoldStale(event, nowUnix, maxAgeMs)) {
          // Hold is fresh — leave it in place.
          continue;
        }

        // A hold someone added attendees to would email them a cancellation on
        // delete; leave it for a person to handle.
        if (holdHasAttendees(event)) {
          skippedWithAttendees++;
          ctx.log.warn({ mailboxId: routed.mailboxId, eventId: event.id }, 'calendar-holds-sweep: stale hold has attendees, leaving it in place');
          continue;
        }

        // Stale hold — attempt deletion.
        // Per-event try/catch: one failure must not abort the rest of the sweep.
        // The hold has no attendees, so the default delete emails nobody. Omit
        // notifyAttendees: Microsoft rejects notify_participants=false with a 400.
        try {
          await routed.client.deleteEvent(routed.calendarId, event.id);
          expired++;
          ctx.log.info({ mailboxId: routed.mailboxId, eventId: event.id }, 'calendar-holds-sweep: deleted stale hold');
        } catch (err) {
          // Log and continue — the hold stays on calendar but the sweep succeeds overall.
          // Increment failed so callers can distinguish "nothing stale" from "deletes failed".
          failed++;
          ctx.log.error(
            { ...grantSafeErrorFields(err), mailboxId: routed.mailboxId, eventId: event.id },
            'calendar-holds-sweep: failed to delete stale hold, continuing sweep',
          );
        }
      }
    }

    ctx.log.info({ contactId, scanned, expired, failed, calendarErrors, skippedWithAttendees }, 'calendar-holds-sweep: sweep complete');
    return { success: true, data: { scanned, expired, failed, calendarErrors, skippedWithAttendees } };
  }
}
