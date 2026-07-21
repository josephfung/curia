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
import { isHoldEvent, isHoldStale } from '../../../../src/channels/calendar/holds.js';

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

    // Guard: Nylas calendar client must be configured.
    if (!ctx.nylasCalendarClient) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
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

    // Nothing to do if the contact has no registered calendars.
    if (calendars.length === 0) {
      ctx.log.info({ contactId }, 'calendar-holds-sweep: no calendars registered, skipping');
      return { success: true, data: { scanned: 0, expired: 0 } };
    }

    // Sweep counters.
    let scanned = 0;          // curia-hold events examined
    let expired = 0;          // holds successfully deleted
    let failed = 0;           // stale holds where deleteEvent threw (partial failure)
    let calendarErrors = 0;   // calendars whose listEvents threw / were skipped

    // Process each calendar independently.
    // A failure on one calendar (revoked grant, temporary Nylas error) does not
    // prevent sweeping the others — we log and continue.
    for (const cal of calendars) {
      const calId = cal.nylasCalendarId;

      let events: Array<{ id: string; startTime: number | null; endTime: number | null; metadata: Record<string, string> | null }>;
      try {
        events = await ctx.nylasCalendarClient.listEvents(calId, windowStartIso, windowEndIso);
      } catch (err) {
        // One calendar failed — log it, increment the counter, and move on to the next.
        ctx.log.error({ err, calId }, 'calendar-holds-sweep: failed to list events for calendar, skipping');
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

        // Stale hold — attempt deletion.
        // Per-event try/catch: one failure must not abort the rest of the sweep.
        // Holds are internal-only (no attendees), so notifyAttendees=false suppresses
        // any Nylas cancellation email logic.
        try {
          await ctx.nylasCalendarClient.deleteEvent(calId, event.id, false);
          expired++;
          ctx.log.info({ calId, eventId: event.id }, 'calendar-holds-sweep: deleted stale hold');
        } catch (err) {
          // Log and continue — the hold stays on calendar but the sweep succeeds overall.
          // Increment failed so callers can distinguish "nothing stale" from "deletes failed".
          failed++;
          ctx.log.error(
            { err, calId, eventId: event.id },
            'calendar-holds-sweep: failed to delete stale hold, continuing sweep',
          );
        }
      }
    }

    ctx.log.info({ contactId, scanned, expired, failed, calendarErrors }, 'calendar-holds-sweep: sweep complete');
    return { success: true, data: { scanned, expired, failed, calendarErrors } };
  }
}
