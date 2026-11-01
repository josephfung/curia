// Session-end pipeline against Postgres (#2322).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { AuditLogger } from '../../src/audit/logger.js';
import { EventBus } from '../../src/bus/bus.js';
import type { MinutesReadyEvent } from '../../src/bus/events.js';
import { VoiceSessionStore } from '../../src/channels/voice/session-store.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import { replaceActiveSkillsBlock, readActiveSkillNames } from '../../src/db/active-skills-progress.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { makeSystemOriginator } from '../../src/contacts/principal.js';
import { WorkingDocsRepo } from '../../src/db/working-docs-repo.js';
import { createLogger } from '../../src/logger.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { AgendaStore, agendaSnapshot } from '../../src/meetings/agenda-store.js';
import { minutesPath, MinutesPipeline } from '../../src/meetings/minutes-pipeline.js';
import { transcriptPath } from '../../src/meetings/transcript.js';
import { MinutesReadySubscriber } from '../../src/meetings/subscribers.js';
import type { InfraLlm } from '../../src/skills/infra-llm.js';
import type { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { createIsolatedWorkingDocsStore, type IsolatedWorkingDocsStore } from '../helpers/isolated-working-docs.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const TZ = 'America/Toronto';
const DAY = 24 * 60 * 60 * 1000;

function minutesText(agendaId: string, coverage: 'covered' | 'partial' | 'not_reached'): string {
  return [
    '## Board',
    'The caller and Curia discussed the topic.',
    '',
    '```json',
    JSON.stringify({ coverage: [{ agendaId, topics: [{ topic: 'runway', coverage }] }] }),
    '```',
  ].join('\n');
}

describeIf('MinutesPipeline (integration, #2322)', () => {
  let publicPool: pg.Pool;
  let isolated: IsolatedWorkingDocsStore;
  let sessions: VoiceSessionStore;
  let memory: WorkingMemory;
  let repo: WorkingDocsRepo;
  let agendas: AgendaStore;
  let tasks: TaskRepo;
  let pipeline: MinutesPipeline;
  let ready: MinutesReadyEvent[];
  let failed: string[];
  let coverage: 'covered' | 'partial' | 'not_reached' = 'covered';
  let llmOk = true;
  const sessionIds: string[] = [];
  const activeWakes = new Set<string>();

  beforeAll(async () => {
    publicPool = new pg.Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(publicPool);
    isolated = await createIsolatedWorkingDocsStore(DATABASE_URL!);
    const logger = createLogger('error');
    const audit = new AuditLogger(publicPool, logger);
    const bus = new EventBus(
      logger,
      (event) => audit.log(event),
      (eventId) => audit.markAcknowledged(eventId),
    );
    ready = [];
    failed = [];
    bus.subscribe('minutes.ready', 'system', (event) => {
      if (event.type === 'minutes.ready') ready.push(event);
    });
    bus.subscribe('minutes.pipeline_failed', 'system', (event) => {
      if (event.type === 'minutes.pipeline_failed') failed.push(event.payload.sessionId);
    });
    sessions = new VoiceSessionStore(publicPool);
    memory = WorkingMemory.createWithPostgres(publicPool, logger);
    repo = new WorkingDocsRepo(isolated.pool, logger);
    agendas = new AgendaStore(repo, logger);
    tasks = new TaskRepo(publicPool, bus, logger, TZ);
    const llm: InfraLlm = {
      classify: async () => ({ ok: true, text: '' }),
      extract: async (prompt) => {
        if (!llmOk) return { ok: false, error: 'model down' };
        const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(prompt)?.[0] ?? '';
        return { ok: true, text: minutesText(id, coverage) };
      },
    };
    pipeline = new MinutesPipeline({
      sessionStore: sessions,
      workingMemory: memory,
      repo,
      agendaStore: agendas,
      llm,
      taskRepo: tasks,
      contactService: { getContact: async () => undefined } as unknown as ContactService,
      bus,
      timezone: () => TZ,
      hasActiveWake: async (taskId) => activeWakes.has(taskId),
      logger,
    });
    const scheduler = {
      enqueueTaskWake: async (params: { taskId: string }) => {
        activeWakes.add(params.taskId);
        return { jobId: 'wake-1' };
      },
    } as unknown as SchedulerService;
    new MinutesReadySubscriber({
      bus,
      taskRepo: tasks,
      schedulerService: scheduler,
      logger,
      pool: publicPool,
      hasActiveWake: async (taskId) => activeWakes.has(taskId),
      appOrigin: 'https://office.example',
      httpPort: 3000,
    }).start();
  });

  afterAll(async () => {
    if (sessionIds.length > 0) {
      await publicPool.query('DELETE FROM working_memory WHERE conversation_id = ANY($1::text[])', [
        sessionIds.map((id) => `meetings-2322:${id}`),
      ]);
      await publicPool.query('DELETE FROM scheduled_jobs WHERE task_id IN (SELECT id FROM tasks WHERE created_by = $1)', ['meetings']);
      await publicPool.query('DELETE FROM tasks WHERE created_by = $1', ['meetings']);
      await publicPool.query('DELETE FROM voice_sessions WHERE id = ANY($1::uuid[])', [sessionIds]);
    }
    await isolated?.drop();
    await publicPool?.end();
  });

  async function spokenCall(endReason = 'remote_hangup'): Promise<{ sessionId: string; agendaId: string }> {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    const parked = await agendas.park({
      title: 'Board',
      topics: ['runway'],
      context: 'Cover runway.',
      source: 'principal',
      sensitivity: 'internal',
      expiresAt: new Date(Date.now() + 7 * DAY),
      scheduledFor: null,
      role: null,
    }, new Date());
    const session = await sessions.create({
      id: sessionId,
      conversationId: `meetings-2322:${sessionId}`,
      livekitRoom: `meetings-2322:${sessionId}`,
    });
    const locked = await agendas.lock(parked.agendaId, sessionId, new Date());
    if (!locked.ok) throw new Error(locked.reason);
    await sessions.appendAgendaLoad(sessionId, {
      agendaId: parked.agendaId,
      loadedAt: session.startedAt.toISOString(),
      snapshot: agendaSnapshot(locked.agenda),
    });
    await memory.addTurn(`meetings-2322:${sessionId}`, 'coordinator', { role: 'user', content: 'Let us cover runway.' }, {
      createdAt: new Date(session.startedAt.getTime() + 1000),
    });
    await memory.addTurn(`meetings-2322:${sessionId}`, 'coordinator', { role: 'assistant', content: 'Runway is fine.' }, {
      createdAt: new Date(session.startedAt.getTime() + 2000),
    });
    // Stay `starting` so a parallel recovery sweep, which only reruns ended
    // sessions, does not settle this agenda in another schema.
    await publicPool.query(
      `UPDATE voice_sessions SET end_reason = $2, ended_at = NOW() WHERE id = $1`,
      [sessionId, endReason],
    );
    return { sessionId, agendaId: parked.agendaId };
  }

  it('writes transcript and minutes once and publishes minutes.ready', async () => {
    coverage = 'partial';
    llmOk = true;
    const { sessionId } = await spokenCall();
    const session = await sessions.get(sessionId);
    expect(await pipeline.run(sessionId)).toBe('completed');
    expect(await pipeline.run(sessionId)).toBe('completed');
    const minutes = await repo.read(minutesPath(sessionId, session!.startedAt, TZ));
    const transcript = await repo.read(transcriptPath(sessionId));
    expect(minutes?.body).toContain('discussed the topic');
    expect(transcript?.frontmatter.ttl_days).toBe(14);
    expect(ready.filter((event) => event.payload.sessionId === sessionId)).toHaveLength(1);
    const tagged = await tasks.listTasks({ tag: `meeting-minutes:${sessionId}` });
    expect(tagged).toHaveLength(1);
  });

  it('dropped call still produces minutes', async () => {
    coverage = 'partial';
    const { sessionId } = await spokenCall('remote_hangup');
    expect(await pipeline.run(sessionId)).toBe('completed');
    const session = await sessions.get(sessionId);
    expect(session?.endReason).toBe('remote_hangup');
    const transcript = await repo.read(transcriptPath(sessionId));
    expect(transcript?.frontmatter.end_reason).toBe('remote_hangup');
    expect(transcript?.body).toContain('**Caller:**');
  });

  it('hijacked call returns the agenda with history', async () => {
    coverage = 'not_reached';
    const { sessionId, agendaId } = await spokenCall();
    expect(await pipeline.run(sessionId)).toBe('completed');
    const agenda = await agendas.get(agendaId);
    expect(agenda?.status).toBe('pending');
    expect(agenda?.history[0]?.topics).toEqual([{ topic: 'runway', coverage: 'not_reached' }]);
  });

  it('fully covered agenda is done and archived', async () => {
    coverage = 'covered';
    const { sessionId, agendaId } = await spokenCall();
    expect(await pipeline.run(sessionId)).toBe('completed');
    expect(await agendas.get(agendaId)).toBeNull();
  });

  async function lateLoadCall(spokeBefore: boolean): Promise<{ sessionId: string; agendaId: string; startedAt: Date }> {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    const parked = await agendas.park({
      title: 'Silent',
      topics: ['runway'],
      context: 'Nothing said.',
      source: 'principal',
      sensitivity: 'internal',
      expiresAt: new Date(Date.now() + 7 * DAY),
      scheduledFor: null,
      role: null,
    }, new Date());
    const session = await sessions.create({
      id: sessionId,
      conversationId: `meetings-2322:${sessionId}`,
      livekitRoom: `meetings-2322:${sessionId}`,
    });
    const locked = await agendas.lock(parked.agendaId, sessionId, new Date());
    if (!locked.ok) throw new Error(locked.reason);
    await sessions.appendAgendaLoad(sessionId, {
      agendaId: parked.agendaId,
      loadedAt: new Date(session.startedAt.getTime() + 60_000).toISOString(),
      snapshot: agendaSnapshot(locked.agenda),
    });
    if (spokeBefore) {
      await memory.addTurn(`meetings-2322:${sessionId}`, 'coordinator', { role: 'user', content: 'Move my brief to 8:45, and pull up the board agenda.' }, {
        createdAt: session.startedAt,
      });
    }
    await publicPool.query(
      `UPDATE voice_sessions SET end_reason = 'remote_hangup', ended_at = NOW() WHERE id = $1`,
      [sessionId],
    );
    return { sessionId, agendaId: parked.agendaId, startedAt: session.startedAt };
  }

  it('caller who never spoke returns the agenda without minutes', async () => {
    const { sessionId, agendaId, startedAt } = await lateLoadCall(false);
    expect(await pipeline.run(sessionId)).toBe('returned_unused');
    expect(await repo.read(minutesPath(sessionId, startedAt, TZ))).toBeNull();
    const agenda = await agendas.get(agendaId);
    expect(agenda?.status).toBe('pending');
    expect(agenda?.history).toEqual([]);
  });

  // #2347: an instruction spoken before a last-moment load still needs the
  // follow-up task, and only minutes start it. The agenda still returns to pending.
  it('caller who spoke only before a late load still gets minutes', async () => {
    coverage = 'not_reached';
    llmOk = true;
    const { sessionId, agendaId, startedAt } = await lateLoadCall(true);
    expect(await pipeline.run(sessionId)).toBe('completed');
    expect(await repo.read(minutesPath(sessionId, startedAt, TZ))).not.toBeNull();
    expect(ready.filter((event) => event.payload.sessionId === sessionId)).toHaveLength(1);
    const agenda = await agendas.get(agendaId);
    expect(agenda?.status).toBe('pending');
    expect(agenda?.history[0]?.topics).toEqual([{ topic: 'runway', coverage: 'not_reached' }]);
  });


  it('minutes LLM failure publishes minutes.pipeline_failed and leaves the agenda in_call', async () => {
    llmOk = false;
    const { sessionId, agendaId } = await spokenCall();
    expect(await pipeline.run(sessionId)).toBe('failed');
    llmOk = true;
    expect(failed).toContain(sessionId);
    const agenda = await agendas.get(agendaId);
    expect(agenda?.status).toBe('in_call');
    const session = await sessions.get(sessionId);
    expect(await repo.read(minutesPath(sessionId, session!.startedAt, TZ))).toBeNull();
  });

  it('republishes minutes.ready for a tagged task that cannot run yet', async () => {
    coverage = 'partial';
    llmOk = true;
    const { sessionId } = await spokenCall();
    const created = await tasks.createTask({
      agentId: 'coordinator',
      owner: 'curia',
      source: 'scheduler',
      createdBy: 'meetings',
      title: 'Follow up on meeting minutes',
      tags: [`meeting-minutes:${sessionId}`],
      originator: makeSystemOriginator(),
    });
    expect(await pipeline.run(sessionId)).toBe('completed');
    expect(ready.filter((event) => event.payload.sessionId === sessionId)).toHaveLength(1);
    const listed = await tasks.listTasks({ tag: `meeting-minutes:${sessionId}` });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
    expect(readActiveSkillNames(listed[0]!.progress)).toEqual(['meetings']);
  });

  it('does not republish when the tagged task already has the skill and a wake', async () => {
    coverage = 'partial';
    llmOk = true;
    const { sessionId } = await spokenCall();
    const created = await tasks.createTask({
      agentId: 'coordinator',
      owner: 'curia',
      source: 'scheduler',
      createdBy: 'meetings',
      title: 'Follow up on meeting minutes',
      tags: [`meeting-minutes:${sessionId}`],
      originator: makeSystemOriginator(),
    });
    const written = await tasks.setActiveSkillsBlock(
      created.id,
      replaceActiveSkillsBlock(['meetings']),
    );
    expect('ok' in written && written.ok === false).toBe(false);
    activeWakes.add(created.id);
    expect(await pipeline.run(sessionId)).toBe('completed');
    expect(ready.filter((event) => event.payload.sessionId === sessionId)).toHaveLength(0);
  });

  it('session without agenda loads is skipped', async () => {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    await sessions.create({
      id: sessionId,
      conversationId: `meetings-2322:${sessionId}`,
      livekitRoom: `meetings-2322:${sessionId}`,
    });
    expect(await pipeline.run(sessionId)).toBe('skipped');
  });
});
