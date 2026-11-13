// skills/calendar-respond-to-invite/handler.ts
//
// Responds to an existing calendar invitation via Nylas sendRsvp. This endpoint
// scopes the change to the authenticated attendee, so we never write a full
// participants array or risk changing another attendee's status.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { NylasCalendarEvent, NylasRsvpStatus } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import {
  findHoldsForConversationRelease,
  holdHasAttendees,
  type HoldMatchCriteria,
} from '../../../../src/channels/calendar/holds.js';
import { formatDisplayTimezone } from '../../../../src/time/timestamp.js';
import { localizeEventTimes } from '../../../../src/channels/calendar/event-display.js';
import type { RoutedCalendar } from '../../../../src/channels/calendar/calendar-router.js';
import { readCalendarMailbox, routeCalendar } from '../../../_shared/calendar-route.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';

type InviteResponse = 'accept' | 'decline' | 'tentative';

const RESPONSE_TO_NYLAS: Record<InviteResponse, NylasRsvpStatus> = {
  accept: 'yes',
  decline: 'no',
  tentative: 'maybe',
};

const HOLD_SEARCH_PADDING_MS = 14 * 24 * 60 * 60 * 1000;

export class CalendarRespondToInviteHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.calendarRouter) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const input = ctx.input as {
      calendarId?: string;
      eventId?: string;
      response?: string;
      account?: string;
      comment?: string;
      holdMatchCriteria?: HoldMatchCriteria;
      holdSearchStart?: string;
      holdSearchEnd?: string;
    };

    const calendarId = input.calendarId;
    const eventId = input.eventId;
    if (!calendarId || typeof calendarId !== 'string') {
      return { success: false, error: 'Missing required input: calendarId' };
    }
    if (!eventId || typeof eventId !== 'string') {
      return { success: false, error: 'Missing required input: eventId' };
    }

    const normalizedResponse = typeof input.response === 'string'
      ? input.response.trim().toLowerCase()
      : '';
    if (!isInviteResponse(normalizedResponse)) {
      return {
        success: false,
        error: 'Invalid input: response must be one of accept, decline, or tentative',
      };
    }

    if (input.holdSearchStart && isNaN(new Date(input.holdSearchStart).getTime())) {
      return { success: false, error: 'Invalid input: holdSearchStart is not a valid date' };
    }
    if (input.holdSearchEnd && isNaN(new Date(input.holdSearchEnd).getTime())) {
      return { success: false, error: 'Invalid input: holdSearchEnd is not a valid date' };
    }
    if (input.holdSearchStart && input.holdSearchEnd && new Date(input.holdSearchEnd) <= new Date(input.holdSearchStart)) {
      return { success: false, error: 'Invalid input: holdSearchEnd must be after holdSearchStart' };
    }

    const mailbox = readCalendarMailbox(ctx.input);
    if (!mailbox.ok) return { success: false, error: mailbox.error };

    const warnings: string[] = [];
    if (input.account) {
      warnings.push("account is informational; RSVP runs as the mailbox the calendar belongs to");
    }
    if (input.comment) {
      warnings.push('comment was not sent because the installed Nylas sendRsvp SDK accepts RSVP status only');
    }

    try {
      // RSVP is first-person: it answers as the grant it goes through, so it must be the
      // mailbox the calendar belongs to (#2475). `primary` becomes that mailbox's home calendar.
      const route = await routeCalendar(ctx, 'calendar-respond-to-invite', calendarId, mailbox.mailbox);
      if (!route.ok) return { success: false, error: route.error };
      const routed = route.routed;

      if (ctx.contactService) {
        const registry = await ctx.contactService.resolveCalendar(routed.calendarId);
        if (registry?.readOnly) {
          return { success: false, error: 'Calendar is read-only' };
        }
      }

      const participantStatus = RESPONSE_TO_NYLAS[normalizedResponse];
      const rsvp = await routed.client.sendRsvp(routed.calendarId, eventId, participantStatus);
      ctx.log.info({ eventId, response: normalizedResponse, mailboxId: routed.mailboxId }, 'Responded to calendar invite');

      let event: NylasCalendarEvent | null = null;
      try {
        event = await routed.client.getEvent(routed.calendarId, eventId);
      } catch (err) {
        ctx.log.warn({ ...grantSafeErrorFields(err), eventId }, 'calendar-respond-to-invite: RSVP succeeded but event fetch failed');
        warnings.push('RSVP succeeded, but fetching the updated event failed');
      }

      const releaseResult = normalizedResponse === 'accept'
        ? await this.releaseMatchingHolds(ctx, routed, input.holdMatchCriteria, event, input.holdSearchStart, input.holdSearchEnd)
        : { releasedHolds: [] as string[], releaseWarnings: [] as string[] };

      const tz = ctx.timezone;
      const formattedEvent = event
        ? localizeEventTimes(event, tz)
        : null;

      return {
        success: true,
        data: {
          responded: true,
          response: normalizedResponse,
          participantStatus,
          event: formattedEvent,
          rsvp,
          releasedHolds: releaseResult.releasedHolds,
          releaseWarnings: releaseResult.releaseWarnings,
          warnings,
          displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ ...grantSafeErrorFields(err), eventId, response: normalizedResponse }, 'Failed to respond to calendar invite');
      return { success: false, error: `Failed to respond to calendar invite: ${message}` };
    }
  }

  private async releaseMatchingHolds(
    ctx: ToolContext,
    routed: RoutedCalendar,
    criteria: HoldMatchCriteria | undefined,
    event: NylasCalendarEvent | null,
    holdSearchStart?: string,
    holdSearchEnd?: string,
  ): Promise<{ releasedHolds: string[]; releaseWarnings: string[] }> {
    const { client, calendarId } = routed;
    if (!criteria || !hasHoldMatchSignal(criteria)) {
      return { releasedHolds: [], releaseWarnings: [] };
    }

    const window = deriveHoldSearchWindow(event, holdSearchStart, holdSearchEnd);
    if (!window) {
      return {
        releasedHolds: [],
        releaseWarnings: ['Skipped hold cleanup because no hold search window or timed event window was available'],
      };
    }

    let events: NylasCalendarEvent[];
    try {
      events = await client.listEvents(calendarId, window.start, window.end);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn({ ...grantSafeErrorFields(err), mailboxId: routed.mailboxId }, 'calendar-respond-to-invite: failed to list holds for cleanup');
      return {
        releasedHolds: [],
        releaseWarnings: [`Failed to list holds for cleanup: ${message}`],
      };
    }

    const matches = findHoldsForConversationRelease(events, enrichCriteriaWithEventWindow(criteria, event));
    if (matches.length === 0) {
      ctx.log.info(
        { mailboxId: routed.mailboxId, criteria, eventWindow: window },
        'calendar-respond-to-invite: no holds matched conversation ref for release; orphans left to sweep',
      );
    }
    const releasedHolds: string[] = [];
    const releaseWarnings: string[] = [];
    for (const hold of matches) {
      if (holdHasAttendees(hold)) {
        // Deleting would email its attendees a cancellation; leave it for a person.
        releaseWarnings.push(`Hold ${hold.id} has attendees, so it was left in place to avoid emailing them a cancellation.`);
        ctx.log.warn({ mailboxId: routed.mailboxId, holdId: hold.id }, 'calendar-respond-to-invite: matching hold has attendees, not releasing');
        continue;
      }
      try {
        // No notify flag: no attendees to email, and Microsoft rejects false.
        await client.deleteEvent(calendarId, hold.id);
        releasedHolds.push(hold.id);
        ctx.log.info(
          { calendarId, holdId: hold.id },
          'calendar-respond-to-invite: released conversation hold',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        releaseWarnings.push(`Failed to release hold ${hold.id}: ${message}`);
        ctx.log.warn({ ...grantSafeErrorFields(err), mailboxId: routed.mailboxId, holdId: hold.id }, 'calendar-respond-to-invite: failed to release matching hold');
      }
    }

    return { releasedHolds, releaseWarnings };
  }
}

