// agenda-store.ts — pending / in_call / done lifecycle for OKF agenda documents (#2322).
//
// One document per agenda at `/meetings/agendas/<agendaId>.md`. Load is a
// version-checked lock, not consumption. Settlement retries a version conflict
// so a console edit during the call cannot stick the agenda in `in_call`.

import { randomUUID } from 'node:crypto';
import type { WorkingDocRow, WorkingDocsRepo } from '../db/working-docs-repo.js';
import type { Logger } from '../logger.js';
import { isUuid } from '../util/uuid.js';
import type {
  AgendaDoc,
  AgendaEventState,
  AgendaHistoryEntry,
  AgendaSensitivity,
  AgendaSnapshot,
  AgendaSource,
  AgendaStatus,
  ParkAgendaInput,
  TopicCoverageEntry,
} from './types.js';
import {
  AGENDA_EVENT_STATES,
  AGENDA_SENSITIVITIES,
  AGENDA_SOURCES,
  AGENDA_STATUSES,
  TOPIC_COVERAGE,
} from './types.js';

const AGENDA_PREFIX = '/meetings/agendas/';
const DOC_TYPE = 'meeting-agenda';
const SETTLE_ATTEMPTS = 3;

export type AgendaLockResult =
  | { ok: true; agenda: AgendaDoc }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'expired' | 'conflict' };

/** Event-sync bookkeeping written by `markEvent`. Absent keys are left as they are. */
export interface AgendaEventPatch {
  eventState?: AgendaEventState;
  nudgedAt?: string | null;
}

export type AgendaSettleOutcome =
  | { kind: 'done' }
  | { kind: 'return'; history?: AgendaHistoryEntry };

type ParkedAgenda = ParkAgendaInput & { expiresAt: Date; sensitivity: AgendaSensitivity };

function isSource(value: unknown): value is AgendaSource {
  return typeof value === 'string' && AGENDA_SOURCES.includes(value as AgendaSource);
}

function isSensitivity(value: unknown): value is AgendaSensitivity {
  return typeof value === 'string' && AGENDA_SENSITIVITIES.includes(value as AgendaSensitivity);
}

function isStatus(value: unknown): value is AgendaStatus {
  return typeof value === 'string' && AGENDA_STATUSES.includes(value as AgendaStatus);
}

function isCoverage(value: unknown): value is TopicCoverageEntry['coverage'] {
  return typeof value === 'string' && TOPIC_COVERAGE.includes(value as TopicCoverageEntry['coverage']);
}

function isEventState(value: unknown): value is AgendaEventState {
  return typeof value === 'string' && AGENDA_EVENT_STATES.includes(value as AgendaEventState);
}

/**
 * An optional string frontmatter field: absent or null reads as null (documents
 * parked before the field existed), a string as itself, anything else as invalid.
 */
function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function agendaIdFromPath(path: string): string | null {
  const match = /^\/meetings\/agendas\/([0-9a-f-]{36})\.md$/i.exec(path);
  return match?.[1] ?? null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null;
  return value;
}

function parseHistory(value: unknown): AgendaHistoryEntry[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const entries: AgendaHistoryEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    if (typeof record.sessionId !== 'string' || typeof record.date !== 'string') return null;
    if (!Array.isArray(record.topics)) return null;
    const topics: TopicCoverageEntry[] = [];
    for (const topic of record.topics) {
      if (!topic || typeof topic !== 'object') return null;
      const row = topic as Record<string, unknown>;
      if (typeof row.topic !== 'string' || !isCoverage(row.coverage)) return null;
      topics.push({ topic: row.topic, coverage: row.coverage });
    }
    entries.push({ sessionId: record.sessionId, date: record.date, topics });
  }
  return entries;
}

/**
 * Parse a live agenda row. Returns null when the row is not an agenda document.
 *
 * The event fields steer wakes, and the console can edit frontmatter, so they are
 * re-checked here: an owner that is not a UUID, or a calendar event id without its
 * calendar (or the reverse), reads as null rather than reaching the event sync.
 */
