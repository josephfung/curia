// Calendar routing for the calendar tools (#2475, D7): each call goes through the mailbox the
// calendar belongs to, via ctx.calendarRouter. These helpers never throw; a calendar that cannot
// be routed becomes a tool error that says what to pass (e.g. which mailbox ids exist).
// Logs carry mailbox ids and error classes only, never grant ids, addresses or calendar IDs.

import type { ToolContext, ToolResult } from '../../src/skills/types.js';
import { classifyEvidence, type CountsOnlyEvidence, type EvidenceVerdict } from '../../src/principal-mailboxes/evidence.js';
import { CalendarRouteError, type RoutedCalendar } from '../../src/channels/calendar/calendar-router.js';
import type { NylasFreeBusyResult } from '../../src/channels/calendar/nylas-calendar-client.js';
import { MissingNylasApiKeyError } from '../../src/principal-mailboxes/types.js';
import { grantSafeErrorFields, mayCarryGrantId } from '../../src/principal-mailboxes/error-fields.js';
import type { PrincipalMailboxView } from '../../src/principal-mailboxes/service.js';
import { readMailboxInput } from './principal-mailbox-client.js';
import { EVIDENCE_TIMEOUT_MS, evidenceWithin, needsMailboxFailure } from '../../src/channels/calendar/needs-mailbox.js';

/** `fixable`: a CalendarRouteError (the caller can fix it by passing something else), not an outage. */
export type RouteOutcome = { ok: true; routed: RoutedCalendar } | { ok: false; error: string; fixable: boolean };

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
  if (!router) return { ok: false, error: 'Calendar not configured — Nylas credentials missing', fixable: false };
  try {
    return { ok: true, routed: await router.route(calendarId, mailbox) };
  } catch (err) {
    logRouteFailure(ctx, tool, err);
    return { ok: false, error: calendarRouteErrorMessage(err), fixable: err instanceof CalendarRouteError };
  }
}

/** The live mailboxes as `{id, label}` choices. */
export type MailboxChoice = { id: string; label: string };

export type WriteGate =
  /** Go ahead through `routed`. `multi`: more than one mailbox is live; `principal`: one of the principal's calendars (only known when multi). */
  | { kind: 'proceed'; routed: RoutedCalendar; multi: boolean; principal: boolean; live: PrincipalMailboxView[] }
  /** Several mailboxes are live and nothing says which one this write belongs to. */
  | { kind: 'needs_mailbox'; mailboxes: MailboxChoice[]; live: PrincipalMailboxView[] }
  /** `fixable`: the caller can fix it (a route error, a mismatch); otherwise an outage. */
  | { kind: 'error'; error: string; fixable: boolean };

/**
 * The code gate for writes on the principal's calendars (#2475, D5). With one live mailbox it
 * routes exactly as before. With several:
 *   - `requireMailbox` and no `mailbox` on one of the principal's calendars → needs_mailbox
 *     (event and hold creation: the account a meeting goes out from is a choice, never a default);
 *   - a stated `mailbox` must be the mailbox the calendar belongs to (calendar_mailbox_mismatch):
 *     a registered or owned calendar never silently writes through another account.
 * Never throws.
 */
