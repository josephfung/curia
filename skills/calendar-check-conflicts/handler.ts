// skills/calendar-check-conflicts/handler.ts
//
// Checks whether a proposed time slot conflicts with existing busy periods.
// Annotates each conflict with the calendar owner's name from the registry.
// Returns an empty array (clear=true) if the time is free.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';
import { eventsOverlap, findHoldsForConversationRelease, type HoldMatchCriteria } from '../../src/channels/calendar/holds.js';

export class CalendarCheckConflictsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.nylasCalendarClient) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const { calendarIds, proposedStart, proposedEnd, ignoreHoldCriteria } = ctx.input as {
      calendarIds?: string[];
      proposedStart?: string;
      proposedEnd?: string;
      ignoreHoldCriteria?: HoldMatchCriteria;
    };

    if (!calendarIds || !Array.isArray(calendarIds) || calendarIds.length === 0) {
      return { success: false, error: 'Missing required input: calendarIds (must be a non-empty array)' };
    }
    if (!proposedStart || typeof proposedStart !== 'string') {
      return { success: false, error: 'Missing required input: proposedStart' };
    }
    if (!proposedEnd || typeof proposedEnd !== 'string') {
      return { success: false, error: 'Missing required input: proposedEnd' };
    }

    try {
      const freeBusyResults = await ctx.nylasCalendarClient.getFreeBusy(calendarIds, proposedStart, proposedEnd);

      const proposedStartTs = Math.floor(new Date(proposedStart).getTime() / 1000);
      const proposedEndTs = Math.floor(new Date(proposedEnd).getTime() / 1000);
      const ignoredHoldWindowsByCalendar = new Map<string, Array<{ startTime: number; endTime: number }>>();
      if (ignoreHoldCriteria && hasHoldMatchSignal(ignoreHoldCriteria)) {
        for (const calendarId of calendarIds) {
          try {
            const events = await ctx.nylasCalendarClient.listEvents(calendarId, proposedStart, proposedEnd);
            const matchingHolds = findHoldsForConversationRelease(events, {
              ...ignoreHoldCriteria,
              startTime: proposedStartTs,
              endTime: proposedEndTs,
            });
            if (matchingHolds.length > 0) {
              ignoredHoldWindowsByCalendar.set(
                calendarId,
                matchingHolds
                  .filter((hold) => hold.startTime !== null && hold.endTime !== null)
                  .map((hold) => ({
                    startTime: hold.startTime!,
                    endTime: hold.endTime!,
                  })),
              );
            }
          } catch (err) {
            ctx.log.warn({ err, calendarId }, 'calendar-check-conflicts: failed to inspect holds for ignore criteria');
          }
        }
      }

      const tz = ctx.timezone;

      const conflicts: Array<{
        calendarId: string;
        contactName: string | null;
        startTime: string;
        endTime: string;
        status: string;
      }> = [];

      for (let resultIndex = 0; resultIndex < freeBusyResults.length; resultIndex++) {
        const result = freeBusyResults[resultIndex]!;
        const queriedCalendarId = calendarIds[resultIndex] ?? result.email;
        // Resolve contact name once per calendar result, not once per busy slot — avoids N+1 DB calls.
        let contactName: string | null = null;
        if (ctx.contactService) {
          const registry = await ctx.contactService.resolveCalendar(result.email);
          if (registry?.contactId) {
            const contact = await ctx.contactService.getContact(registry.contactId);
            contactName = contact?.displayName ?? null;
          }
        }

        for (const slot of result.timeSlots) {
          // Free events do not conflict; only non-free (busy/tentative) slots are conflicts. See #1137.
          if (slot.status === 'free') continue;
          const ignoredHoldWindows =
            ignoredHoldWindowsByCalendar.get(result.email) ??
            ignoredHoldWindowsByCalendar.get(queriedCalendarId);
          if (ignoredHoldWindows && ignoredHoldWindows.length > 0) {
            const overlapsIgnoredHold = ignoredHoldWindows.some((event) =>
              eventsOverlap(slot.startTime, slot.endTime, event.startTime, event.endTime),
            );
            if (overlapsIgnoredHold) continue;
          }
          // Check overlap: busy slot overlaps the proposed range
          if (slot.startTime < proposedEndTs && slot.endTime > proposedStartTs) {
            const startTime = toLocalIso(slot.startTime, tz);
            const endTime = toLocalIso(slot.endTime, tz);
            // Skip corrupt slots — a conflict entry with no timestamps is not actionable.
            if (startTime === null || endTime === null) continue;
            conflicts.push({ calendarId: result.email, contactName, startTime, endTime, status: slot.status });
          }
        }
      }

      const clear = conflicts.length === 0;
      // Derive displayTimezone from the proposed start time rather than "now" so
      // the label's DST offset matches the offsets baked into the conflict timestamps.
      const labelDate = new Date(proposedStart);
      ctx.log.info({ calendarCount: calendarIds.length, conflictCount: conflicts.length }, 'Checked conflicts');
      return { success: true, data: { conflicts, clear, displayTimezone: tz && !clear ? formatDisplayTimezone(tz, labelDate) : null } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to check conflicts');
      return { success: false, error: `Failed to check conflicts: ${message}` };
    }
  }
}

function hasHoldMatchSignal(criteria: HoldMatchCriteria): boolean {
  return Boolean(criteria.subject || criteria.contactDomain || criteria.contactId || criteria.sourceRef || criteria.threadRef);
}
