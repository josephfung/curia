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
import { CalendarRouteError, PRIMARY_CALENDAR_ALIAS, type RoutedCalendar } from '../../../../src/channels/calendar/calendar-router.js';
import {
  attendeeEvidence,
  calendarRouteErrorMessage,
  evidenceRecipients,
  gateCalendarWrite,
  holdReleaseTargets,
  readCalendarMailbox,
  routeCalendar,
  summarizeEvidence,
} from '../../../_shared/calendar-route.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';
import type { PrincipalMailboxView } from '../../../../src/principal-mailboxes/service.js';
import { sameMeetingKey, sameOrganizer } from '../../../../src/channels/calendar/event-identity.js';

const TOOL = 'calendar-respond-to-invite';

/** The longest hold-cleanup window a caller may pass (SEC-L2). */
const MAX_HOLD_SEARCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How far around the invite the arrival calendar is searched for its copy. */
const UID_LOOKUP_PADDING_MS = 24 * 60 * 60 * 1000;

/** The window to search the arrival calendar in: the invite's time, a day either side. */
function lookupWindow(e: NylasCalendarEvent): { start: string; end: string } | null {
  const startMs = e.startTime !== null ? e.startTime * 1000 : e.startDate ? Date.parse(`${e.startDate}T00:00:00Z`) : NaN;
  const endMs = e.endTime !== null ? e.endTime * 1000 : e.endDate ? Date.parse(`${e.endDate}T00:00:00Z`) : startMs;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  return {
    start: new Date(startMs - UID_LOOKUP_PADDING_MS).toISOString(),
    end: new Date(endMs + UID_LOOKUP_PADDING_MS).toISOString(),
  };
}

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
    // An accept lists and deletes matching holds on every home calendar: the window is bounded (SEC-L2).
    if (input.holdSearchStart && input.holdSearchEnd && new Date(input.holdSearchEnd).getTime() - new Date(input.holdSearchStart).getTime() > MAX_HOLD_SEARCH_WINDOW_MS) {
      return { success: false, error: 'Invalid input: the hold search window is longer than 30 days; nothing was sent. Narrow it to around the meeting.' };
    }

    const mailbox = readCalendarMailbox(ctx.input);
    if (!mailbox.ok) return { success: false, error: mailbox.error };

    // `account` became `mailbox` (#2475) and is enforced; an old-style call is told so rather
    // than answered from whichever account the calendar happens to route to.
    if (input.account !== undefined) {
      return {
        success: false,
        error: 'account is no longer accepted: pass the id of the mailbox the invite arrived in as mailbox (the consult\'s mailbox=). Nothing was sent.',
      };
    }

    const warnings: string[] = [];
    if (input.comment) {
      warnings.push('comment was not sent because the installed Nylas sendRsvp SDK accepts RSVP status only');
    }

    try {
      // RSVP is first-person: it answers as the grant it goes through, so it must be the
      // mailbox the invite arrived in (#2475, D7, R83). With one mailbox: as before. With several,
      // on the principal's calendars `mailbox` (the arrival mailbox) is required, and when the
      // given calendar belongs to another account the invite is found in the arrival account by
      // its iCal UID; if it is not there, nothing is sent. Never answered from the other account.
      const target = await this.resolveTarget(ctx, calendarId, eventId, mailbox.mailbox);
      if (target.kind === 'error') return { success: false, error: target.error };
      if (target.kind === 'needs_mailbox') return target.result;
      const { routed, multi, principal } = target;
      const rsvpEventId = target.eventId;

      if (ctx.contactService) {
        const registry = await ctx.contactService.resolveCalendar(routed.calendarId);
        if (registry?.readOnly) {
          return { success: false, error: 'Calendar is read-only' };
        }
      }

      const participantStatus = RESPONSE_TO_NYLAS[normalizedResponse];
      const rsvp = await routed.client.sendRsvp(routed.calendarId, rsvpEventId, participantStatus);
      ctx.log.info({ eventId: rsvpEventId, response: normalizedResponse, mailboxId: routed.mailboxId, foundByIcalUid: target.foundByIcalUid }, 'Responded to calendar invite');

      let event: NylasCalendarEvent | null = null;
      try {
        event = await routed.client.getEvent(routed.calendarId, rsvpEventId);
      } catch (err) {
        ctx.log.warn({ ...grantSafeErrorFields(err), eventId: rsvpEventId }, 'calendar-respond-to-invite: RSVP succeeded but event fetch failed');
        warnings.push('RSVP succeeded, but fetching the updated event failed');
      }

      const releaseResult = normalizedResponse === 'accept'
        ? await this.releaseMatchingHolds(ctx, routed, multi && principal, input.holdMatchCriteria, event, input.holdSearchStart, input.holdSearchEnd)
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
          // With several mailboxes, the account that answered (D7); single: as before.
          ...(multi ? { mailbox: routed.mailboxId } : {}),
          // The arrival account's own copy of the invite, found by iCal UID (R83).
          ...(target.foundByIcalUid ? { calendarId: routed.calendarId, eventId: rsvpEventId, found_by_ical_uid: true } : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ ...grantSafeErrorFields(err), eventId, response: normalizedResponse }, 'Failed to respond to calendar invite');
      return { success: false, error: `Failed to respond to calendar invite: ${message}` };
    }
  }

  /**
   * Which grant answers and which event id it answers on (R83).
   * - One live mailbox, or a calendar that is not the principal's: the calendar's own mailbox,
   *   and a stated `mailbox` must own it (calendar_mailbox_mismatch), exactly as before.
   * - Several live mailboxes, a principal calendar, no `mailbox`: needs_mailbox, nothing sent.
   * - Several, with `mailbox` (the arrival mailbox): when the calendar belongs to that mailbox,
   *   answer there. Otherwise read the given event's iCal UID through the calendar's own grant
   *   (a read), list the arrival mailbox's home calendar around the event, and match the UID and
   *   occurrence in our own code. Not found → refused, nothing sent.
   */
  private async resolveTarget(
    ctx: ToolContext,
    calendarId: string,
    eventId: string,
    mailbox: string | undefined,
  ): Promise<
    | { kind: 'proceed'; routed: RoutedCalendar; eventId: string; multi: boolean; principal: boolean; foundByIcalUid: boolean }
    | { kind: 'needs_mailbox'; result: ToolResult }
    | { kind: 'error'; error: string }
  > {
    const router = ctx.calendarRouter!;
    let live: PrincipalMailboxView[];
    let principal = false;
    try {
      live = await router.liveMailboxes();
      if (live.length > 1) principal = await router.isPrincipalCalendar(calendarId);
    } catch (err) {
      ctx.log.error({ ...grantSafeErrorFields(err) }, 'calendar-respond-to-invite: could not read the mailboxes');
      return { kind: 'error', error: calendarRouteErrorMessage(err) };
    }
    const multi = live.length > 1;

    if (!multi || !principal) {
      const gate = await gateCalendarWrite(ctx, TOOL, calendarId, mailbox, {
        requireMailbox: false,
        mismatchAdvice: `Answer from the mailbox the invite arrived in, on that mailbox's own calendar.`,
      });
      // requireMailbox is false, so the gate's answer is proceed or error.
      if (gate.kind !== 'proceed') return { kind: 'error', error: gate.kind === 'error' ? gate.error : 'needs_mailbox' };
      return { kind: 'proceed', routed: gate.routed, eventId, multi, principal, foundByIcalUid: false };
    }

    if (mailbox === undefined) {
      ctx.log.info({ code: 'needs_mailbox', liveCount: live.length }, 'calendar-respond-to-invite: an RSVP on the principal\'s calendar needs the arrival mailbox');
      // A failure, not a success (R88): the invite flow reports a successful call as an RSVP sent.
      const participants = await this.inviteParticipants(ctx, calendarId, eventId, live);
      let evidenceLine = '';
      if (participants.unreadable) {
        evidenceLine = ' The invite\'s participants could not be read, so there is no evidence.';
      } else if (participants.recipients.length > 0) {
        const evidence = await attendeeEvidence(ctx, TOOL, participants.recipients);
        evidenceLine = evidence ? ` Evidence for the participants: ${summarizeEvidence(evidence)}.` : ' Evidence for the participants is unavailable.';
      }
      const choices = live.map((m) => `${m.id} (${m.label})`).join(', ');
      return {
        kind: 'needs_mailbox',
        result: {
          success: false,
          error:
            `needs_mailbox: nothing was sent. Several accounts are connected; pass mailbox as the mailbox the invite arrived in ` +
            `(the consult's mailbox=), one of: ${choices}.${evidenceLine}`,
        },
      };
    }

    // The hint is validated; a registered or owned calendar routes to its own mailbox regardless.
    const source = await routeCalendar(ctx, TOOL, calendarId, mailbox);
    if (!source.ok) return { kind: 'error', error: source.error };
    if (source.routed.mailboxId === mailbox) {
      return { kind: 'proceed', routed: source.routed, eventId, multi, principal, foundByIcalUid: false };
    }

    // The given calendar is another account's: find the arrival account's own copy by iCal UID.
    const arrival = live.find((m) => m.id === mailbox);
    const where = `mailbox "${mailbox}"${arrival ? ` (${arrival.label})` : ''}`;
    let invite: NylasCalendarEvent;
    try {
      invite = await source.routed.client.getEvent(source.routed.calendarId, eventId);
    } catch (err) {
      // R78: the upstream reason stays in the tool error; the log is grant-safe.
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn({ ...grantSafeErrorFields(err), mailboxId: source.routed.mailboxId }, 'calendar-respond-to-invite: could not read the invite to find it in the arrival mailbox');
      return { kind: 'error', error: `Could not read the invite to find it in ${where}: ${message}. Nothing was sent.` };
    }
    const key = sameMeetingKey(invite);
    const window = lookupWindow(invite);
    if (key === null || !window) {
      ctx.log.info({ mailboxId: mailbox, hasUid: key !== null }, 'calendar-respond-to-invite: invite has no iCal UID or time to match by');
      return { kind: 'error', error: `The invite has no iCal UID or time, so it cannot be found in ${where}. Nothing was sent. Pass calendarId and eventId of the invite as it appears on that mailbox's calendar.` };
    }
    const home = await routeCalendar(ctx, TOOL, PRIMARY_CALENDAR_ALIAS, mailbox);
    if (!home.ok) return { kind: 'error', error: home.error };
    let candidates: NylasCalendarEvent[];
    try {
      candidates = await home.routed.client.listEvents(home.routed.calendarId, window.start, window.end);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn({ ...grantSafeErrorFields(err), mailboxId: mailbox }, 'calendar-respond-to-invite: could not list the arrival mailbox\'s calendar');
      return { kind: 'error', error: `Could not search ${where} for the invite: ${message}. Nothing was sent.` };
    }
    // The UID is set by whoever sent the invite, so it is never enough on its own (R87): the
    // arrival copy must agree on UID, occurrence, start, end, title, organizer, location and
    // link (the list-events rule, R99), and both copies must name an organizer. Exactly one such copy is answered; none or several, nothing.
    const matches = candidates.filter((c) => sameMeetingKey(c) === key && sameOrganizer(c, invite));
    if (matches.length !== 1) {
      const ambiguous = matches.length > 1;
      ctx.log.info({ mailboxId: mailbox, candidateCount: candidates.length, matchCount: matches.length }, ambiguous
        ? 'calendar-respond-to-invite: invite is ambiguous in the arrival mailbox'
        : 'calendar-respond-to-invite: invite not found in the arrival mailbox');
      return {
        kind: 'error',
        error: ambiguous
          ? `This invite matches ${matches.length} events on the calendar of ${where}, the mailbox it arrived in, so it is ambiguous. Nothing was sent from either account.`
          : `This invite was not found on the calendar of ${where}, the mailbox it arrived in (same UID, time, title and organizer). Nothing was sent; it is not answered from another account.`,
      };
    }
    return { kind: 'proceed', routed: home.routed, eventId: matches[0]!.id, multi, principal, foundByIcalUid: true };
  }

  /**
   * The invite's participants, for evidence when the mailbox is missing. Best-effort:
   * `unreadable` when the calendar could not be routed without a mailbox (`primary`, an
   * unregistered calendar) or the event could not be read, so the caller can say so.
   */
  private async inviteParticipants(
    ctx: ToolContext,
    calendarId: string,
    eventId: string,
    live: PrincipalMailboxView[],
  ): Promise<{ recipients: string[]; unreadable: boolean }> {
    try {
      const routed = await ctx.calendarRouter!.route(calendarId);
      const evt = await routed.client.getEvent(routed.calendarId, eventId);
      return { recipients: evidenceRecipients(evt.participants.map((p) => p.email), live), unreadable: false };
    } catch (err) {
      ctx.log.warn(
        err instanceof CalendarRouteError ? { code: err.code } : grantSafeErrorFields(err),
        'calendar-respond-to-invite: the invite\'s participants could not be read for evidence',
      );
      return { recipients: [], unreadable: true };
    }
  }

  private async releaseMatchingHolds(
    ctx: ToolContext,
    routed: RoutedCalendar,
    searchHomes: boolean,
    criteria: HoldMatchCriteria | undefined,
    event: NylasCalendarEvent | null,
    holdSearchStart?: string,
    holdSearchEnd?: string,
  ): Promise<{ releasedHolds: string[]; releaseWarnings: string[] }> {
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
    // The same 30-day bound applies to a window derived from the event (it pads each side), not
    // only to stated bounds (SEC-L2). The RSVP is already sent, so cleanup is skipped with a warning.
    if (new Date(window.end).getTime() - new Date(window.start).getTime() > MAX_HOLD_SEARCH_WINDOW_MS) {
      ctx.log.warn({ tool: TOOL }, 'calendar-respond-to-invite: derived hold search window longer than 30 days; cleanup skipped');
      return {
        releasedHolds: [],
        releaseWarnings: ['Skipped hold cleanup: the search window around this event is longer than 30 days. Release any holds by hand.'],
      };
    }

    // With several mailboxes the conversation's holds may be on another account's home
    // calendar (D7): every live home calendar is searched. With one mailbox: this calendar only.
    const { targets, warnings: releaseWarnings } = await holdReleaseTargets(ctx, TOOL, routed, searchHomes);
    const matchCriteria = enrichCriteriaWithEventWindow(criteria, event);
    const releasedHolds: string[] = [];
    let matched = 0;
    for (const target of targets) {
      const { client, calendarId } = target;
      let events: NylasCalendarEvent[];
      try {
        events = await client.listEvents(calendarId, window.start, window.end);
      } catch (err) {
        // The upstream reason stays in the warning (R78); the log is grant-safe.
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.warn({ ...grantSafeErrorFields(err), mailboxId: target.mailboxId }, 'calendar-respond-to-invite: failed to list holds for cleanup');
        releaseWarnings.push(`Failed to list holds for cleanup: ${message}`);
        continue;
      }

      const matches = findHoldsForConversationRelease(events, matchCriteria);
      matched += matches.length;
      for (const hold of matches) {
        if (holdHasAttendees(hold)) {
          // Deleting would email its attendees a cancellation; leave it for a person.
          releaseWarnings.push(`Hold ${hold.id} has attendees, so it was left in place to avoid emailing them a cancellation.`);
          ctx.log.warn({ mailboxId: target.mailboxId, holdId: hold.id }, 'calendar-respond-to-invite: matching hold has attendees, not releasing');
          continue;
        }
        try {
          // No notify flag: no attendees to email, and Microsoft rejects false.
          await client.deleteEvent(calendarId, hold.id);
          releasedHolds.push(hold.id);
          ctx.log.info(
            { mailboxId: target.mailboxId, holdId: hold.id },
            'calendar-respond-to-invite: released conversation hold',
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          releaseWarnings.push(`Failed to release hold ${hold.id}: ${message}`);
          ctx.log.warn({ ...grantSafeErrorFields(err), mailboxId: target.mailboxId, holdId: hold.id }, 'calendar-respond-to-invite: failed to release matching hold');
        }
      }
    }
    if (matched === 0) {
      ctx.log.info(
        { mailboxId: routed.mailboxId, calendarCount: targets.length, criteria, eventWindow: window },
        'calendar-respond-to-invite: no holds matched conversation ref for release; orphans left to sweep',
      );
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
