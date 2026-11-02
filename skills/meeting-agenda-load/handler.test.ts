import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { MeetingAgendaLoadHandler } from './handler.js';
import { AgendaStore } from '../../src/meetings/agenda-store.js';
import { parseAgendaLoadResult } from '../../src/meetings/agenda-prompt.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { WorkingDocRow, WorkingDocsRepo } from '../../src/db/working-docs-repo.js';

const silentLog = pino({ level: 'silent' });
const NOW = new Date();

function ctx(
  input: Record<string, unknown>,
  repo: WorkingDocsRepo | undefined,
  voiceSessionId?: string,
  timezone?: string,
): ToolContext {
  return {
    input,
    log: silentLog,
    agentId: 'coordinator',
    timezone,
    workingDocs: repo,
    taskMetadata: voiceSessionId ? { voiceSessionId } : undefined,
  } as unknown as ToolContext;
}

async function parkedRepo(overrides: { status?: string; expiresAt?: string; scheduledFor?: Date } = {}): Promise<{
  repo: WorkingDocsRepo;
  agendaId: string;
  store: AgendaStore;
}> {
  const docs = new Map<string, WorkingDocRow>();
  const backing = {
    async create(params: {
      path: string;
      type: string;
      frontmatter?: Record<string, unknown>;
      body?: string;
      taskId?: string | null;
    }): Promise<WorkingDocRow> {
      const row: WorkingDocRow = {
        id: 'doc-1',
        path: params.path,
        type: params.type,
        frontmatter: params.frontmatter ?? {},
        body: params.body ?? '',
        version: 1,
        sectionVersions: {},
        byteSize: 1,
        taskId: null,
        conversationId: null,
        agentId: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        archivedAt: null,
      };
      docs.set(params.path, row);
      return row;
    },
    async read(path: string): Promise<WorkingDocRow | null> {
      return docs.get(path) ?? null;
    },
    async listByPrefix(prefix: string): Promise<WorkingDocRow[]> {
      return [...docs.values()].filter((row) => row.path.startsWith(prefix));
    },
    async update(path: string, params: { frontmatter?: Record<string, unknown>; expectedVersion: number }): Promise<
      { ok: true; document: WorkingDocRow } | { ok: false; conflict: true; document: WorkingDocRow }
    > {
      const current = docs.get(path);
      if (!current) throw new Error('missing');
      if (current.version !== params.expectedVersion) {
        return { ok: false, conflict: true, document: current };
      }
      const next: WorkingDocRow = {
        ...current,
        frontmatter: params.frontmatter ?? current.frontmatter,
        version: current.version + 1,
      };
      docs.set(path, next);
      return { ok: true, document: next };
    },
  };
  const store = new AgendaStore(backing as unknown as WorkingDocsRepo, silentLog);
  const parked = await store.park({
    title: 'Q3 review',
    topics: ['Pipeline'],
    context: 'Board wants a status.',
    source: 'principal',
    sensitivity: 'internal',
    expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    role: 'Be brief.',
    scheduledFor: overrides.scheduledFor ?? null,
  }, NOW);
  if (overrides.status || overrides.expiresAt) {
    const row = docs.get(parked.path)!;
    row.frontmatter = {
      ...row.frontmatter,
      ...(overrides.status ? { status: overrides.status } : {}),
      ...(overrides.expiresAt ? { expires_at: overrides.expiresAt } : {}),
    };
  }
  return { repo: backing as unknown as WorkingDocsRepo, agendaId: parked.agendaId, store };
}