export async function gateCalendarWrite(
  ctx: ToolContext,
  tool: string,
  calendarId: string,
  mailbox: string | undefined,
  opts: { requireMailbox: boolean; /** Replaces the default advice in the mismatch error. */ mismatchAdvice?: string },
): Promise<WriteGate> {
  const router = ctx.calendarRouter;
  if (!router) return { kind: 'error', error: 'Calendar not configured — Nylas credentials missing', fixable: false };
  let live: PrincipalMailboxView[];
  let principal = false;
  try {
    live = await router.liveMailboxes();
    // The principal check costs a registry read, so a single-mailbox install never makes it.
    if (live.length > 1) principal = await router.isPrincipalCalendar(calendarId, live);
  } catch (err) {
    logRouteFailure(ctx, tool, err);
    return { kind: 'error', error: calendarRouteErrorMessage(err), fixable: err instanceof CalendarRouteError };
  }
  const multi = live.length > 1;
  if (multi && principal && opts.requireMailbox && mailbox === undefined) {
    ctx.log.info({ tool, code: 'needs_mailbox', liveCount: live.length }, `${tool}: a write on the principal's calendar needs a mailbox`);
    return { kind: 'needs_mailbox', mailboxes: live.map(({ id, label }) => ({ id, label })), live };
  }
  const route = await routeCalendar(ctx, tool, calendarId, mailbox);
  if (!route.ok) return { kind: 'error', error: route.error, fixable: route.fixable };
  if (mailbox !== undefined && route.routed.mailboxId !== mailbox) {
    const owner = live.find((m) => m.id === route.routed.mailboxId);
    const named = live.find((m) => m.id === mailbox);
    ctx.log.warn({ tool, code: 'calendar_mailbox_mismatch', mailboxId: route.routed.mailboxId, requestedMailboxId: mailbox }, `${tool}: calendar belongs to another mailbox`);
    return {
      kind: 'error',
      fixable: true,
      error:
        `calendar_mailbox_mismatch: calendar "${calendarId}" belongs to mailbox "${route.routed.mailboxId}"${owner ? ` (${owner.label})` : ''}, ` +
        `not "${mailbox}"${named ? ` (${named.label})` : ''}. Nothing was changed. ` +
        (opts.mismatchAdvice ??
          `Use a calendar of mailbox "${mailbox}" (calendarId "primary" is its home calendar), or pass mailbox "${route.routed.mailboxId}".`),
    };
  }
  // A calendar the `mailbox` hint placed (neither its owning address nor a registry row did),
  // principal's or not: refused when another live account owns it, so a write never goes out as an
  // account the calendar is only shared into (SEC-L1, R105).
  if (route.routed.placedBy === 'hint') {
    let owner: PrincipalMailboxView | undefined;
    try {
      owner = await router.ownedElsewhere(calendarId, route.routed.mailboxId);
    } catch (err) {
      logRouteFailure(ctx, tool, err);
      return { kind: 'error', error: calendarRouteErrorMessage(err), fixable: err instanceof CalendarRouteError };
    }
    if (owner) {
      ctx.log.warn({ tool, code: 'calendar_mailbox_mismatch', mailboxId: owner.id, requestedMailboxId: mailbox }, `${tool}: calendar is owned by another mailbox`);
      return {
        kind: 'error',
        fixable: true,
        error:
          `calendar_mailbox_mismatch: calendar "${calendarId}" is owned by mailbox "${owner.id}" (${owner.label}), not "${mailbox}". ` +
          `Nothing was changed. Pass mailbox "${owner.id}".`,
      };
    }
  }
  return { kind: 'proceed', routed: route.routed, multi, principal, live };
}

export { evidenceRecipients, EVIDENCE_TIMEOUT_MS, summarizeEvidence } from '../../src/channels/calendar/needs-mailbox.js';

/**
 * Per-mailbox evidence for these attendees (D5), or null when it could not be computed. Never
 * throws: evidence informs the choice of account, it never blocks or fails a write.
 */
export async function attendeeEvidence(
  ctx: ToolContext,
  tool: string,
  recipients: string[],
  timeoutMs = EVIDENCE_TIMEOUT_MS,
): Promise<CountsOnlyEvidence[] | null> {
  const router = ctx.calendarRouter;
  if (!router) return null;
  return evidenceWithin(router, ctx.log, tool, recipients, timeoutMs);
}

/**
 * The needs_mailbox result for a write that created nothing: a failure (R102) naming the choices
 * and, when there are attendees, the evidence for each account (D5). A success would be recorded
 * as a sent invite and a booking.
 */
export async function needsMailboxResult(
  ctx: ToolContext,
  tool: string,
  mailboxes: MailboxChoice[],
  recipients: string[],
  what: 'created' | 'placed' = 'created',
): Promise<ToolResult> {
  const router = ctx.calendarRouter;
  if (!router) return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
  return needsMailboxFailure(router, ctx.log, tool, mailboxes, recipients, what);
}

/** How the evidence bears on the chosen mailbox, for a write's result (D5). Only with several mailboxes and attendees. */
export async function evidenceVerdict(
  ctx: ToolContext,
  tool: string,
  chosen: string,
  recipients: string[],
): Promise<{ evidence: EvidenceVerdict } | { evidence_unavailable: true }> {
  const evidence = await attendeeEvidence(ctx, tool, recipients);
  return evidence ? { evidence: classifyEvidence(evidence, chosen) } : { evidence_unavailable: true };
}

/**
 * The home calendars to search for holds to release, besides the one a write went to: every
 * live mailbox's, once several are live (D7: release searches all the principal's calendars).
 * With one mailbox it is just `routed`, as before. A home calendar that cannot be resolved is a
 * warning, never a failed write.
 */