export function parseAgendaDoc(row: WorkingDocRow, logger?: Logger): AgendaDoc | null {
  const agendaId = agendaIdFromPath(row.path);
  if (!agendaId || row.type !== DOC_TYPE) return null;
  const fm = row.frontmatter;
  const topics = asStringArray(fm.topics);
  const history = parseHistory(fm.history);
  if (typeof fm.title !== 'string' || !topics || !history) return null;
  if (!isSource(fm.source) || !isSensitivity(fm.sensitivity) || !isStatus(fm.status)) return null;
  if (typeof fm.expires_at !== 'string') return null;
  const role = fm.role === null || fm.role === undefined ? null : typeof fm.role === 'string' ? fm.role : null;
  if (fm.role !== undefined && fm.role !== null && typeof fm.role !== 'string') return null;
  const scheduledFor = fm.scheduled_for === null || fm.scheduled_for === undefined
    ? null
    : typeof fm.scheduled_for === 'string' ? fm.scheduled_for : null;
  if (fm.scheduled_for !== undefined && fm.scheduled_for !== null && typeof fm.scheduled_for !== 'string') return null;
  const inCallSession = fm.in_call_session === null || fm.in_call_session === undefined
    ? null
    : typeof fm.in_call_session === 'string' ? fm.in_call_session : null;
  if (fm.in_call_session !== undefined && fm.in_call_session !== null && typeof fm.in_call_session !== 'string') {
    return null;
  }
  let calendarEventId = optionalString(fm.calendar_event_id);
  let calendarId = optionalString(fm.calendar_id);
  let ownerTaskId = optionalString(fm.owner_task_id);
  const nudgedAt = optionalString(fm.nudged_at);
  if (calendarEventId === undefined || calendarId === undefined || ownerTaskId === undefined || nudgedAt === undefined) {
    return null;
  }
  if (ownerTaskId !== null && !isUuid(ownerTaskId)) {
    logger?.warn({ agendaId }, 'agenda-store: owner_task_id is not a UUID, ignoring it');
    ownerTaskId = null;
  }
  if ((calendarEventId === null) !== (calendarId === null)) {
    logger?.warn({ agendaId }, 'agenda-store: calendar_event_id and calendar_id must be set together, ignoring both');
    calendarEventId = null;
    calendarId = null;
  }
  const eventState = fm.event_state === undefined || fm.event_state === null ? null : fm.event_state;
  if (eventState !== null && !isEventState(eventState)) return null;
  return {
    agendaId,
    path: row.path,
    version: row.version,
    title: fm.title,
    topics,
    role,
    context: row.body,
    source: fm.source,
    sensitivity: fm.sensitivity,
    status: fm.status,
    expiresAt: fm.expires_at,
    scheduledFor,
    inCallSession,
    history,
    calendarEventId,
    calendarId,
    ownerTaskId,
    nudgedAt,
    eventState,
  };
}

function frontmatterFor(doc: AgendaDoc): Record<string, unknown> {
  return {
    title: doc.title,
    topics: doc.topics,
    role: doc.role,
    source: doc.source,
    sensitivity: doc.sensitivity,
    status: doc.status,
    expires_at: doc.expiresAt,
    scheduled_for: doc.scheduledFor,
    in_call_session: doc.inCallSession,
    history: doc.history,
    calendar_event_id: doc.calendarEventId,
    calendar_id: doc.calendarId,
    owner_task_id: doc.ownerTaskId,
    nudged_at: doc.nudgedAt,
    event_state: doc.eventState,
  };
}

function snapshotOf(doc: AgendaDoc): AgendaSnapshot {
  return {
    agendaId: doc.agendaId,
    title: doc.title,
    topics: doc.topics,
    role: doc.role,
    context: doc.context,
    source: doc.source,
    sensitivity: doc.sensitivity,
    scheduledFor: doc.scheduledFor,
    history: doc.history,
  };
}

export function agendaSnapshot(doc: AgendaDoc): AgendaSnapshot {
  return snapshotOf(doc);
}

