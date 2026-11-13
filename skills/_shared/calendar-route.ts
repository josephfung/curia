// Calendar routing for the calendar tools (#2475, D7): each call goes through the mailbox the
// calendar belongs to, via ctx.calendarRouter. These helpers never throw; a calendar that cannot
// be routed becomes a tool error that says what to pass (e.g. which mailbox ids exist).
// Logs carry mailbox ids and error classes only, never grant ids, addresses or calendar IDs.

import type { ToolContext } from '../../src/skills/types.js';
import { CalendarRouteError, type RoutedCalendar } from '../../src/channels/calendar/calendar-router.js';
import type { NylasFreeBusyResult } from '../../src/channels/calendar/nylas-calendar-client.js';
import { MissingNylasApiKeyError } from '../../src/principal-mailboxes/types.js';
import { grantSafeErrorFields, mayCarryGrantId } from '../../src/principal-mailboxes/error-fields.js';
import { readMailboxInput } from './principal-mailbox-client.js';

export type RouteOutcome = { ok: true; routed: RoutedCalendar } | { ok: false; error: string };

/** The tool's optional `mailbox` input: undefined when omitted, an error for a non-string. */
export function readCalendarMailbox(input: unknown): { ok: true; mailbox: string | undefined } | { ok: false; error: string } {
  return readMailboxInput(input);
}

/**
 * The model-facing message for a routing failure. A CalendarRouteError and a missing API key say
 * what is wrong; anything else (a vault read, a Nylas error that may echo a grant) is named by
 * class only.
 */
export function calendarRouteErrorMessage(err: unknown): string {
  if (err instanceof CalendarRouteError || err instanceof MissingNylasApiKeyError) return err.message;
  // A database or vault error's text is what the operator needs and holds no grant (R20).
  if (err instanceof Error && !mayCarryGrantId(err)) return `Could not resolve the calendar's mailbox: ${err.message}`;
  const { errName } = grantSafeErrorFields(err);
  return `Could not reach the calendar's mailbox (${errName})`;
}

/** Log a routing failure: the code for a CalendarRouteError, the class and status otherwise. */
function logRouteFailure(ctx: ToolContext, tool: string, err: unknown): void {
  if (err instanceof CalendarRouteError) {
    ctx.log.warn({ tool, code: err.code }, `${tool}: calendar could not be routed`);
  } else {
    const safe = err instanceof Error && !mayCarryGrantId(err) ? { errMessage: err.message } : {};
    ctx.log.error({ tool, ...grantSafeErrorFields(err), ...safe }, `${tool}: calendar routing failed`);
  }
}

/** Route one calendar through ctx.calendarRouter. Never throws. */
export async function routeCalendar(ctx: ToolContext, tool: string, calendarId: string, mailbox?: string): Promise<RouteOutcome> {
  const router = ctx.calendarRouter;
  if (!router) return { ok: false, error: 'Calendar not configured — Nylas credentials missing' };
  try {
    return { ok: true, routed: await router.route(calendarId, mailbox) };
  } catch (err) {
    logRouteFailure(ctx, tool, err);
    return { ok: false, error: calendarRouteErrorMessage(err) };
  }
}

/** Route several calendars; the first failure is returned. Never throws. */
export async function routeCalendars(
  ctx: ToolContext,
  tool: string,
  calendarIds: string[],
  mailbox?: string,
): Promise<{ ok: true; routed: RoutedCalendar[] } | { ok: false; error: string }> {
  const routed: RoutedCalendar[] = [];
  for (const id of calendarIds) {
    const r = await routeCalendar(ctx, tool, id, mailbox);
    if (!r.ok) return r;
    routed.push(r.routed);
  }
  return { ok: true, routed };
}

/** One free/busy answer with the calendar ID the caller asked about. */
export interface QueriedFreeBusy {
  queriedId: string;
  result: NylasFreeBusyResult;
}

/**
 * Free/busy across calendars that may belong to different mailboxes: one getFreeBusy per
 * mailbox, through that mailbox's client, with the routed IDs (so `primary` goes out as the
 * real home ID). `queriedId` is the input ID at the same position within its mailbox's batch,
 * or the answer's email when Nylas returns more entries than were asked for. A Nylas error
 * propagates (throws) as getFreeBusy's did; only routing is turned into a result.
 */
export async function freeBusyAcross(
  routed: RoutedCalendar[],
  inputIds: string[],
  timeMin: string,
  timeMax: string,
): Promise<QueriedFreeBusy[]> {
  const groups = new Map<string, { client: RoutedCalendar['client']; sendIds: string[]; inputIds: string[] }>();
  routed.forEach((r, i) => {
    const g = groups.get(r.mailboxId) ?? { client: r.client, sendIds: [], inputIds: [] };
    g.sendIds.push(r.calendarId);
    g.inputIds.push(inputIds[i]!);
    groups.set(r.mailboxId, g);
  });
  const answers = await Promise.all(
    [...groups.values()].map(async (g) => {
      const results = await g.client.getFreeBusy(g.sendIds, timeMin, timeMax);
      return results.map((result, i) => ({ queriedId: g.inputIds[i] ?? result.email, result }));
    }),
  );
  return answers.flat();
}
