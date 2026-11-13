// Availability across every calendar of the principal (#2475, D7), for calendar-find-free-time
// and calendar-check-conflicts.
//
// - Whenever one of the principal's calendars is in the request, every live mailbox's home
//   calendar is read, plus any other principal calendar the caller named. Each is read as events
//   (title, calendar, time) so the agent can see what blocks and judge it against the principal's
//   calendaring preferences; `treatAsFree` event ids then stop blocking.
// - Code never leaves a calendar out silently: a mailbox that cannot be read is `partial` (named),
//   a removed mailbox's calendar is `removed`.
// - The event listing is checked against the same calendar's free/busy: a busy time no listed
//   event explains (a recurring occurrence the listing missed, a truncated listing) still blocks,
//   untitled. When the listing may be incomplete, treated and ignored events do not explain
//   free/busy either. A gap in the listing can never turn into a false "free".
// - Other people's calendars are read with free/busy, as before. With several mailboxes a
//   calendar no registry row places is read through the mailbox the evidence points to (domain,
//   then history), else the default, and the result says which (`readVia`; R93). The choice runs
//   in parallel under one deadline per call; a failed chosen mailbox falls back to the default.
//
// Logs carry mailbox ids and error classes only, never grant ids, addresses or calendar ids.

import { DateTime } from 'luxon';
import type { ToolContext } from '../../src/skills/types.js';
import { CalendarRouteError, PRIMARY_CALENDAR_ALIAS, type RoutedCalendar } from '../../src/channels/calendar/calendar-router.js';
import { LIST_EVENTS_MAX_TOTAL, type NylasCalendarEvent } from '../../src/channels/calendar/nylas-calendar-client.js';
import { sameMeetingKey } from '../../src/channels/calendar/event-identity.js';
import { eventsOverlap, findMatchingHolds, type HoldMatchCriteria } from '../../src/channels/calendar/holds.js';
import { domainMatches, leadingMailbox } from '../../src/principal-mailboxes/evidence.js';
import { grantSafeErrorFields } from '../../src/principal-mailboxes/error-fields.js';
import type { PrincipalMailboxView } from '../../src/principal-mailboxes/service.js';
import { isPlausibleUnixSeconds, repairQueriedUnixRange, toLocalIso } from '../../src/time/timestamp.js';
import { attendeeEvidence, calendarRouteErrorMessage, freeBusyAcross, type QueriedFreeBusy } from './calendar-route.js';

/** How long choosing a mailbox for someone else's free/busy waits for mail evidence. */
const FREEBUSY_EVIDENCE_TIMEOUT_MS = 3_000;

/** One busy period. `eventId`/`title` are null for free/busy without an event behind it. */
export interface BusyBlock {
  start: number;
  end: number;
  eventId: string | null;
  title: string | null;
  /** The calendar it was read from (the routed id; for other people, the id free/busy echoed). */
  calendarId: string;
  /** "Work", "Personal", "Work, Personal" for one meeting on both; another person's name or calendar id. */
  calendarLabel: string;
  status: string;
  /** True for the principal's calendars. */
  principal: boolean;
  /** sameMeetingKey of the event, for collapsing one meeting seen on two accounts. */
  meetingKey: string | null;
  mailboxId: string;
}

export interface AvailabilityRead {
  /** True when the principal's calendars were read (and events listed). */
  principalRead: boolean;
  /** At least one calendar was read. */
  anyRead: boolean;
  blocking: BusyBlock[];
  treatedAsFree: BusyBlock[];
  /** treatAsFree ids that matched no event in the window. */
  treatAsFreeUnmatched: string[];
  partial: Array<{ mailbox_label: string; error: string }>;
  removed: string[];
  readVia: Array<{
    calendarId: string;
    mailbox: string;
    mailbox_label: string;
    chosen_by: 'domain' | 'history' | 'default';
    /** Set when the chosen mailbox's free/busy failed and the default answered instead (M6). */
    fell_back_from?: string;
  }>;
}

export interface AvailabilityRequest {
  calendarIds: string[];
  mailbox?: string;
  timeMin: string;
  timeMax: string;
  treatAsFree?: string[];
  /** Curia HOLD (TBC) events of this scheduling conversation do not block (check-conflicts). */
  ignoreHolds?: HoldMatchCriteria;
}

const lower = (s: string): string => s.trim().toLowerCase();

