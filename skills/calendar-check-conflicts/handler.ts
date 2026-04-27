// skills/calendar-check-conflicts/handler.ts
//
// Checks whether a proposed time slot conflicts with existing busy periods.
// Annotates each conflict with the calendar owner's name from the registry.
// Returns an empty array (clear=true) if the time is free.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../src/time/timestamp.js';

export class CalendarCheckConflictsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.nylasCalendarClient) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const { calendarIds, proposedStart, proposedEnd } = ctx.input as {
      calendarIds?: string[];
      proposedStart?: string;
      proposedEnd?: string;
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

      const tz = ctx.timezone;

      const conflicts: Array<{
        calendarId: string;
        contactName: string | null;
        startTime: string;
        endTime: string;
        status: string;
      }> = [];

      for (const result of freeBusyResults) {
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
          // Check overlap: busy slot overlaps the proposed range
          if (slot.startTime < proposedEndTs && slot.endTime > proposedStartTs) {
            // Format timestamps in the user's local timezone so the LLM reads correct
            // wall-clock times. Falls back to UTC Z-suffix when timezone is not configured.
            conflicts.push({
              calendarId: result.email,
              contactName,
              startTime: tz ? toLocalIso(slot.startTime, tz) : new Date(slot.startTime * 1000).toISOString(),
              endTime: tz ? toLocalIso(slot.endTime, tz) : new Date(slot.endTime * 1000).toISOString(),
              status: slot.status,
            });
          }
        }
      }

      const clear = conflicts.length === 0;
      ctx.log.info({ calendarCount: calendarIds.length, conflictCount: conflicts.length }, 'Checked conflicts');
      return { success: true, data: { conflicts, clear, displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to check conflicts');
      return { success: false, error: `Failed to check conflicts: ${message}` };
    }
  }
}
