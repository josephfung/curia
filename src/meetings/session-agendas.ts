// session-agendas.ts — what a principal call starts with (#2322).
//
// Cull, then lock only when the single pending agenda is due. One that is not
// due, or several pending agendas, stay an index. A store failure yields an
// empty session so the call still starts free-form.
//
// Every call route (Signal bridge, console and PWA via VoiceAdapter) goes
// through prepareCallAgendas / withAgendaMetadata / releaseUnstartedPreload
// (#2359), so the principal gate and the session-row shape stay identical.

import type { SystemRole } from '../contacts/types.js';
import type { Logger } from '../logger.js';
import type { AgendaStore } from './agenda-store.js';
import { agendaSnapshot } from './agenda-store.js';
import { isDue } from './agenda-validation.js';
import type { AgendaDoc, SessionAgendaLoad, SessionAgendas } from './types.js';

export interface PreparedSessionAgendas {
  /** Handed to VoiceRuntime.startSession. */
  agendas: SessionAgendas;
  /** The agenda locked for this session, if any; recorded in the session row. */
  preload: SessionAgendaLoad | null;
}

function empty(): PreparedSessionAgendas {
  return { agendas: { loaded: [], index: [] }, preload: null };
}

function indexOf(pending: AgendaDoc[]): SessionAgendas {
  return {
    loaded: [],
    index: pending.map((doc) => ({
      agendaId: doc.agendaId,
      title: doc.title,
      scheduledFor: doc.scheduledFor,
    })),
  };
}

export async function prepareSessionAgendas(
  store: AgendaStore,
  opts: { sessionId: string; now: Date; logger: Logger },
): Promise<PreparedSessionAgendas> {
  try {
    await store.cullExpired(opts.now);
    const pending = await store.listPending(opts.now);
    const only = pending.length === 1 ? pending[0]! : null;
    if (!only || !isDue(only, opts.now)) {
      return { agendas: indexOf(pending), preload: null };
    }
    const target = only;
    const locked = await store.lock(target.agendaId, opts.sessionId, opts.now);
    if (!locked.ok) {
      return { agendas: indexOf(pending), preload: null };
    }
    const snapshot = agendaSnapshot(locked.agenda);
    const preload: SessionAgendaLoad = {
      agendaId: snapshot.agendaId,
      loadedAt: opts.now.toISOString(),
      snapshot,
    };
    return {
      agendas: { loaded: [snapshot], index: [] },
      preload,
    };
  } catch (err) {
    opts.logger.error({ err, sessionId: opts.sessionId }, 'meeting agendas: preparation failed');
    return empty();
  }
}

/**
 * Session-start agenda preparation for a call, whatever route it came in on.
 *
 * Parked agendas are the principal's, so only a principal caller gets them.
 * Anyone else (and a route with no store) gets null and the store is never
 * touched: no cull, no list, no lock. Call this before the session row exists
 * so the lock records the session id; if the row then fails to insert, call
 * releaseUnstartedPreload.
 */
export async function prepareCallAgendas(
  store: AgendaStore | undefined,
  opts: { callerSystemRole: SystemRole | null; sessionId: string; now: Date; logger: Logger },
): Promise<PreparedSessionAgendas | null> {
  if (!store || opts.callerSystemRole !== 'principal') return null;
  return prepareSessionAgendas(store, { sessionId: opts.sessionId, now: opts.now, logger: opts.logger });
}

/**
 * Session-row metadata with the prepared agenda load recorded under `agendas`,
 * which the minutes pipeline and startup recovery read back. With nothing
 * prepared there is no `agendas` key, so a non-principal row looks exactly as
 * it did before agendas existed.
 *
 * The server owns `agendas`: any value a client sent (the console route passes
 * request-body metadata through) is dropped, prepared or not. The minutes
 * pipeline builds minutes from these snapshots, so the row must only ever name
 * loads this session actually made.
 */
export function withAgendaMetadata(
  metadata: Record<string, unknown> | undefined,
  prepared: PreparedSessionAgendas | null,
): Record<string, unknown> | undefined {
  if (!prepared) {
    if (!metadata || !('agendas' in metadata)) return metadata;
    const rest = { ...metadata };
    delete rest.agendas;
    return rest;
  }
  return { ...metadata, agendas: prepared.preload ? [prepared.preload] : [] };
}

/**
 * Release a preload that no session-ended event will reliably settle: the
 * session row was never created, or the bus failed while the session was
 * starting (so the ended event the minutes pipeline listens for may never
 * arrive). Without this the agenda sits in_call, hidden from every later call,
 * until the next restart's recovery sweep. Settling an already-released lock
 * returns 'not_held', so racing the pipeline is harmless. A failure here is
 * logged, not thrown, so it never masks the error that stopped the session.
 */
export async function releaseUnstartedPreload(
  store: AgendaStore | undefined,
  prepared: PreparedSessionAgendas | null,
  sessionId: string,
  logger: Logger,
): Promise<void> {
  if (!store || !prepared?.preload) return;
  try {
    await store.settle(prepared.preload.agendaId, sessionId, { kind: 'return' });
  } catch (err) {
    logger.error(
      { err, sessionId, agendaId: prepared.preload.agendaId },
      'meeting agenda: failed to release preload after session setup failed',
    );
  }
}
