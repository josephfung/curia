// history-calendar.ts — the calendar half of the deterministic history summary (#2362):
// recurring meetings, meeting shape (lengths, buffers, kept-clear blocks, declined or moved) and
// calendar hours by attendee, domain and series. Pure; split out of history-summary.ts for size.
// Each heuristic is described in ./README.md.
import { DateTime } from 'luxon';
import type { NylasCalendarEvent } from '../../channels/calendar/nylas-calendar-client.js';
import {
  compareStrings,
  domainOf,
  EVIDENCE_CAP,
  eventEvidence,
  median,
  normaliseAddress,
  type Dated,
  type Evidence,
} from './summary-util.js';

export type RecurringMeeting = {
  title: string;
  seriesId: string;
  cadence: string;
  minutesPerOccurrence: number;
  attendees: string[];
  evidence: Evidence;
};

export type KeptClearBlock = { weekday: number; start: string; end: string };

export type MeetingShape = {
  medianMinutes: number;
  bufferMinutesMedian: number;
  keptClearBlocks: KeptClearBlock[];
  declinedOrMoved: number;
  evidence: Evidence;
};

export interface CalendarFacts {
  recurringMeetings: RecurringMeeting[];
  meetingShape: MeetingShape;
  /** Attended hours per non-principal attendee address. */
  attendeeHours: Map<string, number>;
  /** Attended hours per attendee domain (an event counts once per domain). */
  domainHours: Map<string, number>;
  /** Attended hours per recurring series (only series in `recurringMeetings`). */
  seriesHours: Map<string, number>;
}

/** A series needs this many occurrences in the window to count as recurring. */
export const RECURRING_MIN_OCCURRENCES = 3;
/** Gaps between consecutive same-day meetings longer than this are not buffers. */
export const BUFFER_MAX_MINUTES = 120;
/** Kept-clear blocks are looked for between these principal-local hours. */
export const WORKDAY_START_HOUR = 8;
export const WORKDAY_END_HOUR = 18;
const SLOT_MINUTES = 30;
/** A slot is kept clear when it is free on at least this share of that weekday's dates. */
export const KEPT_CLEAR_SHARE = 0.75;
export const KEPT_CLEAR_MIN_MINUTES = 60;

type Timed = NylasCalendarEvent & { startTime: number; endTime: number };

function isTimed(e: NylasCalendarEvent): e is Timed {
  return e.startTime !== null && e.endTime !== null && e.endTime > e.startTime;
}

function principalDeclined(e: NylasCalendarEvent, principal: ReadonlySet<string>): boolean {
  return e.participants.some((p) => principal.has(normaliseAddress(p.email)) && p.status === 'no');
}

/**
 * Whether the principal took part in the event: organised it, or accepted it. An invite nobody
 * answered (or declined) is anyone's to send, so it says nothing about the principal's routine.
 */
function principalJoined(e: NylasCalendarEvent, principal: ReadonlySet<string>): boolean {
  if (e.organizerEmail !== undefined && principal.has(normaliseAddress(e.organizerEmail))) return true;
  return e.participants.some((p) => principal.has(normaliseAddress(p.email)) && p.status === 'yes');
}

function wasMoved(e: NylasCalendarEvent): boolean {
  return e.originalStartTime !== undefined && e.startTime !== null && e.originalStartTime !== e.startTime;
}

function seriesIdOf(e: NylasCalendarEvent): string | undefined {
  if (e.masterEventId) return e.masterEventId;
  return e.recurrence && e.recurrence.length > 0 ? e.id : undefined;
}

/** Non-principal attendees who did not decline, lower-cased and deduplicated. */
function outsideAttendees(e: NylasCalendarEvent, principal: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const p of e.participants) {
    const email = normaliseAddress(p.email);
    if (email === '' || principal.has(email) || p.status === 'no') continue;
    out.add(email);
  }
  return [...out].sort(compareStrings);
}

const minutesOf = (e: Timed): number => (e.endTime - e.startTime) / 60;
const dated = (e: NylasCalendarEvent): Dated => ({ id: e.id, at: e.startTime ?? 0 });

