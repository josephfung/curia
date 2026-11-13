// skills/calendar-list-events/handler.ts
//
// Fetches events for a date range from one or more calendars, with optional
// client-side filtering by text query or attendee email.
//
// When calendarId is provided, queries that single calendar.
// When omitted, resolves ALL calendars registered to the caller (via
// contactService) and merges events across them — so "what's my agenda?"
// works without the LLM needing to know specific calendar IDs.
//
// Nylas doesn't support server-side text search on event fields, so
// the skill fetches all events in range and filters locally.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { NylasCalendarEvent } from '../../../../src/channels/calendar/nylas-calendar-client.js';
import { formatDisplayTimezone } from '../../../../src/time/timestamp.js';
import { localizeEventTimes } from '../../../../src/channels/calendar/event-display.js';
import { sameMeetingKey } from '../../../../src/channels/calendar/event-identity.js';
import { isSystemOriginated, isPrincipalOriginated } from '../../../../src/contacts/principal.js';
import { isUnresolvedPlaceholder, unresolvedPlaceholderError } from '../../../../src/skills/_shared/placeholder-guard.js';
import { guardNylasExplicitCalendarIdentity } from '../../../../src/skills/_shared/calendar-identity-guard.js';
import { isUuid } from '../../../../src/util/uuid.js';
import { CalendarRouteError, type RoutedCalendar } from '../../../../src/channels/calendar/calendar-router.js';
import { readCalendarMailbox, routeCalendar } from '../../../_shared/calendar-route.js';
import { grantSafeErrorFields } from '../../../../src/principal-mailboxes/error-fields.js';