export async function holdReleaseTargets(
  ctx: ToolContext,
  tool: string,
  routed: RoutedCalendar,
  searchHomes: boolean,
): Promise<{ targets: RoutedCalendar[]; warnings: string[] }> {
  const targets: RoutedCalendar[] = [routed];
  const router = ctx.calendarRouter;
  if (!searchHomes || !router) return { targets, warnings: [] };
  const homes = await settledHomeCalendars(ctx, tool);
  for (const home of homes.found) {
    const seen = targets.some((t) => t.mailboxId === home.mailboxId && t.calendarId.toLowerCase() === home.calendarId.toLowerCase());
    if (!seen) targets.push(home);
  }
  // One broken account costs only its own home calendar (R84), and says so.
  const warnings = homes.failures.map((f) =>
    f.mailboxId === null
      ? `Holds were looked for only on this calendar: the mailboxes could not be listed (${f.message}).`
      : `Holds on the "${f.label}" mailbox's home calendar were not checked: ${f.message}`,
  );
  return { targets, warnings };
}

/**
 * Every live mailbox's home calendar for best-effort cleanup, one mailbox at a time (R84): a
 * mailbox whose home calendar cannot be found is a failure (grant-safe message), the others are
 * found. `mailboxId: null` means the mailbox list itself could not be read. Never throws.
 */
export async function settledHomeCalendars(
  ctx: ToolContext,
  tool: string,
): Promise<{ found: RoutedCalendar[]; failures: Array<{ mailboxId: string | null; label: string; message: string }> }> {
  const router = ctx.calendarRouter;
  if (!router) return { found: [], failures: [] };
  try {
    const settled = await router.liveHomeCalendarsSettled();
    return {
      found: settled.found.map(({ mailboxId, calendarId, client }) => ({ mailboxId, calendarId, client })),
      failures: settled.failures.map((f) => ({ mailboxId: f.mailboxId, label: f.label, message: calendarRouteErrorMessage(f.error) })),
    };
  } catch (err) {
    logRouteFailure(ctx, tool, err);
    return { found: [], failures: [{ mailboxId: null, label: '', message: calendarRouteErrorMessage(err) }] };
  }
}

/** One free/busy answer with the calendar ID the caller asked about. */
export interface QueriedFreeBusy {
  queriedId: string;
  result: NylasFreeBusyResult;
}

/**
 * Free/busy across calendars that may belong to different mailboxes: one getFreeBusy per
 * mailbox, through that mailbox's client, with the routed IDs (so `primary` goes out as the
 * real home ID). Each answer is matched to the calendar it is for by its email (SF-M3), never by
 * position alone: an answer Nylas gave in another order must not lend one calendar's slots or
 * ignored holds to another. An answer whose email matches no unanswered calendar takes the next
 * unanswered one in order (an alias Nylas rewrote), else stands under its own email. A calendar
 * with no answer at all is `unanswered`: the caller reports it unread, never free. A Nylas error
 * propagates (throws) as getFreeBusy's did; only routing is turned into a result.
 */
export async function freeBusyAcross(
  routed: RoutedCalendar[],
  inputIds: string[],
  timeMin: string,
  timeMax: string,
): Promise<{ answers: QueriedFreeBusy[]; unanswered: string[] }> {
  const groups = new Map<string, { client: RoutedCalendar['client']; sendIds: string[]; inputIds: string[] }>();
  routed.forEach((r, i) => {
    const g = groups.get(r.mailboxId) ?? { client: r.client, sendIds: [], inputIds: [] };
    g.sendIds.push(r.calendarId);
    g.inputIds.push(inputIds[i]!);
    groups.set(r.mailboxId, g);
  });
  const perGroup = await Promise.all(
    [...groups.values()].map(async (g) => {
      const results = await g.client.getFreeBusy(g.sendIds, timeMin, timeMax);
      const answered = new Array<boolean>(g.sendIds.length).fill(false);
      const norm = (s: string): string => s.trim().toLowerCase();
      const answers: QueriedFreeBusy[] = [];
      const strays: NylasFreeBusyResult[] = [];
      for (const result of results) {
        const i = g.sendIds.findIndex((id, k) => !answered[k] && norm(id) === norm(result.email));
        if (i < 0) {
          strays.push(result);
          continue;
        }
        answered[i] = true;
        answers.push({ queriedId: g.inputIds[i]!, result });
      }
      for (const result of strays) {
        const i = answered.indexOf(false);
        if (i >= 0) answered[i] = true;
        answers.push({ queriedId: i >= 0 ? g.inputIds[i]! : result.email, result });
      }
      const unanswered = g.inputIds.filter((_, k) => !answered[k]);
      return { answers, unanswered };
    }),
  );
  return { answers: perGroup.flatMap((p) => p.answers), unanswered: perGroup.flatMap((p) => p.unanswered) };
}