function isExpired(doc: AgendaDoc, now: Date): boolean {
  const at = Date.parse(doc.expiresAt);
  return Number.isNaN(at) || at <= now.getTime();
}

export class AgendaStore {
  constructor(
    private readonly repo: WorkingDocsRepo,
    private readonly logger: Logger,
  ) {}

  async park(input: ParkedAgenda, now: Date): Promise<AgendaDoc> {
    const agendaId = randomUUID();
    const path = `${AGENDA_PREFIX}${agendaId}.md`;
    const doc: AgendaDoc = {
      agendaId,
      path,
      version: 1,
      title: input.title,
      topics: input.topics,
      role: input.role ?? null,
      context: input.context,
      source: input.source,
      sensitivity: input.sensitivity,
      status: 'pending',
      expiresAt: input.expiresAt.toISOString(),
      scheduledFor: input.scheduledFor ? input.scheduledFor.toISOString() : null,
      inCallSession: null,
      history: [],
      calendarEventId: input.calendarEventId ?? null,
      calendarId: input.calendarId ?? null,
      ownerTaskId: input.ownerTaskId ?? null,
      nudgedAt: null,
      eventState: input.calendarEventId ? 'scheduled' : null,
    };
    const created = await this.repo.create({
      path,
      type: DOC_TYPE,
      frontmatter: frontmatterFor(doc),
      body: input.context,
      taskId: null,
    });
    const parsed = parseAgendaDoc(created, this.logger);
    if (!parsed) {
      throw new Error(`agenda-store: parked document at ${path} did not parse`);
    }
    this.logger.debug({ agendaId, now: now.toISOString() }, 'agenda-store: parked agenda');
    if (parsed.ownerTaskId) await this.supersedeOwnedBy(parsed.ownerTaskId, agendaId);
    return parsed;
  }

  /**
   * A new agenda for an owner task replaces that owner's earlier pending ones
   * (a cancelled or missed session re-booked), so the old one can neither be
   * preloaded onto an unrelated call nor keep the new one from preloading. Runs
   * after the new agenda exists: a failure here leaves two agendas, never none,
   * and is logged rather than failing the park.
   */
  private async supersedeOwnedBy(ownerTaskId: string, keepAgendaId: string): Promise<void> {
    let rows: WorkingDocRow[];
    try {
      rows = await this.repo.listByPrefix(AGENDA_PREFIX);
    } catch (err) {
      this.logger.error({ err, ownerTaskId, keepAgendaId }, 'agenda-store: listing agendas to supersede failed');
      return;
    }
    // Per agenda: one that fails to close does not keep the others open.
    for (const row of rows) {
      if (!row.path.startsWith(AGENDA_PREFIX)) continue;
      const doc = parseAgendaDoc(row, this.logger);
      if (!doc || doc.agendaId === keepAgendaId) continue;
      if (doc.status !== 'pending' || doc.ownerTaskId !== ownerTaskId) continue;
      try {
        const closed = await this.close(doc.agendaId, {});
        if (closed) {
          this.logger.info({ agendaId: doc.agendaId, supersededBy: keepAgendaId }, 'agenda-store: superseded agenda closed');
        }
      } catch (err) {
        this.logger.error({ err, agendaId: doc.agendaId, ownerTaskId, keepAgendaId }, 'agenda-store: closing a superseded agenda failed');
      }
    }
  }

  async get(agendaId: string): Promise<AgendaDoc | null> {
    const row = await this.repo.read(`${AGENDA_PREFIX}${agendaId}.md`);
    if (!row) return null;
    const parsed = parseAgendaDoc(row, this.logger);
    if (!parsed) {
      this.logger.warn({ agendaId, path: row.path }, 'agenda-store: agenda document did not parse');
    }
    return parsed;
  }