export class CalendarListEventsHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const router = ctx.calendarRouter;
    if (!router) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const { calendarId, contactId, timeMin, timeMax, maxResults, query, attendeeEmail } = ctx.input as {
      calendarId?: string;
      contactId?: string;
      timeMin?: string;
      timeMax?: string;
      maxResults?: number;
      query?: string;
      attendeeEmail?: string;
    };

    if (!timeMin || typeof timeMin !== 'string') {
      return { success: false, error: 'Missing required input: timeMin' };
    }
    if (!timeMax || typeof timeMax !== 'string') {
      return { success: false, error: 'Missing required input: timeMax' };
    }
    const mailbox = readCalendarMailbox(ctx.input);
    if (!mailbox.ok) return { success: false, error: mailbox.error };

    try {
      // Resolve which calendar(s) to query.
      // Priority: explicit calendarId > explicit contactId lookup > caller auto-lookup.
      let calendarIds: string[];
      const preRouted = new Map<string, RoutedCalendar>();

      if (calendarId && typeof calendarId === 'string') {
        // Principal-scoped task + calendar registered to a non-principal contact → fail closed (#1854).
        const identityGuard = await guardNylasExplicitCalendarIdentity({ calendarId, ctx });
        if (identityGuard) return identityGuard;
        // An explicit calendar that cannot be routed (needs a mailbox, say) is the caller's to fix.
        const route = await routeCalendar(ctx, 'calendar-list-events', calendarId, mailbox.mailbox);
        if (!route.ok) return { success: false, error: route.error };
        preRouted.set(calendarId, route.routed);
        calendarIds = [calendarId];
      } else if (contactId && typeof contactId === 'string') {
        // Explicit contactId provided — used by scheduled agents that don't have a
        // real caller contact (they pass the principal's contact ID from their prompt
        // to look up the principal's calendars).
        //
        // Checked before the override gate below: a literal `${...}` token is not an
        // attempt to read someone else's calendar, it's a prompt that never got
        // interpolated (#1800). Answering "not allowed" would send the model hunting for
        // permission it already has; naming the real fault lets it recover. The message
        // discloses nothing about contacts or calendars, so ordering it first is safe.
        if (isUnresolvedPlaceholder(contactId)) {
          return { success: false, error: unresolvedPlaceholderError('contactId', contactId) };
        }
        //
        // Only allow this override in two cases:
        //   1. System/scheduled context (caller contactId is not a UUID — it's 'system' etc.)
        //   2. Principal caller (role === 'ceo') — the principal can look up any contact's calendars
        // This prevents LLM-driven non-principal agents from reading other contacts' calendars
        // by constructing a contactId value.
        // Use trusted originator metadata, not caller shape, to avoid misclassifying
        // agent-originated delegated tasks (which can have non-UUID contactIds) as system.
        const callerIsSystem = isSystemOriginated(ctx.taskMetadata);
        const callerIsPrincipal = isPrincipalOriginated(ctx.taskMetadata);
        if (!callerIsSystem && !callerIsPrincipal) {
          return {
            success: false,
            error: `contactId override is not allowed for this caller — only system-context (scheduled) invocations and principal callers may look up calendars by contactId`,
          };
        }
        if (!isUuid(contactId)) {
          return {
            success: false,
            error: `Invalid contactId — must be a UUID, got "${contactId}"`,
          };
        }
        if (!ctx.contactService) {
          return { success: false, error: 'contactService not available — cannot look up calendars by contactId' };
        }
        const calendars = await ctx.contactService.getCalendarsForContact(contactId);
        if (calendars.length === 0) {
          return { success: false, error: `No calendars registered for contact ${contactId} — register a calendar first` };
        }
        calendarIds = calendars.map((c) => c.nylasCalendarId);
        ctx.log.info({ contactId, calendarCount: calendarIds.length }, 'Resolved calendars for explicit contactId');
      } else if (ctx.contactService && ctx.caller) {
        // Fall back to the caller's own contact — works for human-initiated tasks
        // where the caller is a real contact UUID.
        // Two non-UUID sentinel values can appear in ctx.caller.contactId:
        //   'system'       — scheduled-job invocations (see makeSystemOriginator in contacts/principal.ts)
        //   'primary-user' — CLI sessions where the principal DB lookup failed at bootstrap
        // Both cause a Postgres parse error if passed to a UUID column.
        if (!isUuid(ctx.caller.contactId)) {
          ctx.log.warn(
            { contactId: ctx.caller.contactId },
            "calendar-list-events: caller contactId is not a UUID — pass contactId (the principal's contact ID from the agent's system prompt) for scheduled invocations",
          );
          return {
            success: false,
            error: `calendarId or contactId is required when invoked from a non-contact-resolved context (caller contactId "${ctx.caller.contactId}" is not a UUID)`,
          };
        }
        const calendars = await ctx.contactService.getCalendarsForContact(ctx.caller.contactId);
        if (calendars.length === 0) {
          return { success: false, error: 'No calendars registered for this contact — register a calendar first' };
        }
        calendarIds = calendars.map((c) => c.nylasCalendarId);
        ctx.log.info({ contactId: ctx.caller.contactId, calendarCount: calendarIds.length }, 'Resolved caller calendars');
      } else {
        return { success: false, error: 'Missing required input: calendarId or contactId (and unable to resolve caller calendars)' };
      }

      // maxResults is the total wanted, not a page size — the client pages for it
      // rather than sending an oversized (and 400-rejected) Nylas limit (#1798).
      const fetchLimit = typeof maxResults === 'number' && maxResults > 0 ? { limit: maxResults } : undefined;

      // Fetch events from all resolved calendars in parallel, then merge.
      // Use allSettled so one bad calendar (stale grant, revoked access) doesn't
      // poison the entire result — return partial results and log failures.
      // Each calendar goes through its own mailbox (#2475); one that cannot be routed fails
      // like one whose fetch failed, and the others still answer.
      const settled = await Promise.allSettled(
        calendarIds.map(async (cid) => {
          const routed = preRouted.get(cid) ?? (await router.route(cid, mailbox.mailbox));
          const listed = await routed.client.listEvents(routed.calendarId, timeMin, timeMax, fetchLimit);
          return listed.map((evt) => ({ evt, mailboxId: routed.mailboxId, calendarId: routed.calendarId }));
        }),
      );

      const failedCalendarIds: string[] = [];
      const rejectionReasons: unknown[] = [];
      // "<calendarId>: <upstream message>" per failure, so the agent can see *why*
      // a calendar failed and correct its own inputs instead of retrying blind (#1798).
      const failureDetails: string[] = [];
      const successfulEvents: SourcedEvent[][] = [];
      for (let i = 0; i < settled.length; i++) {
        // settled is mapped 1:1 from calendarIds and i is bounded by settled.length, so
        // both indexed accesses are guaranteed present (noUncheckedIndexedAccess types
        // them as possibly-undefined). The guard on .status then narrows the
        // PromiseSettledResult to its fulfilled/rejected member (.value / .reason).
        const result = settled[i]!;
        const calendarId = calendarIds[i]!;
        if (result.status === 'fulfilled') {
          successfulEvents.push(result.value);
        } else {
          failedCalendarIds.push(calendarId);
          rejectionReasons.push(result.reason);
          failureDetails.push(`${calendarId}: ${describeRejection(result.reason)}`);
          if (result.reason instanceof CalendarRouteError) {
            ctx.log.warn({ code: result.reason.code }, 'calendar-list-events: a calendar could not be routed to its mailbox');
          } else {
            ctx.log.error({ ...grantSafeErrorFields(result.reason) }, 'Failed to fetch events for calendar');
          }
        }
      }

      if (successfulEvents.length === 0) {
        if (failedCalendarIds.length === 0) {
          return { success: false, error: 'No events found' };
        }
        // When every calendar fails with an auth-class error (Nylas statusCode
        // 401/403), name the grant/reconnect action so the briefing can tell the
        // principal what to do (#1561). Mixed/non-auth failures keep the generic message.
        const allAuth = rejectionReasons.length > 0
          && rejectionReasons.every(isNylasAuthFailure);
        if (allAuth) {
          return {
            success: false,
            errorType: 'AUTH_FAILURE',
            error:
              `Calendar authorization failed for all calendars (${failedCalendarIds.join(', ')}): ` +
              "the principal mailbox's Nylas grant was rejected by Google/Nylas " +
              "(401/403). Reconnect it in the Nylas dashboard, use Replace grant on the mailbox in the console, then retry.",
          };
        }
        return {
          success: false,
          error: `Failed to list events from any calendar (${failedCalendarIds.length} failed: ${failureDetails.join('; ')})`,
        };
      }

      const sourced = successfulEvents.flat();

      // Sort merged events by start time so the agenda reads chronologically.
      // Timed events use startTime (Unix seconds). All-day events have startTime=null and
      // startDate='YYYY-MM-DD'; parse startDate to a comparable Unix seconds value so they
      // interleave correctly with timed events. Events with no date at all sort last.
      sourced.sort(({ evt: a }, { evt: b }) => {
        const aTs = a.startTime ?? (a.startDate ? Date.parse(`${a.startDate}T00:00:00Z`) / 1000 : Number.POSITIVE_INFINITY);
        const bTs = b.startTime ?? (b.startDate ? Date.parse(`${b.startDate}T00:00:00Z`) / 1000 : Number.POSITIVE_INFINITY);
        return aTs - bTs;
      });

      // Filters run on every copy before collapsing (R82), so a match on either account's copy
      // of a meeting is never hidden behind the other copy's fields.
      let filtered = sourced;

      // Client-side filtering: query matches title or description (case-insensitive)
      if (query && typeof query === 'string') {
        const lowerQuery = query.toLowerCase();
        filtered = filtered.filter(
          ({ evt }) =>
            evt.title.toLowerCase().includes(lowerQuery) ||
            evt.description.toLowerCase().includes(lowerQuery),
        );
      }

      // Client-side filtering: attendee email
      if (attendeeEmail && typeof attendeeEmail === 'string') {
        const lowerEmail = attendeeEmail.toLowerCase();
        filtered = filtered.filter(
          ({ evt }) => evt.participants.some((p) => p.email.toLowerCase() === lowerEmail),
        );
      }

      // The same meeting on two of the principal's accounts' calendars is one entry (D7).
      const collapsed = await collapseAcrossMailboxes(ctx, filtered);
      const calendarsOf = collapsed.calendarsOf;
      let events = collapsed.events;

      // Truncate if maxResults is set
      if (typeof maxResults === 'number' && maxResults > 0) {
        events = events.slice(0, maxResults);
      }

      // Format events for LLM consumption.
      // toLocalIso converts Unix seconds to the user's local timezone so the LLM reads
      // correct wall-clock times. Falls back to UTC when timezone is not configured,
      // and returns null for null/invalid timestamp values.
      const tz = ctx.timezone;
      const formattedEvents = events.map((evt) => {
        const calendars = calendarsOf.get(evt);
        return calendars ? { ...localizeEventTimes(evt, tz), calendars } : localizeEventTimes(evt, tz);
      });

      ctx.log.info({ calendarCount: calendarIds.length, count: formattedEvents.length, failedCount: failedCalendarIds.length }, 'Listed events');
      const data: Record<string, unknown> = {
        events: formattedEvents,
        count: formattedEvents.length,
        displayTimezone: tz ? formatDisplayTimezone(tz, new Date()) : null,
      };
      // Surface partial failures so the LLM can inform the user
      if (failedCalendarIds.length > 0) {
        data.warnings = [`Failed to fetch events from ${failedCalendarIds.length} calendar(s): ${failureDetails.join('; ')}`];
      }
      return { success: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ ...grantSafeErrorFields(err), contactId }, 'Failed to list events');
      return { success: false, error: `Failed to list events: ${message}` };
    }
  }
}

