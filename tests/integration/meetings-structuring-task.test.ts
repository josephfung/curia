import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { AuditLogger } from '../../src/audit/logger.js';
import { EventBus } from '../../src/bus/bus.js';
import { createMinutesReady } from '../../src/bus/events.js';
import { readActiveSkillNames } from '../../src/db/active-skills-progress.js';
import { TaskRepo } from '../../src/db/task-repo.js';
import { createLogger } from '../../src/logger.js';
import { MinutesReadySubscriber } from '../../src/meetings/subscribers.js';
import type { SchedulerService } from '../../src/scheduler/scheduler-service.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const SESSION = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describeIf('MinutesReadySubscriber (integration, #2322)', () => {
  let pool: pg.Pool;
  let tasks: TaskRepo;
  let bus: EventBus;
  const wakes: Array<{ taskId: string; agentId: string; createdBy?: string; originator?: { systemRole?: string } | null }> = [];
  const activeWakes = new Set<string>();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    const logger = createLogger('error');
    const audit = new AuditLogger(pool, logger);
    bus = new EventBus(logger, (event) => audit.log(event), (eventId) => audit.markAcknowledged(eventId));
    tasks = new TaskRepo(pool, bus, logger, 'America/Toronto');
    const scheduler = {
      enqueueTaskWake: vi.fn(async (params: { taskId: string; agentId: string; createdBy?: string; originator?: { systemRole?: string } | null }) => {
        wakes.push(params);
        activeWakes.add(params.taskId);
        return { jobId: 'wake-1' };
      }),
    } as unknown as SchedulerService;
    new MinutesReadySubscriber({
      bus,
      taskRepo: tasks,
      schedulerService: scheduler,
      logger,
      pool,
      hasActiveWake: async (taskId) => activeWakes.has(taskId),
      appOrigin: 'https://office.example',
      httpPort: 3000,
    }).start();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tasks WHERE created_by = $1', ['meetings']);
    await pool.end();
  });

  it('minutes.ready creates exactly one coordinator task with the tag, system originator and active skill, and enqueues a wake', async () => {
    const payload = {
      minutesRef: `/meetings/minutes/2026-10-28-${SESSION}.md`,
      sessionId: SESSION,
      conversationId: `voice:${SESSION}`,
      sources: ['principal' as const],
      sensitivity: 'internal' as const,
      recap: 'topic_covered' as const,
    };
    await bus.publish('system', createMinutesReady(payload));
    await bus.publish('system', createMinutesReady(payload));

    const listed = await tasks.listTasks({ tag: `meeting-minutes:${SESSION}` });
    expect(listed).toHaveLength(1);
    const task = listed[0]!;
    expect(task.agentId).toBe('coordinator');
    expect(task.owner).toBe('curia');
    expect(task.source).toBe('scheduler');
    expect(task.createdBy).toBe('meetings');
    expect(task.title).toBe('Follow up on meeting minutes');
    expect(task.description).toContain(payload.minutesRef);
    // The wake carries progress, not the description (#2347).
    const notes = (task.progress as { notes?: Array<{ note: string }> }).notes ?? [];
    expect(notes[0]?.note).toContain(payload.minutesRef);
    expect(notes[0]?.note).toContain(`https://office.example/documents?path=${encodeURIComponent(payload.minutesRef)}`);
    expect(notes[0]?.note).toContain('Recap: send one. At least one agenda topic was covered.');
    expect(task.originator?.systemRole).toBe('system');
    expect(readActiveSkillNames(task.progress)).toEqual(['meetings']);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      taskId: task.id,
      agentId: 'coordinator',
      createdBy: 'meetings',
      originator: { systemRole: 'system' },
    });
  });
});
