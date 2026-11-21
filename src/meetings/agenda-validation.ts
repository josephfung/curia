// agenda-validation.ts — park-input checks and the preload "due" window (#2322).

import { isUnresolvedPlaceholder, unresolvedPlaceholderError } from '../skills/_shared/placeholder-guard.js';
import { isUuid } from '../util/uuid.js';
import type { AgendaDoc, AgendaSensitivity, AgendaSnapshot, ParkAgendaInput } from './types.js';
import { AGENDA_SENSITIVITIES, AGENDA_SOURCES } from './types.js';

const TITLE_MAX = 120;
const TOPIC_MAX = 200;
const ROLE_MAX = 500;
const CONTEXT_MAX = 6_000;
const TOPICS_MAX = 10;
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
/** Inclusive window around `scheduled_for` that counts as due for preload. */
const DUE_WINDOW_MS = 12 * 60 * 60 * 1000;
const CALENDAR_ID_MAX = 1_024;

export type ValidParkAgenda = ParkAgendaInput & { expiresAt: Date; sensitivity: AgendaSensitivity };

export type ParkAgendaValidation =
  | { ok: true; value: ValidParkAgenda }
  | { ok: false; error: string };

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' ? value : undefined;
}

/** An optional non-empty id: absent, null or blank is null; a non-string or an oversized one is an error. */
function readOptionalId(raw: Record<string, unknown>, key: string): string | null | { error: string } {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return { error: `${key} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > CALENDAR_ID_MAX) return { error: `${key} must be at most ${CALENDAR_ID_MAX} characters` };
  return trimmed;
}

function readDate(raw: Record<string, unknown>, keys: string[]): Date | null | undefined | { error: string } {
  let present = false;
  let value: unknown;
  for (const key of keys) {
    if (raw[key] !== undefined) {
      present = true;
      value = raw[key];
      break;
    }
  }
  if (!present) return undefined;
  if (value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { error: `${keys[0]} is not a valid date` };
    return value;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return { error: `${keys[0]} must be an ISO timestamp` };
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { error: `${keys[0]} must be an ISO timestamp` };
  return parsed;
}

/**
 * Validate a parking-tool input. Defaults sensitivity to `internal` and expiry
 * to seven days. Rejects an expiry in the past or more than 30 days out.
 */
export function validateParkAgendaInput(raw: Record<string, unknown>, now: Date): ParkAgendaValidation {
  const title = (readString(raw, 'title') ?? '').trim();
  if (!title) return { ok: false, error: 'title is required' };
  if (title.length > TITLE_MAX) return { ok: false, error: `title must be at most ${TITLE_MAX} characters` };

  if (!Array.isArray(raw.topics)) return { ok: false, error: 'topics must be an array of strings' };
  if (raw.topics.length === 0) return { ok: false, error: 'topics must include at least one topic' };
  if (raw.topics.length > TOPICS_MAX) return { ok: false, error: `topics must include at most ${TOPICS_MAX} topics` };
  const topics: string[] = [];
  for (const topic of raw.topics) {
    if (typeof topic !== 'string') return { ok: false, error: 'topics must be an array of strings' };
    const trimmed = topic.trim();
    if (!trimmed) return { ok: false, error: 'topics must not include an empty topic' };
    if (trimmed.length > TOPIC_MAX) {
      return { ok: false, error: `each topic must be at most ${TOPIC_MAX} characters` };
    }
    topics.push(trimmed);
  }

  if (typeof raw.context !== 'string') return { ok: false, error: 'context is required' };
  if (raw.context.length > CONTEXT_MAX) {
    return { ok: false, error: `context must be at most ${CONTEXT_MAX} characters` };
  }

  const source = readString(raw, 'source');
  if (!source || !AGENDA_SOURCES.includes(source as typeof AGENDA_SOURCES[number])) {
    return { ok: false, error: 'source must be principal, routine, coordinator, or ad_hoc' };
  }

  let role: string | null = null;
  if (raw.role !== undefined && raw.role !== null) {
    if (typeof raw.role !== 'string') return { ok: false, error: 'role must be a string' };
    const trimmed = raw.role.trim();
    if (trimmed.length > ROLE_MAX) return { ok: false, error: `role must be at most ${ROLE_MAX} characters` };
    role = trimmed.length > 0 ? trimmed : null;
  }

  let sensitivity: AgendaSensitivity = 'internal';
  if (raw.sensitivity !== undefined && raw.sensitivity !== null && raw.sensitivity !== '') {
    if (typeof raw.sensitivity !== 'string' || !AGENDA_SENSITIVITIES.includes(raw.sensitivity as AgendaSensitivity)) {
      return { ok: false, error: 'sensitivity must be internal, confidential, or shareable' };
    }
    sensitivity = raw.sensitivity as AgendaSensitivity;
  }

  const expires = readDate(raw, ['expires_at', 'expiresAt']);
  if (expires && typeof expires === 'object' && 'error' in expires) return { ok: false, error: expires.error };
  const expiresAt = expires instanceof Date ? expires : new Date(now.getTime() + DEFAULT_EXPIRY_MS);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, error: 'expires_at must be in the future' };
  if (expiresAt.getTime() > now.getTime() + MAX_EXPIRY_MS) {
    return { ok: false, error: 'expires_at must be within 30 days' };
  }

  const scheduled = readDate(raw, ['scheduled_for', 'scheduledFor']);
  if (scheduled && typeof scheduled === 'object' && 'error' in scheduled) {
    return { ok: false, error: scheduled.error };
  }
  const scheduledFor = scheduled instanceof Date ? scheduled : null;

  const calendarEventId = readOptionalId(raw, 'calendar_event_id');
  if (calendarEventId !== null && typeof calendarEventId === 'object') return { ok: false, error: calendarEventId.error };
  const calendarId = readOptionalId(raw, 'calendar_id');
  if (calendarId !== null && typeof calendarId === 'object') return { ok: false, error: calendarId.error };
  // The sync reads the event by both ids, so one without the other could never be followed.
  if ((calendarEventId === null) !== (calendarId === null)) {
    return { ok: false, error: 'calendar_event_id and calendar_id must be given together' };
  }

  let ownerTaskId: string | null = null;
  if (raw.owner_task_id !== undefined && raw.owner_task_id !== null && raw.owner_task_id !== '') {
    if (isUnresolvedPlaceholder(raw.owner_task_id)) {
      return { ok: false, error: unresolvedPlaceholderError('owner_task_id', raw.owner_task_id) };
    }
    if (typeof raw.owner_task_id !== 'string' || !isUuid(raw.owner_task_id.trim())) {
      return { ok: false, error: 'owner_task_id must be a task UUID' };
    }
    ownerTaskId = raw.owner_task_id.trim();
  }

  return {
    ok: true,
    value: {
      title,
      topics,
      role,
      context: raw.context,
      source: source as ValidParkAgenda['source'],
      sensitivity,
      expiresAt,
      scheduledFor,
      calendarEventId,
      calendarId,
      ownerTaskId,
    },
  };
}

/**
 * A pending agenda is due when it has no timing hint, or `scheduledFor` is
 * within ±12 hours of `now` (inclusive). An agenda tied to a calendar event
 * stays due from 12 hours before the event until it is settled, so a late
 * call, even one after a no-show, still loads it (#2360); `expires_at` still
 * bounds it. An event-tied agenda that is not pending, or whose event was
 * cancelled, is never due.
 */
export function isDue(
  agenda: Pick<AgendaSnapshot, 'scheduledFor'> & Partial<Pick<AgendaDoc, 'calendarEventId' | 'eventState' | 'status'>>,
  now: Date,
): boolean {
  if (agenda.calendarEventId) {
    if ((agenda.status !== undefined && agenda.status !== 'pending') || agenda.eventState === 'cancelled') return false;
  }
  if (agenda.scheduledFor == null || agenda.scheduledFor === '') return true;
  const at = Date.parse(agenda.scheduledFor);
  if (Number.isNaN(at)) return false;
  if (agenda.calendarEventId) return now.getTime() >= at - DUE_WINDOW_MS;
  return Math.abs(at - now.getTime()) <= DUE_WINDOW_MS;
}
