// skills/calendar-check-conflicts/handler.ts
//
// Checks whether a proposed time slot conflicts with existing busy periods. The principal's
// calendars are read as events across every connected account (#2475, D7), so each conflict
// carries its title and calendar; other people's calendars are read as free/busy. Each conflict
// is annotated with the calendar owner's name from the registry. clear=true only when nothing
// conflicts and every calendar was read.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { toLocalIso, formatDisplayTimezone } from '../../../../src/time/timestamp.js';
import type { HoldMatchCriteria } from '../../../../src/channels/calendar/holds.js';
import { readCalendarMailbox } from '../../../_shared/calendar-route.js';
import { contactNameFor, readAvailability } from '../../../_shared/calendar-availability.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';

export class CalendarCheckConflictsHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.calendarRouter) {
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

    if (isNaN(new Date(proposedStart).getTime())) {
      return { success: false, error: 'Invalid input: proposedStart is not a valid date' };
    }
    if (isNaN(new Date(proposedEnd).getTime())) {
      return { success: false, error: 'Invalid input: proposedEnd is not a valid date' };
    }

    const mailbox = readCalendarMailbox(ctx.input);
    if (!mailbox.ok) return { success: false, error: mailbox.error };

    try {
      const availability = await readAvailability(ctx, 'calendar-check-conflicts', {
        calendarIds,
        mailbox: mailbox.mailbox,
        timeMin: proposedStart,
        timeMax: proposedEnd,
        ...(ignoreHoldCriteria && hasHoldMatchSignal(ignoreHoldCriteria) ? { ignoreHolds: ignoreHoldCriteria } : {}),
      });
      if (!availability.ok) return { success: false, error: availability.error };
      const read = availability.read;
      if (!read.anyRead) {
        const reasons = read.partial.map((p) => `${p.mailbox_label}: ${p.error}`).join('; ');
        const removed = read.removed.length > 0 ? ` Removed mailboxes: ${read.removed.join(', ')}.` : '';
        return { success: false, error: `Failed to check conflicts: no calendar could be read${reasons ? ` (${reasons})` : ''}.${removed}` };
      }

      const tz = ctx.timezone;
      const proposedStartTs = Math.floor(new Date(proposedStart).getTime() / 1000);
      const proposedEndTs = Math.floor(new Date(proposedEnd).getTime() / 1000);

      // Resolve each calendar's owner once, not once per busy period (no N+1 DB calls).
      const names = new Map<string, string | null>();
      const contactName = async (calendarId: string): Promise<string | null> => {
        if (!names.has(calendarId)) names.set(calendarId, await contactNameFor(ctx, calendarId));
        return names.get(calendarId) ?? null;
      };

      const conflicts: Array<{
        calendarId: string;
        contactName: string | null;
        startTime: string;
        endTime: string;
        status: string;
        eventId?: string | null;
        title?: string | null;
        calendar_label?: string;
      }> = [];
      for (const b of read.blocking) {
        if (!(b.start < proposedEndTs && b.end > proposedStartTs)) continue;
        conflicts.push({
          calendarId: b.calendarId,
          contactName: await contactName(b.calendarId),
          // Blocks are clamped to the plausible window by construction, so toLocalIso is non-null.
          startTime: toLocalIso(b.start, tz)!,
          endTime: toLocalIso(b.end, tz)!,
          status: b.status,
          // The principal's calendars come back as events: what it is and where, so the agent can
          // judge it against the principal's calendaring preferences (D7).
          ...(b.principal ? { eventId: b.eventId, title: b.title, calendar_label: b.calendarLabel } : {}),
        });
      }

      // Never clear when a calendar could not be read: a skipped calendar is not a free one.
      const clear = conflicts.length === 0 && read.partial.length === 0;
      // Derive displayTimezone from the proposed start time rather than "now" so
      // the label's DST offset matches the offsets baked into the conflict timestamps.
      const labelDate = new Date(proposedStart);
      const data: Record<string, unknown> = {
        conflicts,
        clear,
        displayTimezone: tz && conflicts.length > 0 ? formatDisplayTimezone(tz, labelDate) : null,
      };
      if (read.partial.length > 0) data['partial'] = read.partial;
      if (read.removed.length > 0) data['removed'] = read.removed;
      if (read.readVia.length > 0) data['freebusy_via'] = read.readVia;
      ctx.log.info({ calendarCount: calendarIds.length, conflictCount: conflicts.length, partialCount: read.partial.length }, 'Checked conflicts');
      return { success: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ ...grantSafeErrorFields(err) }, 'Failed to check conflicts');
      return { success: false, error: `Failed to check conflicts: ${message}` };
    }
  }
}

function hasHoldMatchSignal(criteria: HoldMatchCriteria): boolean {
  return Boolean(criteria.subject || criteria.contactDomain || criteria.contactId || criteria.sourceRef || criteria.threadRef);
}