  async listPending(now: Date): Promise<AgendaDoc[]> {
    const rows = await this.repo.listByPrefix(AGENDA_PREFIX);
    const pending: AgendaDoc[] = [];
    for (const row of rows) {
      if (!row.path.startsWith(AGENDA_PREFIX)) continue;
      const doc = parseAgendaDoc(row, this.logger);
      if (!doc) {
        this.logger.warn({ path: row.path }, 'agenda-store: agenda document did not parse — left out of the pending list');
        continue;
      }
      if (doc.status !== 'pending' || isExpired(doc, now)) continue;
      pending.push(doc);
    }
    pending.sort((a, b) => {
      if (a.scheduledFor === null && b.scheduledFor !== null) return 1;
      if (a.scheduledFor !== null && b.scheduledFor === null) return -1;
      if (a.scheduledFor !== null && b.scheduledFor !== null && a.scheduledFor !== b.scheduledFor) {
        return a.scheduledFor < b.scheduledFor ? -1 : 1;
      }
      return a.title.localeCompare(b.title);
    });
    return pending;
  }

  /** Agendas this call holds. A wrong id on the load tool is answered with these and `listPending` (#2428). */
  async listHeldBy(sessionId: string): Promise<AgendaDoc[]> {
    const rows = await this.repo.listByPrefix(AGENDA_PREFIX);
    const held: AgendaDoc[] = [];
    for (const row of rows) {
      if (!row.path.startsWith(AGENDA_PREFIX)) continue;
      const doc = parseAgendaDoc(row, this.logger);
      if (doc && doc.status === 'in_call' && doc.inCallSession === sessionId) held.push(doc);
    }
    return held;
  }

  /** Archive expired pending agendas. An `in_call` agenda is never culled. */
  async cullExpired(now: Date): Promise<number> {
    const rows = await this.repo.listByPrefix(AGENDA_PREFIX);
    let archived = 0;
    for (const row of rows) {
      if (!row.path.startsWith(AGENDA_PREFIX)) continue;
      const doc = parseAgendaDoc(row, this.logger);
      if (!doc || doc.status !== 'pending' || !isExpired(doc, now)) continue;
      const result = await this.repo.softDeleteAtVersion(doc.path, doc.version);
      if (result?.ok) archived += 1;
      else if (result && !result.ok) {
        this.logger.warn({ agendaId: doc.agendaId }, 'agenda-store: expired agenda changed before cull');
      }
    }
    return archived;
  }

  async lock(agendaId: string, sessionId: string, now: Date): Promise<AgendaLockResult> {
    const doc = await this.get(agendaId);
    if (!doc) return { ok: false, reason: 'not_found' };
    if (doc.status !== 'pending') return { ok: false, reason: 'not_pending' };
    if (isExpired(doc, now)) return { ok: false, reason: 'expired' };
    const next: AgendaDoc = { ...doc, status: 'in_call', inCallSession: sessionId };
    const updated = await this.repo.update(doc.path, {
      type: DOC_TYPE,
      frontmatter: frontmatterFor(next),
      expectedVersion: doc.version,
    });
    if (!updated.ok) return { ok: false, reason: 'conflict' };
    const parsed = parseAgendaDoc(updated.document, this.logger);
    if (!parsed) return { ok: false, reason: 'conflict' };
    return { ok: true, agenda: parsed };
  }

  /**
   * Follow the agenda's calendar event to a new start. A later start clears
   * `nudgedAt` and a recorded no-show, so the moved session is nudged and
   * watched again. Only a pending agenda is changed. A version conflict is
   * re-read and retried, as in `settle`.
   */
  async reschedule(agendaId: string, scheduledFor: Date): Promise<AgendaDoc | null> {
    return this.updatePending(agendaId, (doc) => {
      const previous = doc.scheduledFor === null ? Number.NaN : Date.parse(doc.scheduledFor);
      const later = Number.isNaN(previous) || scheduledFor.getTime() > previous;
      return {
        ...doc,
        scheduledFor: scheduledFor.toISOString(),
        ...(later ? { nudgedAt: null, eventState: doc.eventState === 'no_show' ? 'scheduled' : doc.eventState } : {}),
      };
    });
  }