/** An event with the mailbox and (routed) calendar it was read through. */
interface SourcedEvent {
  evt: NylasCalendarEvent;
  mailboxId: string;
  calendarId: string;
}

/** One calendar a collapsed meeting is on. `eventId` is that calendar's own id for it (ids are grant-scoped). */
export interface EventCalendarRef {
  calendarId: string;
  mailbox: string;
  mailbox_label: string | null;
  eventId: string;
}

/**
 * The same meeting on calendars of two of the principal's accounts (an invite to both, or one
 * calendar shared into the other) is listed once (#2475, D7). Copies collapse into the first,
 * which gains `calendars` naming each calendar it is on, only when all of these agree:
 *   - the iCal UID (non-empty; events without one are never merged);
 *   - the occurrence (a recurring series' instances share one UID);
 *   - start, end and title (R82: a UID is set by whoever sends the invite, so a spoofed UID must
 *     not let one event hide another that differs in what the principal would see).
 * Only copies read through different mailboxes merge (M1): a second copy from a mailbox already
 * in the group stays its own entry, whatever else is in the listing. A single-mailbox listing is
 * therefore unchanged.
 */
async function collapseAcrossMailboxes(
  ctx: ToolContext,
  sourced: SourcedEvent[],
): Promise<{ events: NylasCalendarEvent[]; calendarsOf: Map<NylasCalendarEvent, EventCalendarRef[]> }> {
  const calendarsOf = new Map<NylasCalendarEvent, EventCalendarRef[]>();
  if (new Set(sourced.map((s) => s.mailboxId)).size < 2) return { events: sourced.map((s) => s.evt), calendarsOf };

  let labels = new Map<string, string>();
  try {
    labels = new Map((await ctx.calendarRouter!.liveMailboxes()).map((m) => [m.id, m.label]));
  } catch (err) {
    // Labels are a courtesy; the ids are still listed.
    ctx.log.warn({ ...grantSafeErrorFields(err) }, 'calendar-list-events: could not read mailbox labels for collapsed events');
  }
  const ref = (s: SourcedEvent): EventCalendarRef => ({
    calendarId: s.calendarId,
    mailbox: s.mailboxId,
    mailbox_label: labels.get(s.mailboxId) ?? null,
    eventId: s.evt.id,
  });

  const firstByKey = new Map<string, { first: SourcedEvent; refs: EventCalendarRef[] }>();
  const events: NylasCalendarEvent[] = [];
  for (const s of sourced) {
    const e = s.evt;
    const key = sameMeetingKey(e);
    if (key === null) {
      events.push(e);
      continue;
    }
    const seen = firstByKey.get(key);
    if (seen && !seen.refs.some((r) => r.mailbox === s.mailboxId)) {
      seen.refs.push(ref(s));
      continue;
    }
    // A new meeting, or a second copy from a mailbox already in the group: its own entry.
    if (!seen) firstByKey.set(key, { first: s, refs: [ref(s)] });
    events.push(e);
  }
  let merged = 0;
  for (const { first, refs } of firstByKey.values()) {
    if (refs.length > 1) {
      // refs only ever hold distinct mailboxes, so more than one means two accounts.
      calendarsOf.set(first.evt, refs);
      merged++;
    }
  }
  if (merged > 0) ctx.log.debug({ merged }, 'calendar-list-events: collapsed meetings listed on more than one calendar');
  return { events, calendarsOf };
}

/**
 * One-line reason for a rejected per-calendar fetch, for inclusion in the skill
 * error. Errors are the normal case (NylasApiError extends Error); the other
 * branches keep a non-Error rejection from rendering as "[object Object]".
 */
export function describeRejection(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  if (reason && typeof reason === 'object') {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(reason);
}

/** Nylas SDK uses `statusCode` (not `status`) on NylasApiError. */
export function isNylasAuthFailure(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const code = (reason as { statusCode?: unknown }).statusCode;
  return code === 401 || code === 403;
}
