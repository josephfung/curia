import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { EventBus } from '../../../src/bus/bus.js';
import { createMinutesReady, createVoiceSessionEnded } from '../../../src/bus/events.js';
import { readActiveSkillNames, replaceActiveSkillsBlock } from '../../../src/db/active-skills-progress.js';
import type { ActiveSkillsBlock } from '../../../src/db/active-skills-progress.js';
import type { TaskRepo } from '../../../src/db/task-repo.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { Logger } from '../../../src/logger.js';
import { MINUTES_FOLLOW_UP_SKILL } from '../../../src/meetings/minutes-task.js';
import type { MinutesPipeline } from '../../../src/meetings/minutes-pipeline.js';
import { MeetingSessionEndedSubscriber, MinutesReadySubscriber } from '../../../src/meetings/subscribers.js';
import type { SchedulerService } from '../../../src/scheduler/scheduler-service.js';

describe('MeetingSessionEndedSubscriber', () => {
  it('voice.session.ended handler returns before the pipeline settles', async () => {
    let release!: () => void;
    let started = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pipeline = {
      run: () => {
        started = true;
        return gate.then(() => 'completed' as const);
      },
    } as unknown as MinutesPipeline;
    const bus = new EventBus(createSilentLogger());
    new MeetingSessionEndedSubscriber({ bus, pipeline, logger: createSilentLogger() }).start();

    await bus.publish('system', createVoiceSessionEnded({
      sessionId: 'sess',
      conversationId: 'voice:sess',
      reason: 'remote_hangup',
    }));

    expect(started).toBe(true);
    release();
    await gate;
  });

  it('a rejected pipeline run is logged, not thrown', async () => {
    const error = vi.fn();
    const logger = { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as Logger;
    const pipeline = {
      run: async () => {
        throw new Error('boom');
      },
    } as unknown as MinutesPipeline;
    const bus = new EventBus(createSilentLogger());
    new MeetingSessionEndedSubscriber({ bus, pipeline, logger }).start();

    await expect(bus.publish('system', createVoiceSessionEnded({
      sessionId: 'sess',
      conversationId: 'voice:sess',
      reason: 'remote_hangup',
    }))).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(error).toHaveBeenCalled();
  });
});

function fakePool(): Pool {
  const client = {
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
  };
  return { connect: async () => client } as unknown as Pool;
}

function task(overrides: { id?: string; status?: string; progress?: Record<string, unknown> } = {}) {
  return {
    id: overrides.id ?? 'task-1',
    status: overrides.status ?? 'open',
    progress: overrides.progress ?? {},
  };
}

describe('MinutesReadySubscriber', () => {
  const payload = {
    minutesRef: '/meetings/minutes/2026-10-28-sess.md',
    sessionId: 'sess',
    conversationId: 'voice:sess',
    sources: ['principal' as const],
    sensitivity: 'internal' as const,
    recap: 'not_earned' as const,
  };

  function start(opts: {
    tasks: Array<ReturnType<typeof task>>;
    hasActiveWake?: (taskId: string) => Promise<boolean>;
    enqueue?: () => Promise<{ jobId: string }>;
  }) {
    const failed: string[] = [];
    const created: string[] = [];
    const createParams: Array<{ progressNote?: string }> = [];
    const appended: Array<{ taskId: string; progressNote?: string }> = [];
    const skills: string[] = [];
    const skillBlocks: string[][] = [];
    const wakes: string[] = [];
    const bus = new EventBus(createSilentLogger());
    bus.subscribe('minutes.pipeline_failed', 'system', (event) => {
      if (event.type === 'minutes.pipeline_failed') failed.push(event.payload.sessionId);
    });
    const taskRepo = {
      listTasks: async () => opts.tasks,
      createTask: async (params: { progressNote?: string }) => {
        createParams.push(params);
        const createdTask = task({ id: 'created-1' });
        opts.tasks.push(createdTask);
        created.push(createdTask.id);
        return createdTask;
      },
      updateTask: async (taskId: string, updates: { progressNote?: string }) => {
        appended.push({ taskId, progressNote: updates.progressNote });
        return task({ id: taskId });
      },
      setActiveSkillsBlock: async (taskId: string, block: ActiveSkillsBlock) => {
        skills.push(taskId);
        skillBlocks.push(readActiveSkillNames({ activeSkills: block }));
        return { task: task({ id: taskId }), block: replaceActiveSkillsBlock([MINUTES_FOLLOW_UP_SKILL]) };
      },
    } as unknown as TaskRepo;
    const scheduler = {
      enqueueTaskWake: async (params: { taskId: string }) => {
        wakes.push(params.taskId);
        if (opts.enqueue) return opts.enqueue();
        return { jobId: 'wake-1' };
      },
    } as unknown as SchedulerService;
    new MinutesReadySubscriber({
      bus,
      taskRepo,
      schedulerService: scheduler,
      logger: createSilentLogger(),
      pool: fakePool(),
      hasActiveWake: opts.hasActiveWake ?? (async () => false),
      appOrigin: 'https://office.example',
      httpPort: 3000,
    }).start();
    return { bus, failed, created, createParams, appended, skills, skillBlocks, wakes };
  }

  it('restores the skill and enqueues one wake for an existing open task', async () => {
    const existing = task();
    const { bus, created, skills, wakes, failed } = start({ tasks: [existing] });
    await bus.publish('system', createMinutesReady(payload));
    expect(created).toEqual([]);
    expect(skills).toEqual(['task-1']);
    expect(wakes).toEqual(['task-1']);
    expect(failed).toEqual([]);
  });

  it('leaves a task that already has the skill and an active wake', async () => {
    const existing = task({
      progress: {
        activeSkills: {
          skills: [{ name: MINUTES_FOLLOW_UP_SKILL, activatedAt: '2026-10-28T12:00:00.000Z' }],
        },
      },
    });
    const { bus, created, skills, wakes } = start({
      tasks: [existing],
      hasActiveWake: async () => true,
    });
    await bus.publish('system', createMinutesReady(payload));
    expect(created).toEqual([]);
    expect(skills).toEqual([]);
    expect(wakes).toEqual([]);
  });

  // #2400: the playbook moved into the meetings bundle. A task seeded before the
  // move names a skill that no longer exists, so repair re-seeds the bundle.
  it('re-seeds the meetings bundle on a task that still names the removed playbook', async () => {
    const existing = task({
      progress: {
        activeSkills: {
          skills: [{ name: 'meeting-minutes-structuring', activatedAt: '2026-10-28T12:00:00.000Z' }],
        },
      },
    });
    const { bus, skills, skillBlocks, wakes } = start({
      tasks: [existing],
      hasActiveWake: async () => true,
    });
    await bus.publish('system', createMinutesReady(payload));
    expect(skills).toEqual(['task-1']);
    expect(skillBlocks).toEqual([['meetings']]);
    expect(wakes).toEqual([]);
  });

  it('does not create or wake a terminal task', async () => {
    const { bus, created, skills, wakes } = start({
      tasks: [task({ status: 'done' })],
    });
    await bus.publish('system', createMinutesReady(payload));
    expect(created).toEqual([]);
    expect(skills).toEqual([]);
    expect(wakes).toEqual([]);
  });

  // #2347: the wake shows progress, not the description, so the path, the office
  // link and the send decision ride in the first progress note.
  it('seeds the new task with the minutes path, office link and recap decision', async () => {
    const { bus, created, createParams } = start({ tasks: [] });
    await bus.publish('system', createMinutesReady(payload));
    expect(created).toEqual(['created-1']);
    expect(createParams[0]?.progressNote).toBe([
      'Minutes for this call (read with doc-read): /meetings/minutes/2026-10-28-sess.md',
      'Link that opens them in the office: https://office.example/documents?path=%2Fmeetings%2Fminutes%2F2026-10-28-sess.md',
      'Recap: not earned. No agenda topic was covered and nobody asked for a recap.',
    ].join('\n'));
  });

  // A task created before #2347 has no note; its wake would not see the path.
  it('adds the note once to a reused task that lacks it', async () => {
    const { bus, created, appended } = start({ tasks: [task()] });
    await bus.publish('system', createMinutesReady(payload));
    expect(created).toEqual([]);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.progressNote).toContain('Minutes for this call (read with doc-read): /meetings/minutes/2026-10-28-sess.md');
  });

  it('does not add a second note to a reused task that already has it', async () => {
    const existing = task({
      progress: { notes: [{ at: '2026-10-28T12:00:00.000Z', note: 'Minutes for this call (read with doc-read): /meetings/minutes/2026-10-28-sess.md\n…' }] },
    });
    const { bus, appended } = start({ tasks: [existing] });
    await bus.publish('system', createMinutesReady(payload));
    expect(appended).toEqual([]);
  });

  it('treats a unique-violation as success when an active wake is already there', async () => {
    let checks = 0;
    const { bus, failed, wakes } = start({
      tasks: [],
      hasActiveWake: async () => {
        checks += 1;
        return checks > 1;
      },
      enqueue: async () => {
        throw Object.assign(new Error('dup'), { code: '23505' });
      },
    });
    await bus.publish('system', createMinutesReady(payload));
    expect(wakes).toEqual(['created-1']);
    expect(failed).toEqual([]);
  });
});
