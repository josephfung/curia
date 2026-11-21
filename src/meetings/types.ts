// types.ts — agenda, coverage and session-load shapes for meeting calls (#2322).

export type AgendaSource = 'principal' | 'routine' | 'coordinator' | 'ad_hoc';
export type AgendaSensitivity = 'internal' | 'confidential' | 'shareable';
export type AgendaStatus = 'pending' | 'in_call' | 'done';
export type TopicCoverage = 'covered' | 'partial' | 'not_reached';
/** What the agenda's calendar event did, as the event sync last saw it. Null when not event-tied. */
export type AgendaEventState = 'scheduled' | 'cancelled' | 'no_show' | 'unreadable';

export interface TopicCoverageEntry {
  topic: string;
  coverage: TopicCoverage;
}

export interface AgendaHistoryEntry {
  sessionId: string;
  /** ISO timestamp of the session the coverage describes. */
  date: string;
  topics: TopicCoverageEntry[];
}

export interface AgendaSnapshot {
  agendaId: string;
  title: string;
  topics: string[];
  role: string | null;
  context: string;
  source: AgendaSource;
  sensitivity: AgendaSensitivity;
  scheduledFor: string | null;
  history: AgendaHistoryEntry[];
}

export interface AgendaDoc extends AgendaSnapshot {
  path: string;
  version: number;
  status: AgendaStatus;
  expiresAt: string;
  inCallSession: string | null;
  /** The booked calendar event this agenda follows (#2360). Null for an untied agenda. */
  calendarEventId: string | null;
  calendarId: string | null;
  /** The task woken when the event is cancelled, about to start, or missed. */
  ownerTaskId: string | null;
  /** ISO time the owner was woken to nudge the principal; cleared when the event moves later. */
  nudgedAt: string | null;
  eventState: AgendaEventState | null;
}

export interface AgendaIndexEntry {
  agendaId: string;
  title: string;
  scheduledFor: string | null;
}

export interface SessionAgendas {
  loaded: AgendaSnapshot[];
  index: AgendaIndexEntry[];
}

export interface SessionAgendaLoad {
  agendaId: string;
  loadedAt: string;
  snapshot: AgendaSnapshot;
}

export interface AgendaCoverage {
  agendaId: string;
  topics: TopicCoverageEntry[];
}

/**
 * Whether a call's follow-up sends the principal a recap, and why (#2347).
 * `unknown` means coverage could not be read (minutes written by an earlier
 * run, or no parseable coverage), so the follow-up judges from the minutes.
 */
export type MinutesRecap = 'requested' | 'topic_covered' | 'not_earned' | 'unknown';

export interface ParkAgendaInput {
  title: string;
  topics: string[];
  role?: string | null;
  context: string;
  source: AgendaSource;
  sensitivity?: AgendaSensitivity;
  expiresAt?: Date;
  scheduledFor?: Date | null;
  calendarEventId?: string | null;
  calendarId?: string | null;
  ownerTaskId?: string | null;
}

export const AGENDA_SOURCES: readonly AgendaSource[] = ['principal', 'routine', 'coordinator', 'ad_hoc'];
export const AGENDA_SENSITIVITIES: readonly AgendaSensitivity[] = ['internal', 'confidential', 'shareable'];
export const AGENDA_STATUSES: readonly AgendaStatus[] = ['pending', 'in_call', 'done'];
export const AGENDA_EVENT_STATES: readonly AgendaEventState[] = ['scheduled', 'cancelled', 'no_show', 'unreadable'];
export const TOPIC_COVERAGE: readonly TopicCoverage[] = ['covered', 'partial', 'not_reached'];

/** Most restrictive first. Minutes take the strictest label of the agendas they cover. */
export const SENSITIVITY_RANK: Record<AgendaSensitivity, number> = {
  confidential: 3,
  internal: 2,
  shareable: 1,
};
