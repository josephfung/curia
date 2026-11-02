// handler.ts — meeting-agenda-load (#2322).
//
// Voice-only, like async-offramp. The coordinator is the caller because the
// voice bridge invokes tools as the coordinator; the voiceSessionId guard is
// the real gate. Loading locks the agenda for this session. It does not
// consume it — settlement after the call decides that.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { AgendaStore, agendaSnapshot, type AgendaLockResult } from '../../src/meetings/agenda-store.js';
import type { AgendaDoc, AgendaSnapshot } from '../../src/meetings/types.js';
import { formatDisplayTimezone, toLocalIso } from '../../src/time/timestamp.js';

function displayIso(iso: string | null, timezone: string | undefined): string | null {
  if (iso === null || !timezone) return iso;
  const unix = Date.parse(iso) / 1000;
  if (!Number.isFinite(unix)) return iso;
  return toLocalIso(unix, timezone) ?? iso;
}

function snapshotForCaller(snapshot: AgendaSnapshot, timezone: string | undefined): AgendaSnapshot {
  return {
    ...snapshot,
    scheduledFor: displayIso(snapshot.scheduledFor, timezone),
    history: snapshot.history.map((entry) => ({
      ...entry,
      date: displayIso(entry.date, timezone) ?? entry.date,
    })),
  };
}

function spokenLockError(reason: Extract<AgendaLockResult, { ok: false }>['reason']): string {
  switch (reason) {
    case 'expired':
      return 'That agenda has expired.';
    case 'not_pending':
      return 'That agenda is not available right now.';
    case 'not_found':
      return 'I cannot find that agenda.';
    case 'conflict':
      return 'That agenda is already in use on another call.';
    default: {
      const neverReason: never = reason;
      return `Could not open that agenda (${neverReason}).`;
    }
  }
}

// The first dry run guessed ids twice and gave up (#2428). A not-found answer
// names what this call can actually use, so the next call is a real id.
async function availableAgendas(store: AgendaStore, sessionId: string, now: Date): Promise<string> {
  const [held, queued] = await Promise.all([store.listHeldBy(sessionId), store.listPending(now)]);
  if (held.length === 0 && queued.length === 0) return 'No agenda is open or queued for this call.';
  const parts: string[] = [];
  if (held.length > 0) {
    parts.push(`Already open on this call: ${held.map((doc) => `"${doc.title}"`).join(', ')}. It is in front of you; go over it.`);
  }
  if (queued.length > 0) {
    parts.push(`Queued: ${queued.map((doc) => `"${doc.title}" (id ${doc.agendaId})`).join(', ')}.`);
  }
  return parts.join(' ');
}

export class MeetingAgendaLoadHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const sessionId = ctx.taskMetadata?.voiceSessionId;
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { success: false, error: 'meeting-agenda-load is only available on a live voice call' };
    }
    if (!ctx.workingDocs) {
      return { success: false, error: 'meeting-agenda-load requires the workingDocs capability' };
    }
    const agendaId = typeof ctx.input.agenda_id === 'string' ? ctx.input.agenda_id.trim() : '';
    if (!agendaId) return { success: false, error: 'agenda_id is required' };
    try {
      const store = new AgendaStore(ctx.workingDocs, ctx.log);
      const now = new Date();
      // Asking again for an agenda this call already holds is not an error (#2428).
      const current = await store.get(agendaId);
      const held = current?.status === 'in_call' && current.inCallSession === sessionId ? current : null;
      let agenda: AgendaDoc;
      if (held) {
        agenda = held;
      } else {
        const locked = await store.lock(agendaId, sessionId, now);
        if (!locked.ok) {
          const error = spokenLockError(locked.reason);
          return {
            success: false,
            error: locked.reason === 'not_found' ? `${error} ${await availableAgendas(store, sessionId, now)}` : error,
          };
        }
        agenda = locked.agenda;
      }
      const tz = ctx.timezone;
      return {
        success: true,
        data: {
          agenda: snapshotForCaller(agendaSnapshot(agenda), tz),
          displayTimezone: tz ? formatDisplayTimezone(tz, now) : null,
        },
      };
    } catch (err) {
      ctx.log.error({ err, agendaId }, 'meeting-agenda-load failed');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