function cadenceOf(startsAsc: readonly number[]): string {
  const gaps: number[] = [];
  for (let i = 1; i < startsAsc.length; i++) gaps.push((startsAsc[i]! - startsAsc[i - 1]!) / 86_400);
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const days = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  if (days <= 1.5) return 'daily';
  if (days >= 5.5 && days <= 8.5) return 'weekly';
  if (days >= 12.5 && days <= 15.5) return 'biweekly';
  if (days >= 26 && days <= 35) return 'monthly';
  return `every ${Math.round(days)} days`;
}

function recurring(events: readonly Timed[], attended: ReadonlySet<string>, principal: ReadonlySet<string>): RecurringMeeting[] {
  const bySeries = new Map<string, Timed[]>();
  for (const e of events) {
    const id = seriesIdOf(e);
    if (id === undefined) continue;
    const list = bySeries.get(id) ?? [];
    list.push(e);
    bySeries.set(id, list);
  }
  const out: Array<{ meeting: RecurringMeeting; weight: number }> = [];
  for (const [seriesId, list] of bySeries) {
    const starts = [...new Set(list.map((e) => e.startTime))].sort((a, b) => a - b);
    if (starts.length < RECURRING_MIN_OCCURRENCES) continue;
    // Security: a series the principal never organised or accepted is an outsider's invite. Kept,
    // its attendees would become contacts and its title would reach the drafting prompt.
    if (!list.some((e) => principalJoined(e, principal))) continue;
    const latest = [...list].sort((a, b) => b.startTime - a.startTime || compareStrings(a.id, b.id))[0]!;
    const minutes = median(list.map(minutesOf)) ?? 0;
    const attendees = new Set<string>();
    for (const e of list) for (const a of outsideAttendees(e, principal)) attendees.add(a);
    out.push({
      meeting: {
        title: latest.title,
        seriesId,
        cadence: cadenceOf(starts),
        minutesPerOccurrence: minutes,
        attendees: [...attendees].sort(compareStrings),
        evidence: eventEvidence(list.map(dated)),
      },
      // Attended time in the window: what "biggest series" means for ordering.
      weight: list.filter((e) => attended.has(e.id)).reduce((sum, e) => sum + minutesOf(e), 0),
    });
  }
  out.sort((a, b) => b.weight - a.weight || compareStrings(a.meeting.seriesId, b.meeting.seriesId));
  return out.map((o) => o.meeting);
}

function bufferMedian(attended: readonly Timed[], timezone: string): number {
  const byDay = new Map<string, Timed[]>();
  for (const e of attended) {
    const day = DateTime.fromSeconds(e.startTime, { zone: timezone }).toISODate() ?? '';
    const list = byDay.get(day) ?? [];
    list.push(e);
    byDay.set(day, list);
  }
  const gaps: number[] = [];
  for (const list of byDay.values()) {
    list.sort((a, b) => a.startTime - b.startTime || compareStrings(a.id, b.id));
    let lastEnd = list[0]!.endTime;
    for (let i = 1; i < list.length; i++) {
      const e = list[i]!;
      const gap = Math.max(0, (e.startTime - lastEnd) / 60);
      if (gap <= BUFFER_MAX_MINUTES) gaps.push(gap);
      lastEnd = Math.max(lastEnd, e.endTime);
    }
  }
  return median(gaps) ?? 0;
}