/** The message for a calendar that could not be read: the upstream reason, as tool errors keep it (R78). */
function readFailureMessage(err: unknown): string {
  if (err instanceof CalendarRouteError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read availability for the request. Returns an error result for a routing problem the caller
 * can fix (an unknown mailbox, a calendar of someone else that cannot be routed). A free/busy
 * error on another person's calendar throws, as getFreeBusy always has; the tools catch it.
 */
export async function readAvailability(
  ctx: ToolContext,
  tool: string,
  req: AvailabilityRequest,
): Promise<{ ok: true; read: AvailabilityRead } | { ok: false; error: string }> {
  const router = ctx.calendarRouter;
  if (!router) return { ok: false, error: 'Calendar not configured — Nylas credentials missing' };
  const rangeStart = Math.floor(new Date(req.timeMin).getTime() / 1000);
  const rangeEnd = Math.floor(new Date(req.timeMax).getTime() / 1000);

  let live: PrincipalMailboxView[];
  const principalIds: string[] = [];
  const otherIds: string[] = [];
  try {
    // A stated mailbox is validated even when nothing ends up routed through it.
    if (req.mailbox !== undefined) await router.mailbox(req.mailbox);
    live = await router.liveMailboxes();
    for (const id of req.calendarIds) (await router.isPrincipalCalendar(id) ? principalIds : otherIds).push(id);
  } catch (err) {
    ctx.log.warn({ tool, ...(err instanceof CalendarRouteError ? { code: err.code } : grantSafeErrorFields(err)) }, `${tool}: could not resolve the calendars to read`);
    return { ok: false, error: calendarRouteErrorMessage(err) };
  }

  const read: AvailabilityRead = {
    principalRead: false,
    anyRead: false,
    blocking: [],
    treatedAsFree: [],
    treatAsFreeUnmatched: [],
    partial: [],
    removed: [],
    readVia: [],
  };
  const addRemoved = (label: string): void => {
    if (!read.removed.includes(label)) read.removed.push(label);
  };
  const addPartial = (label: string, error: string): void => {
    if (!read.partial.some((p) => p.mailbox_label === label)) read.partial.push({ mailbox_label: label, error });
  };

  if (principalIds.length > 0) {
    read.principalRead = true;
    const outcome = await readPrincipalCalendars(ctx, tool, req, principalIds, live, rangeStart, rangeEnd, addRemoved, addPartial);
    if (!outcome.ok) return outcome;
    read.anyRead = outcome.anyRead;
    read.blocking.push(...outcome.blocking);
    read.treatedAsFree.push(...outcome.treated);
    read.treatAsFreeUnmatched = outcome.unmatched;
  }

  if (otherIds.length > 0) {
    // Routed in parallel under one deadline for the whole call (I3): a slow mail search for one
    // address cannot add up across several, and a late answer is ignored (the default is used).
    const deadline = Date.now() + FREEBUSY_EVIDENCE_TIMEOUT_MS;
    const outcomes = await Promise.all(otherIds.map((id) => routeOther(ctx, tool, id, req.mailbox, live, deadline)));
    const routed: RoutedCalendar[] = [];
    const vias: Array<AvailabilityRead['readVia'][number] | undefined> = [];
    for (const r of outcomes) {
      if (!r.ok) return r;
      routed.push(r.routed);
      vias.push(r.via);
    }
    const answers = await freeBusyWithFallback(ctx, tool, routed, vias, otherIds, live, req, addPartial);
    read.readVia.push(...vias.filter((v): v is AvailabilityRead['readVia'][number] => v !== undefined));
    read.anyRead = read.anyRead || answers.length > 0;
    const ignored = req.ignoreHolds ? await holdWindowsOnOthers(ctx, tool, otherIds, routed, req, rangeStart, rangeEnd) : new Map<string, Array<{ start: number; end: number }>>();
    const names = new Map<string, string | null>();
    for (const { queriedId, result } of answers) {
      if (!names.has(result.email)) names.set(result.email, await contactNameFor(ctx, result.email));
      const label = names.get(result.email) ?? queriedId;
      const holds = ignored.get(result.email) ?? ignored.get(queriedId) ?? [];
      const mailboxId = routed[otherIds.indexOf(queriedId)]?.mailboxId ?? '';
      for (const slot of result.timeSlots) {
        // Free/busy blocks unless explicitly `free` (#1137): tentative holds still block.
        if (slot.status === 'free') continue;
        const repaired = repairSlot(ctx, tool, slot.startTime, slot.endTime, rangeStart, rangeEnd);
        if (!repaired) continue;
        if (holds.some((h) => eventsOverlap(repaired.start, repaired.end, h.start, h.end))) continue;
        read.blocking.push({
          ...repaired,
          eventId: null,
          title: null,
          calendarId: result.email,
          calendarLabel: label,
          status: slot.status,
          principal: false,
          meetingKey: null,
          mailboxId,
        });
      }
    }
  }

  read.blocking.sort((a, b) => a.start - b.start);
  read.treatedAsFree.sort((a, b) => a.start - b.start);
  return { ok: true, read };
}

/** One of the principal's calendars to read, with the label it is shown under. */
interface PrincipalTarget {
  routed: RoutedCalendar;
  label: string;
}

async function readPrincipalCalendars(
  ctx: ToolContext,
  tool: string,
  req: AvailabilityRequest,
  principalIds: string[],
  live: PrincipalMailboxView[],
  rangeStart: number,
  rangeEnd: number,
  addRemoved: (label: string) => void,
  addPartial: (label: string, error: string) => void,
): Promise<
  | { ok: true; anyRead: boolean; blocking: BusyBlock[]; treated: BusyBlock[]; unmatched: string[] }
  | { ok: false; error: string }
> {
  const router = ctx.calendarRouter!;
  let homes: Awaited<ReturnType<typeof router.homeCalendars>>;
  try {
    homes = await router.homeCalendars();
  } catch (err) {
    ctx.log.error({ tool, ...grantSafeErrorFields(err) }, `${tool}: could not list the principal's home calendars`);
    return { ok: false, error: calendarRouteErrorMessage(err) };
  }
  const labelOf = new Map(live.map((m) => [m.id, m.label]));
  const targets: PrincipalTarget[] = homes.found.map((h) => ({ routed: h, label: h.label }));
  for (const f of homes.failures) {
    ctx.log.warn({ tool, mailboxId: f.mailboxId, code: f.code }, `${tool}: a mailbox's home calendar could not be found; availability is partial`);
    addPartial(f.label, readFailureMessage(f.error));
  }
  for (const r of homes.removed) addRemoved(r.label);

  const sameCalendar = (a: RoutedCalendar, b: RoutedCalendar): boolean =>
    a.mailboxId === b.mailboxId && lower(a.calendarId) === lower(b.calendarId);

  // Principal calendars the caller named beyond the home calendars (a family calendar, say).
  for (const id of principalIds) {
    // `primary` stands for the home calendars, which are all read.
    if (id === PRIMARY_CALENDAR_ALIAS) continue;
    if (targets.some((t) => lower(t.routed.calendarId) === lower(id))) continue;
    if (homes.removed.some((r) => lower(r.calendarId) === lower(id))) continue;
    let routed: RoutedCalendar;
    try {
      routed = await router.route(id, req.mailbox);
    } catch (err) {
      if (err instanceof CalendarRouteError && err.code === 'mailbox_removed' && err.removedMailbox) {
        addRemoved(err.removedMailbox.label);
        continue;
      }
      ctx.log.warn({ tool, ...(err instanceof CalendarRouteError ? { code: err.code } : grantSafeErrorFields(err)) }, `${tool}: a principal calendar could not be routed; availability is partial`);
      const row = await calendarRow(ctx, tool, id);
      addPartial((row?.principalMailboxId ? labelOf.get(row.principalMailboxId) : undefined) ?? id, calendarRouteErrorMessage(err));
      continue;
    }
    if (targets.some((t) => sameCalendar(t.routed, routed))) continue;
    const mailboxLabel = labelOf.get(routed.mailboxId) ?? routed.mailboxId;
    const name = (await calendarRow(ctx, tool, id))?.label;
    targets.push({ routed, label: name && name !== id ? `${mailboxLabel}: ${name}` : mailboxLabel });
  }

  const principalAddresses = new Set(live.map((m) => lower(m.address)).filter((a) => a !== ''));
  const reads = await Promise.all(
    targets.map(async (t) => {
      try {
        const [events, freeBusy] = await Promise.all([
          t.routed.client.listEvents(t.routed.calendarId, req.timeMin, req.timeMax, { limit: LIST_EVENTS_MAX_TOTAL, expandRecurring: true }),
          t.routed.client.getFreeBusy([t.routed.calendarId], req.timeMin, req.timeMax),
        ]);
        if (events.length >= LIST_EVENTS_MAX_TOTAL) {
          // Free/busy still covers what the listing cut off (untitled), so nothing reads as free.
          ctx.log.warn({ tool, mailboxId: t.routed.mailboxId, count: events.length }, `${tool}: event listing hit its cap; busy times beyond it come from free/busy`);
        }
        return { t, ok: true as const, events, freeBusy };
      } catch (err) {
        ctx.log.warn({ tool, mailboxId: t.routed.mailboxId, ...grantSafeErrorFields(err) }, `${tool}: a principal calendar could not be read; availability is partial`);
        return { t, ok: false as const, error: readFailureMessage(err) };
      }
    }),
  );

  // treat_as_free names one copy's event id; the same meeting's copy on the other account's
  // calendar (same UID, time and title) is treated the same way.
  const treatIds = new Set(req.treatAsFree ?? []);
  const matchedIds = new Set<string>();
  const treatKeys = new Set<string>();
  for (const r of reads) {
    if (!r.ok) continue;
    for (const e of r.events) {
      if (!treatIds.has(e.id)) continue;
      matchedIds.add(e.id);
      const key = sameMeetingKey(e);
      if (key) treatKeys.add(key);
    }
  }

  const tz = ctx.timezone;
  const blocking: BusyBlock[] = [];
  const treated: BusyBlock[] = [];
  let anyRead = false;
  for (const r of reads) {
    if (!r.ok) {
      addPartial(r.t.label, r.error);
      continue;
    }
    anyRead = true;
    const { routed, label } = r.t;
    const holdIds = req.ignoreHolds
      ? new Set(findMatchingHolds(r.events, { ...req.ignoreHolds, startTime: rangeStart, endTime: rangeEnd }).map((m) => m.hold.id))
      : new Set<string>();
    // A listing that may be incomplete (it hit its cap, or a recurring series came back as its
    // master instead of its occurrences) can miss a busy time that free/busy merged with a
    // treated or ignored event. Then only events that still block may explain free/busy, so a
    // busy time is never returned free (I1); treat_as_free and ignored holds only stop blocking
    // what free/busy can be matched against when the listing is complete.
    const complete = listingComplete(r.events);
    if (!complete) {
      ctx.log.warn({ tool, mailboxId: routed.mailboxId, count: r.events.length }, `${tool}: event listing may be incomplete; treated and ignored events do not free their time`);
    }
    const explained: Array<{ start: number; end: number }> = [];
    for (const e of r.events) {
      if (!blocksTime(e, principalAddresses)) continue;
      const iv = eventInterval(e, tz, rangeStart, rangeEnd);
      if (!iv) continue;
      const key = sameMeetingKey(e);
      const isTreated = treatIds.has(e.id) || (key !== null && treatKeys.has(key));
      const isIgnoredHold = holdIds.has(e.id);
      if (complete || (!isTreated && !isIgnoredHold)) explained.push(iv);
      if (isIgnoredHold) continue;
      const block: BusyBlock = {
        ...iv,
        eventId: e.id,
        title: e.title,
        calendarId: routed.calendarId,
        calendarLabel: label,
        status: e.status === 'tentative' ? 'tentative' : 'busy',
        principal: true,
        meetingKey: key,
        mailboxId: routed.mailboxId,
      };
      if (isTreated) treated.push(block);
      else blocking.push(block);
    }
    for (const fb of r.freeBusy) {
      for (const slot of fb.timeSlots) {
        if (slot.status === 'free') continue;
        const repaired = repairSlot(ctx, tool, slot.startTime, slot.endTime, rangeStart, rangeEnd);
        if (!repaired) continue;
        for (const piece of subtract(repaired, explained)) {
          blocking.push({
            ...piece,
            eventId: null,
            title: null,
            calendarId: routed.calendarId,
            calendarLabel: label,
            status: slot.status,
            principal: true,
            meetingKey: null,
            mailboxId: routed.mailboxId,
          });
        }
      }
    }
  }

  return {
    ok: true,
    anyRead,
    blocking: collapseSameMeeting(blocking),
    treated: collapseSameMeeting(treated),
    unmatched: [...treatIds].filter((id) => !matchedIds.has(id)),
  };
}

/**
 * False when the listing may have left events out: it reached the cap, or it holds a recurring
 * series' master event (Nylas did not expand the occurrences), whose own times are not the
 * occurrences in the window.
 */
function listingComplete(events: NylasCalendarEvent[]): boolean {
  if (events.length >= LIST_EVENTS_MAX_TOTAL) return false;
  return !events.some((e) => (e.recurrence?.length ?? 0) > 0 && e.originalStartTime === undefined);
}

/**
 * Whether a listed event takes the principal's time: not cancelled, not "Show as: Free", not
 * declined by the principal (free/busy leaves those out too).
 */
function blocksTime(e: NylasCalendarEvent, principalAddresses: Set<string>): boolean {
  if (e.status === 'cancelled' || e.busy === false) return false;
  return !e.participants.some((p) => principalAddresses.has(lower(p.email)) && p.status === 'no');
}

/** An event's time in unix seconds, or null when it misses the window. All-day events run midnight to midnight in tz. */
function eventInterval(e: NylasCalendarEvent, tz: string | undefined, rangeStart: number, rangeEnd: number): { start: number; end: number } | null {
  let start: number;
  let end: number;
  if (e.startTime !== null && e.endTime !== null) {
    const r = repairQueriedUnixRange(e.startTime, e.endTime, rangeStart, rangeEnd);
    if (!r) return null;
    ({ start, end } = r);
  } else if (e.startDate) {
    const zone = tz ?? 'UTC';
    const s = DateTime.fromISO(e.startDate, { zone });
    if (!s.isValid) return null;
    let en = e.endDate ? DateTime.fromISO(e.endDate, { zone }) : s.plus({ days: 1 });
    if (!en.isValid || en <= s) en = s.plus({ days: 1 });
    start = Math.floor(s.toSeconds());
    end = Math.floor(en.toSeconds());
  } else {
    return null;
  }
  // Kept whole (a conflict shows the event's real times); dropped when it misses the window.
  return end > rangeStart && start < rangeEnd && end > start ? { start, end } : null;
}

/** A free/busy slot repaired against the window (#370), or null when unusable or outside it. */
function repairSlot(ctx: ToolContext, tool: string, startTime: number, endTime: number, rangeStart: number, rangeEnd: number): { start: number; end: number } | null {
  const repaired = repairQueriedUnixRange(startTime, endTime, rangeStart, rangeEnd);
  if (!repaired) {
    ctx.log.warn({ startTime, endTime }, `${tool}: skipping free/busy slot with suspicious Unix timestamp`);
    return null;
  }
  if (!isPlausibleUnixSeconds(startTime) || !isPlausibleUnixSeconds(endTime)) {
    ctx.log.warn({ startTime, endTime, repairedStart: repaired.start, repairedEnd: repaired.end }, `${tool}: clamping free/busy slot with suspicious Unix timestamp to query window`);
  }
  return repaired.end > rangeStart && repaired.start < rangeEnd ? repaired : null;
}

/** The parts of `slot` no interval in `cover` overlaps. */
function subtract(slot: { start: number; end: number }, cover: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...cover].sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  let cursor = slot.start;
  for (const c of sorted) {
    if (c.end <= cursor || c.start >= slot.end) continue;
    if (c.start > cursor) out.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
    if (cursor >= slot.end) break;
  }
  if (cursor < slot.end) out.push({ start: cursor, end: slot.end });
  return out;
}

/** One meeting on several calendars is one entry, labelled with each calendar (D7, R82 key). */
function collapseSameMeeting(blocks: BusyBlock[]): BusyBlock[] {
  const out: BusyBlock[] = [];
  const byKey = new Map<string, { block: BusyBlock }>();
  for (const b of blocks) {
    if (b.meetingKey === null) {
      out.push(b);
      continue;
    }
    const seen = byKey.get(b.meetingKey);
    if (seen) {
      // Same meeting (UID, occurrence, start, end, title): one entry, whichever calendars and
      // accounts it is on, including two calendars of one account (M5).
      if (!seen.block.calendarLabel.split(', ').includes(b.calendarLabel)) seen.block.calendarLabel += `, ${b.calendarLabel}`;
      continue;
    }
    const copy = { ...b };
    byKey.set(b.meetingKey, { block: copy });
    out.push(copy);
  }
  return out;
}

/** A calendar's registry row, or null. Best-effort (it only labels): a lookup error is logged. */
async function calendarRow(ctx: ToolContext, tool: string, calendarId: string): Promise<{ label: string; principalMailboxId?: string | null } | null> {
  if (!ctx.contactService) return null;
  try {
    return await ctx.contactService.resolveCalendar(calendarId);
  } catch (err) {
    ctx.log.warn({ tool, ...grantSafeErrorFields(err) }, `${tool}: could not read a calendar's registry row; labelling it by mailbox`);
    return null;
  }
}

/** The registered contact's name for a calendar, or null. Best-effort: a lookup error is logged. */
export async function contactNameFor(ctx: ToolContext, calendarId: string): Promise<string | null> {
  if (!ctx.contactService) return null;
  try {
    const row = await ctx.contactService.resolveCalendar(calendarId);
    if (!row?.contactId) return null;
    return (await ctx.contactService.getContact(row.contactId))?.displayName ?? null;
  } catch (err) {
    ctx.log.warn({ ...grantSafeErrorFields(err) }, 'calendar availability: could not resolve a calendar owner; showing the calendar id');
    return null;
  }
}

/**
 * Route another person's calendar. With several mailboxes and no stated `mailbox`, a calendar no
 * registry row places is read through the mailbox the evidence points to (#2475, D5/D7): a mailbox
 * on the same (non-consumer) domain, else the one with a history with that address (counts and
 * domain only, R81), else the default. The model is not asked to pick a mailbox to read someone
 * else's free/busy; the result names the one used.
 */
async function routeOther(
  ctx: ToolContext,
  tool: string,
  id: string,
  mailbox: string | undefined,
  live: PrincipalMailboxView[],
  deadline: number,
): Promise<
  | { ok: true; routed: RoutedCalendar; via?: AvailabilityRead['readVia'][number] }
  | { ok: false; error: string }
> {
  const router = ctx.calendarRouter!;
  try {
    return { ok: true, routed: await router.route(id, mailbox) };
  } catch (err) {
    if (!(err instanceof CalendarRouteError && err.code === 'needs_mailbox' && mailbox === undefined && live.length > 1)) {
      ctx.log.warn({ tool, ...(err instanceof CalendarRouteError ? { code: err.code } : grantSafeErrorFields(err)) }, `${tool}: calendar could not be routed`);
      return { ok: false, error: calendarRouteErrorMessage(err) };
    }
  }
  const choice = await chooseFreeBusyMailbox(ctx, tool, id, live, deadline);
  try {
    const routed = await router.route(id, choice.mailbox.id);
    ctx.log.info({ tool, mailboxId: choice.mailbox.id, chosenBy: choice.by }, `${tool}: free/busy for an unregistered calendar read through a chosen mailbox`);
    return { ok: true, routed, via: { calendarId: id, mailbox: choice.mailbox.id, mailbox_label: choice.mailbox.label, chosen_by: choice.by } };
  } catch (err) {
    ctx.log.warn({ tool, ...(err instanceof CalendarRouteError ? { code: err.code } : grantSafeErrorFields(err)) }, `${tool}: calendar could not be routed`);
    return { ok: false, error: calendarRouteErrorMessage(err) };
  }
}

async function chooseFreeBusyMailbox(
  ctx: ToolContext,
  tool: string,
  id: string,
  live: PrincipalMailboxView[],
  deadline: number,
): Promise<{ mailbox: PrincipalMailboxView; by: 'domain' | 'history' | 'default' }> {
  const address = lower(id);
  // A Google group or resource calendar id is not a person's address: no mail history to read.
  if (address.includes('@') && !address.endsWith('calendar.google.com')) {
    const byDomain = live.filter((m) => domainMatches(m.address, [address]));
    if (byDomain.length === 1) return { mailbox: byDomain[0]!, by: 'domain' };
    // What is left of the call's shared deadline; past it, the evidence call gives up at once.
    const evidence = await attendeeEvidence(ctx, tool, [address], Math.max(0, deadline - Date.now()));
    const lead = evidence ? leadingMailbox(evidence) : null;
    const m = lead !== null ? live.find((x) => x.id === lead) : undefined;
    if (m) return { mailbox: m, by: 'history' };
  }
  return { mailbox: defaultMailbox(live), by: 'default' };
}

function defaultMailbox(live: PrincipalMailboxView[]): PrincipalMailboxView {
  return live.find((m) => m.isDefault) ?? live[0]!;
}

/**
 * Free/busy for other people's calendars, one call per mailbox (freeBusyAcross). When a mailbox's
 * call fails and every calendar in it was routed there by the automatic choice, those calendars
 * are read once more through the default mailbox (M6, R93); if that fails too, or the default was
 * the one that failed, they are `partial`. A failure on a calendar the registry or the caller
 * placed still fails the call, as before.
 */
async function freeBusyWithFallback(
  ctx: ToolContext,
  tool: string,
  routed: RoutedCalendar[],
  vias: Array<AvailabilityRead['readVia'][number] | undefined>,
  ids: string[],
  live: PrincipalMailboxView[],
  req: AvailabilityRequest,
  addPartial: (label: string, error: string) => void,
): Promise<QueriedFreeBusy[]> {
  const byMailbox = new Map<string, number[]>();
  routed.forEach((r, i) => byMailbox.set(r.mailboxId, [...(byMailbox.get(r.mailboxId) ?? []), i]));
  const def = live.length > 0 ? defaultMailbox(live) : undefined;
  const groups = await Promise.all(
    [...byMailbox.entries()].map(async ([mailboxId, idx]) => {
      try {
        return await freeBusyAcross(idx.map((i) => routed[i]!), idx.map((i) => ids[i]!), req.timeMin, req.timeMax);
      } catch (err) {
        if (!idx.every((i) => vias[i] !== undefined)) throw err;
        const label = vias[idx[0]!]!.mailbox_label;
        ctx.log.warn({ tool, mailboxId, ...grantSafeErrorFields(err) }, `${tool}: free/busy through the chosen mailbox failed`);
        if (!def || def.id === mailboxId) {
          addPartial(label, readFailureMessage(err));
          return [];
        }
        try {
          const again = await Promise.all(idx.map((i) => ctx.calendarRouter!.route(ids[i]!, def.id)));
          const answers = await freeBusyAcross(again, idx.map((i) => ids[i]!), req.timeMin, req.timeMax);
          for (const [k, i] of idx.entries()) {
            routed[i] = again[k]!;
            vias[i] = { ...vias[i]!, mailbox: def.id, mailbox_label: def.label, fell_back_from: mailboxId };
          }
          ctx.log.info({ tool, mailboxId: def.id, fellBackFrom: mailboxId }, `${tool}: free/busy read through the default mailbox instead`);
          return answers;
        } catch (retryErr) {
          ctx.log.warn({ tool, mailboxId: def.id, ...grantSafeErrorFields(retryErr) }, `${tool}: free/busy through the default mailbox failed too; partial`);
          addPartial(label, readFailureMessage(err));
          return [];
        }
      }
    }),
  );
  return groups.flat();
}

/** Curia hold windows on other calendars to ignore (check-conflicts' ignoreHoldCriteria, as before #2475). */
async function holdWindowsOnOthers(
  ctx: ToolContext,
  tool: string,
  ids: string[],
  routed: RoutedCalendar[],
  req: AvailabilityRequest,
  rangeStart: number,
  rangeEnd: number,
): Promise<Map<string, Array<{ start: number; end: number }>>> {
  const out = new Map<string, Array<{ start: number; end: number }>>();
  for (const [i, id] of ids.entries()) {
    const r = routed[i]!;
    try {
      const events = await r.client.listEvents(r.calendarId, req.timeMin, req.timeMax);
      const windows = findMatchingHolds(events, { ...req.ignoreHolds, startTime: rangeStart, endTime: rangeEnd })
        .filter((m) => m.hold.startTime !== null && m.hold.endTime !== null)
        .map((m) => ({ start: m.hold.startTime!, end: m.hold.endTime! }));
      if (windows.length > 0) out.set(id, windows);
    } catch (err) {
      ctx.log.warn({ ...grantSafeErrorFields(err), mailboxId: r.mailboxId }, `${tool}: failed to inspect holds for ignore criteria`);
    }
  }
  return out;
}

/** A busy block as the tools return it, in the principal's timezone. */
export function blockView(b: BusyBlock, tz: string | undefined): { eventId: string | null; title: string | null; calendar_label: string; start: string | null; end: string | null } {
  return { eventId: b.eventId, title: b.title, calendar_label: b.calendarLabel, start: toLocalIso(b.start, tz), end: toLocalIso(b.end, tz) };
}