function isInviteResponse(response: string): response is InviteResponse {
  return response === 'accept' || response === 'decline' || response === 'tentative';
}

function deriveHoldSearchWindow(
  event: NylasCalendarEvent | null,
  holdSearchStart?: string,
  holdSearchEnd?: string,
): { start: string; end: string } | null {
  if (holdSearchStart && holdSearchEnd) {
    return { start: holdSearchStart, end: holdSearchEnd };
  }
  if (event?.startTime === null || event?.endTime === null || event?.startTime === undefined || event?.endTime === undefined) {
    return null;
  }
  return {
    start: new Date(event.startTime * 1000 - HOLD_SEARCH_PADDING_MS).toISOString(),
    end: new Date(event.endTime * 1000 + HOLD_SEARCH_PADDING_MS).toISOString(),
  };
}

function hasHoldMatchSignal(criteria: HoldMatchCriteria): boolean {
  return Boolean(criteria.subject || criteria.contactDomain || criteria.contactId || criteria.sourceRef || criteria.threadRef);
}

function enrichCriteriaWithEventWindow(
  criteria: HoldMatchCriteria,
  event: NylasCalendarEvent | null,
): HoldMatchCriteria {
  if (event?.startTime === null || event?.startTime === undefined || event?.endTime === null || event?.endTime === undefined) {
    return criteria;
  }
  return {
    ...criteria,
    startTime: event.startTime,
    endTime: event.endTime,
  };
}