function hhmm(minutesFromMidnight: number): string {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = minutesFromMidnight % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function keptClear(busy: readonly Timed[], window: { from: Date; to: Date }, timezone: string): KeptClearBlock[] {
  const weeks = Math.ceil((window.to.getTime() - window.from.getTime()) / (7 * 86_400_000));
  // Too sparse a calendar makes every weekday look "kept clear"; say nothing instead.
  if (busy.length === 0 || busy.length < weeks) return [];

  const slots = ((WORKDAY_END_HOUR - WORKDAY_START_HOUR) * 60) / SLOT_MINUTES;
  // [weekday 1..5][slot] → dates seen, dates busy
  const seen = new Map<number, number>();
  const busyCount = new Map<string, number>();
  const fromSec = window.from.getTime() / 1000;
  const toSec = window.to.getTime() / 1000;
  for (let day = DateTime.fromJSDate(window.from, { zone: timezone }).startOf('day'); day.toSeconds() < toSec; day = day.plus({ days: 1 })) {
    if (day.weekday > 5) continue;
    const dayStart = day.set({ hour: WORKDAY_START_HOUR });
    const dayEnd = day.set({ hour: WORKDAY_END_HOUR });
    if (dayStart.toSeconds() < fromSec || dayEnd.toSeconds() > toSec) continue;
    seen.set(day.weekday, (seen.get(day.weekday) ?? 0) + 1);
    const todays = busy.filter((e) => e.startTime < dayEnd.toSeconds() && e.endTime > dayStart.toSeconds());
    for (let s = 0; s < slots; s++) {
      const slotStart = dayStart.plus({ minutes: s * SLOT_MINUTES }).toSeconds();
      const slotEnd = dayStart.plus({ minutes: (s + 1) * SLOT_MINUTES }).toSeconds();
      if (todays.some((e) => e.startTime < slotEnd && e.endTime > slotStart)) {
        const key = `${day.weekday}:${s}`;
        busyCount.set(key, (busyCount.get(key) ?? 0) + 1);
      }
    }
  }

  const blocks: KeptClearBlock[] = [];
  for (let weekday = 1; weekday <= 5; weekday++) {
    const total = seen.get(weekday) ?? 0;
    if (total === 0) continue;
    let runStart: number | null = null;
    for (let s = 0; s <= slots; s++) {
      const clear = s < slots && (total - (busyCount.get(`${weekday}:${s}`) ?? 0)) / total >= KEPT_CLEAR_SHARE;
      if (clear && runStart === null) runStart = s;
      if (!clear && runStart !== null) {
        if ((s - runStart) * SLOT_MINUTES >= KEPT_CLEAR_MIN_MINUTES) {
          blocks.push({
            weekday,
            start: hhmm(WORKDAY_START_HOUR * 60 + runStart * SLOT_MINUTES),
            end: hhmm(WORKDAY_START_HOUR * 60 + s * SLOT_MINUTES),
          });
        }
        runStart = null;
      }
    }
  }
  return blocks;
}

export function summariseCalendar(
  rawEvents: readonly NylasCalendarEvent[],
  principal: ReadonlySet<string>,
  window: { from: Date; to: Date },
  timezone: string,
): CalendarFacts {
  const byId = new Map<string, NylasCalendarEvent>();
  for (const e of rawEvents) if (!byId.has(e.id)) byId.set(e.id, e);
  const live = [...byId.values()]
    .filter((e) => e.status !== 'cancelled')
    .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0) || compareStrings(a.id, b.id));

  const timed = live.filter(isTimed);
  const attended = timed.filter((e) => !principalDeclined(e, principal));
  const attendedIds = new Set(attended.map((e) => e.id));
  const declinedOrMoved = live.filter((e) => principalDeclined(e, principal) || wasMoved(e));

  const recurringMeetings = recurring(timed, attendedIds, principal);
  const recurringIds = new Set(recurringMeetings.map((r) => r.seriesId));

  const attendeeHours = new Map<string, number>();
  const domainHours = new Map<string, number>();
  const seriesHours = new Map<string, number>();
  for (const e of attended) {
    const hours = minutesOf(e) / 60;
    const attendees = outsideAttendees(e, principal);
    for (const a of attendees) attendeeHours.set(a, (attendeeHours.get(a) ?? 0) + hours);
    for (const d of new Set(attendees.map(domainOf))) {
      if (d !== '') domainHours.set(d, (domainHours.get(d) ?? 0) + hours);
    }
    const series = seriesIdOf(e);
    if (series !== undefined && recurringIds.has(series)) seriesHours.set(series, (seriesHours.get(series) ?? 0) + hours);
  }

  // Declined or moved first (the notable ones), then attended meetings, newest first within each.
  const evidenceIds = [
    ...eventEvidence(declinedOrMoved.map(dated)).eventIds ?? [],
    ...eventEvidence(attended.map(dated)).eventIds ?? [],
  ];
  const shapeIds = [...new Set(evidenceIds)].slice(0, EVIDENCE_CAP);

  return {
    recurringMeetings,
    meetingShape: {
      medianMinutes: median(attended.map(minutesOf)) ?? 0,
      bufferMinutesMedian: bufferMedian(attended, timezone),
      keptClearBlocks: keptClear(attended.filter((e) => e.busy !== false), window, timezone),
      declinedOrMoved: declinedOrMoved.length,
      evidence: shapeIds.length > 0 ? { eventIds: shapeIds } : {},
    },
    attendeeHours,
    domainHours,
    seriesHours,
  };
}