  /** Record event-sync bookkeeping on a pending agenda, retrying a version conflict as `settle` does. */
  async markEvent(agendaId: string, patch: AgendaEventPatch): Promise<AgendaDoc | null> {
    return this.updatePending(agendaId, (doc) => ({
      ...doc,
      ...(patch.eventState !== undefined ? { eventState: patch.eventState } : {}),
      ...(patch.nudgedAt !== undefined ? { nudgedAt: patch.nudgedAt } : {}),
    }));
  }

  /**
   * Close a pending agenda without a call: status done, then archived, as
   * `settle` does for `done`. Used when its event was cancelled (with
   * `eventState: 'cancelled'`) or a new agenda for the same owner superseded
   * it. Retries a version conflict. Returns the closed agenda, or null.
   */
  async close(agendaId: string, patch: AgendaEventPatch): Promise<AgendaDoc | null> {
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      const doc = await this.get(agendaId);
      if (!doc || doc.status !== 'pending') return null;
      const next: AgendaDoc = {
        ...doc,
        status: 'done',
        ...(patch.eventState !== undefined ? { eventState: patch.eventState } : {}),
      };
      const updated = await this.repo.update(doc.path, {
        type: DOC_TYPE,
        frontmatter: frontmatterFor(next),
        expectedVersion: doc.version,
      });
      if (!updated.ok) continue;
      const archived = await this.repo.softDeleteAtVersion(doc.path, updated.document.version);
      if (!archived?.ok) {
        // Written as done but not archived (edited in between): it is no longer pending either way.
        this.logger.warn({ agendaId }, 'agenda-store: closed agenda changed before archive');
      }
      return parseAgendaDoc(updated.document, this.logger);
    }
    this.logger.error({ agendaId }, 'agenda-store: close gave up after a version conflict');
    return null;
  }

  /**
   * Write `change(doc)` over the current pending agenda. Returns the written
   * agenda, or null when it is gone, no longer pending, or still conflicting
   * after SETTLE_ATTEMPTS reads.
   */
  private async updatePending(
    agendaId: string,
    change: (doc: AgendaDoc) => AgendaDoc,
  ): Promise<AgendaDoc | null> {
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      const doc = await this.get(agendaId);
      if (!doc || doc.status !== 'pending') return null;
      const updated = await this.repo.update(doc.path, {
        type: DOC_TYPE,
        frontmatter: frontmatterFor(change(doc)),
        expectedVersion: doc.version,
      });
      if (!updated.ok) continue;
      return parseAgendaDoc(updated.document, this.logger);
    }
    this.logger.error({ agendaId }, 'agenda-store: event update gave up after a version conflict');
    return null;
  }

  /**
   * Finish a lock this session holds. `done` archives the agenda. `return`
   * puts it back to pending and appends history when given. A version conflict
   * (the principal edited the doc mid-call) is re-read and retried.
   */
  async settle(
    agendaId: string,
    sessionId: string,
    outcome: AgendaSettleOutcome,
  ): Promise<'settled' | 'not_held'> {
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      const doc = await this.get(agendaId);
      if (!doc) return 'not_held';
      if (doc.status === 'done' && doc.inCallSession === sessionId) {
        const archived = await this.repo.softDeleteAtVersion(doc.path, doc.version);
        if (archived?.ok || archived === null) return 'settled';
        continue;
      }
      if (doc.status !== 'in_call' || doc.inCallSession !== sessionId) return 'not_held';

      const next: AgendaDoc = outcome.kind === 'done'
        ? { ...doc, status: 'done' }
        : {
          ...doc,
          status: 'pending',
          inCallSession: null,
          history: outcome.history ? [...doc.history, outcome.history] : doc.history,
        };
      const updated = await this.repo.update(doc.path, {
        type: DOC_TYPE,
        frontmatter: frontmatterFor(next),
        expectedVersion: doc.version,
      });
      if (!updated.ok) continue;
      if (outcome.kind === 'done') {
        const archived = await this.repo.softDeleteAtVersion(doc.path, updated.document.version);
        if (!archived?.ok) continue;
      }
      return 'settled';
    }
    this.logger.error({ agendaId, sessionId }, 'agenda-store: settle gave up after a version conflict');
    return 'not_held';
  }
}
