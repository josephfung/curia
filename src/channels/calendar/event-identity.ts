// When two calendar events are the same meeting (#2475, D7). Used by calendar-list-events to
// list a meeting seen through two accounts once, and by calendar-respond-to-invite to find the
// arrival account's own copy of an invite.
//
// The iCal UID alone is not enough: it is set by whoever sends the invite, so a spoofed UID must
// not let one event stand for another (R82, R87, R99). Two events are the same meeting only when
// the UID, the occurrence, start, end, title, organizer, location and conferencing link all agree.
// A spoofed copy that differs in any of these (where to go, which link to join, who sent it) is
// its own event, never a stand-in for the real one.
import { createHash } from 'node:crypto';
import type { NylasCalendarEvent } from './nylas-calendar-client.js';

/** The event's conferencing (video) link, trimmed, or null when it has none. */
export function conferencingLink(e: NylasCalendarEvent): string | null {
  const details = e.conferencing?.['details'];
  if (typeof details !== 'object' || details === null) return null;
  const url = (details as Record<string, unknown>)['url'];
  return typeof url === 'string' && url.trim() !== '' ? url.trim() : null;
}

/** The identity key of an event, or null when it has no iCal UID (such events never match). */
export function sameMeetingKey(e: NylasCalendarEvent): string | null {
  const uid = e.icalUid?.trim();
  if (!uid) return null;
  return JSON.stringify([
    uid,
    // A recurring series' instances share one UID; the occurrence tells them apart.
    e.originalStartTime ?? null,
    e.startTime ?? e.startDate ?? null,
    e.endTime ?? e.endDate ?? null,
    e.title,
    // R99: what the principal acts on. An organizer address can be spoofed too, so a copy that
    // differs in where or how to join stays its own entry.
    e.organizerEmail?.trim().toLowerCase() || null,
    e.location.trim(),
    conferencingLink(e),
  ]);
}

/** True when both events have an organizer and it is the same address (case-insensitive). */
export function sameOrganizer(a: NylasCalendarEvent, b: NylasCalendarEvent): boolean {
  const x = a.organizerEmail?.trim().toLowerCase();
  const y = b.organizerEmail?.trim().toLowerCase();
  return Boolean(x) && x === y;
}

/**
 * A stable key for one occurrence of a meeting, the same on every calendar it is on (#2475, D7):
 * meeting-debrief keys its `seen:` / `prompted:` / `reminded:` guards on it, so a meeting on two
 * of the principal's calendars, or listed through the other account on a later run, is judged and
 * debriefed once. With an iCal UID: `ical-` and a hash of the same fields `sameMeetingKey` uses
 * (UID, occurrence, start, end, title, organizer, location, link; R91, R99), so a spoofed invite reusing a real meeting's UID and
 * time but differing in what the principal sees gets its own key and cannot suppress the real
 * meeting's debrief. The occurrence keeps a weekly series' instances apart; the hash keeps the key
 * short whatever the UID's length. Without a UID: the event id, as before.
 */
export function meetingKey(e: NylasCalendarEvent): string {
  const key = sameMeetingKey(e);
  if (key === null) return e.id;
  return `ical-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}