describe('meeting-agenda-load', () => {
  it('locks the agenda for the voice session and returns its snapshot', async () => {
    const { repo, agendaId } = await parkedRepo();
    const result = await new MeetingAgendaLoadHandler().execute(ctx(
      { agenda_id: agendaId },
      repo,
      'session-1',
    ));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { agenda: { agendaId: string; title: string; history: unknown[]; context: string } };
    expect(data.agenda.agendaId).toBe(agendaId);
    expect(data.agenda.title).toBe('Q3 review');
    expect(data.agenda.context).toBe('Board wants a status.');
    expect(data.agenda.history).toEqual([]);
  });

  it('returns scheduledFor and history dates in the caller timezone', async () => {
    const { repo, agendaId, store } = await parkedRepo({
      scheduledFor: new Date('2026-10-28T16:00:00.000Z'),
    });
    const locked = await store.lock(agendaId, 'earlier-session', NOW);
    expect(locked.ok).toBe(true);
    expect(await store.settle(agendaId, 'earlier-session', {
      kind: 'return',
      history: {
        sessionId: 'earlier-session',
        date: '2026-10-21T18:00:00.000Z',
        topics: [{ topic: 'Pipeline', coverage: 'partial' }],
      },
    })).toBe('settled');

    const result = await new MeetingAgendaLoadHandler().execute(ctx(
      { agenda_id: agendaId },
      repo,
      'session-2',
      'America/Toronto',
    ));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as {
      agenda: { scheduledFor: string; history: Array<{ date: string }> };
      displayTimezone: string;
    };
    expect(data.agenda.scheduledFor).toBe('2026-10-28T12:00:00.000-04:00');
    expect(data.agenda.history[0]?.date).toBe('2026-10-21T14:00:00.000-04:00');
    // The label reflects today's offset in Toronto (EDT or EST), not the meeting's.
    expect(data.displayTimezone).toMatch(/^E[DS]T \(UTC-0[45]:00\)$/);
    expect(parseAgendaLoadResult(JSON.stringify({ agenda: data.agenda }))).toMatchObject({
      scheduledFor: '2026-10-28T12:00:00.000-04:00',
      history: [expect.objectContaining({ date: '2026-10-21T14:00:00.000-04:00' })],
    });
  });

  it('rejects outside a voice session', async () => {
    const { repo, agendaId } = await parkedRepo();
    const result = await new MeetingAgendaLoadHandler().execute(ctx({ agenda_id: agendaId }, repo));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe('meeting-agenda-load is only available on a live voice call');
  });

  it('maps not_pending and expired to spoken-friendly errors', async () => {
    const held = await parkedRepo({ status: 'in_call' });
    const heldResult = await new MeetingAgendaLoadHandler().execute(ctx(
      { agenda_id: held.agendaId },
      held.repo,
      'session-1',
    ));
    expect(heldResult.success).toBe(false);
    if (!heldResult.success) expect(heldResult.error).toBe('That agenda is not available right now.');

    const expired = await parkedRepo({ expiresAt: new Date(NOW.getTime() - 1000).toISOString() });
    const expiredResult = await new MeetingAgendaLoadHandler().execute(ctx(
      { agenda_id: expired.agendaId },
      expired.repo,
      'session-1',
    ));
    expect(expiredResult.success).toBe(false);
    if (!expiredResult.success) expect(expiredResult.error).toBe('That agenda has expired.');
  });

  // #2428: the call already held the agenda and kept guessing ids. Asking again
  // for an agenda this call holds is a success, not a dead end.
  it('returns the agenda when this call already holds it', async () => {
    const { repo, agendaId, store } = await parkedRepo();
    expect((await store.lock(agendaId, 'session-1', NOW)).ok).toBe(true);
    const result = await new MeetingAgendaLoadHandler().execute(ctx({ agenda_id: agendaId }, repo, 'session-1'));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { agenda: { agendaId: string } }).agenda.agendaId).toBe(agendaId);

    const other = await new MeetingAgendaLoadHandler().execute(ctx({ agenda_id: agendaId }, repo, 'session-2'));
    expect(other.success).toBe(false);
  });

  it('names the open and queued agendas when the id is unknown', async () => {
    const { repo, agendaId: openId, store } = await parkedRepo();
    expect((await store.lock(openId, 'session-1', NOW)).ok).toBe(true);
    const queued = await store.park({
      title: 'Friday sync',
      topics: ['Hiring'],
      context: 'Weekly.',
      source: 'routine',
      sensitivity: 'internal',
      expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      role: null,
      scheduledFor: null,
    }, NOW);
    const result = await new MeetingAgendaLoadHandler().execute(ctx(
      { agenda_id: 'weekly-kickoff-2026-11-02' },
      repo,
      'session-1',
    ));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('I cannot find that agenda.');
    expect(result.error).toContain('Already open on this call: "Q3 review"');
    expect(result.error).toContain(`Queued: "Friday sync" (id ${queued.agendaId})`);
  });

  it('says so when nothing is open or queued', async () => {
    const { repo } = await parkedRepo({ status: 'done' });
    const result = await new MeetingAgendaLoadHandler().execute(ctx({ agenda_id: 'nope' }, repo, 'session-1'));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('No agenda is open or queued for this call.');
  });

  // #2347: the model speaks the tool's own words. The registered name stays.
  it('keeps its name and describes itself without the word load', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, 'tool.json'), 'utf8'),
    ) as { name: string; description: string };
    expect(manifest.name).toBe('meeting-agenda-load');
    expect(manifest.description).not.toMatch(/\bload(s|ed|ing)?\b/i);
    expect(manifest.description).toContain('pulling it up');
  });
});
