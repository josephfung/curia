// subscribers.ts — session end starts the pipeline; minutes.ready wakes one task (#2322).
//
// The session-ended handler must not await the pipeline. Bus delivery is
// sequential and waits for each handler, and a minutes write must not hold
// up call teardown. The minutes.ready handler does await task creation, so a
// second pipeline run in the same publish sees the dedupe tag.

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import { createMinutesPipelineFailed } from '../bus/events.js';
import { makeSystemOriginator } from '../contacts/principal.js';
import { isPgUniqueViolation } from '../agents/resumable-continuation.js';
import { readActiveSkillNames, replaceActiveSkillsBlock } from '../db/active-skills-progress.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { Logger } from '../logger.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import {
  documentConsoleUrl,
  hasMinutesTaskNote,
  isTerminalMinutesTask,
  MINUTES_FOLLOW_UP_SKILL,
  minutesTaskNeedsRepair,
  minutesTaskNote,
  withMinutesTaskLock,
} from './minutes-task.js';
import type { MinutesPipeline } from './minutes-pipeline.js';
import type { MinutesRecap } from './types.js';

export class MeetingSessionEndedSubscriber {
  constructor(private readonly opts: { bus: EventBus; pipeline: MinutesPipeline; logger: Logger }) {}

  start(): void {
    this.opts.bus.subscribe('voice.session.ended', 'system', (event) => {
      if (event.type !== 'voice.session.ended') return;
      const sessionId = event.payload.sessionId;
      void this.opts.pipeline.run(sessionId).catch((err: unknown) => {
        this.opts.logger.error({ err, sessionId }, 'meeting pipeline: run rejected');
      });
    });
  }
}

export class MinutesReadySubscriber {
  constructor(private readonly opts: {
    bus: EventBus;
    taskRepo: TaskRepo;
    schedulerService: SchedulerService;
    logger: Logger;
    /** Same connection pool the task repo uses, so the claim lock is real. */
    pool: Pool;
    /** Pending or running wake. Do not infer this from nextWakeAt. */
    hasActiveWake: (taskId: string) => Promise<boolean>;
    /** Office origin for the minutes link (config.appOrigin); localhost on httpPort when unset. */
    appOrigin: string | undefined;
    httpPort: number;
  }) {}

  start(): void {
    this.opts.bus.subscribe('minutes.ready', 'system', (event) => {
      if (event.type !== 'minutes.ready') return;
      return this.handle(event.payload);
    });
  }

  private async handle(payload: {
    minutesRef: string;
    sessionId: string;
    sources: Array<'principal' | 'routine' | 'coordinator' | 'ad_hoc'>;
    sensitivity: 'internal' | 'confidential' | 'shareable';
    recap: MinutesRecap;
  }): Promise<void> {
    const tag = `meeting-minutes:${payload.sessionId}`;
    try {
      await withMinutesTaskLock(this.opts.pool, tag, async () => {
        const existing = await this.opts.taskRepo.listTasks({ tag });
        const reusable = existing.filter((task) => !isTerminalMinutesTask(task.status));
        for (const task of reusable) {
          const active = await this.opts.hasActiveWake(task.id);
          if (!minutesTaskNeedsRepair(task, active)) return;
        }
        if (reusable.length === 0 && existing.length > 0) return;

        const originator = makeSystemOriginator();
        const minutesUrl = documentConsoleUrl(this.opts.appOrigin, this.opts.httpPort, payload.minutesRef);
        const note = minutesTaskNote({ minutesRef: payload.minutesRef, minutesUrl, recap: payload.recap });
        const reused = reusable[0];
        // A task created before #2347 has no note, so its wake would not see the path.
        if (reused && !hasMinutesTaskNote(reused.progress, payload.minutesRef)) {
          await this.opts.taskRepo.updateTask(reused.id, { progressNote: note });
        }
        const task = reused ?? await this.opts.taskRepo.createTask({
          agentId: 'coordinator',
          owner: 'curia',
          source: 'scheduler',
          createdBy: 'meetings',
          title: 'Follow up on meeting minutes',
          description: [
            `minutesRef: ${payload.minutesRef}`,
            `sources: ${payload.sources.join(', ')}`,
            `sensitivity: ${payload.sensitivity}`,
          ].join('\n'),
          // The wake shows progress, not the description (#2347).
          progressNote: note,
          tags: [tag],
          originator,
        });
        if (!readActiveSkillNames(task.progress).includes(MINUTES_FOLLOW_UP_SKILL)) {
          const written = await this.opts.taskRepo.setActiveSkillsBlock(
            task.id,
            replaceActiveSkillsBlock([MINUTES_FOLLOW_UP_SKILL]),
          );
          if ('ok' in written && written.ok === false) {
            throw new Error('message' in written ? written.message : written.code);
          }
        }
        if (await this.opts.hasActiveWake(task.id)) return;
        try {
          await this.opts.schedulerService.enqueueTaskWake({
            taskId: task.id,
            agentId: 'coordinator',
            runAt: new Date(),
            createdBy: 'meetings',
            originator,
          });
        } catch (err) {
          if (isPgUniqueViolation(err) && await this.opts.hasActiveWake(task.id)) return;
          throw err;
        }
      });
    } catch (err) {
      this.opts.logger.error({ err, sessionId: payload.sessionId }, 'meeting minutes: structuring task failed');
      try {
        await this.opts.bus.publish('system', createMinutesPipelineFailed({
          sessionId: payload.sessionId,
          stage: 'structuring',
          error: err instanceof Error ? err.message : String(err),
        }));
      } catch (publishErr) {
        this.opts.logger.error(
          { err: publishErr, sessionId: payload.sessionId },
          'meeting minutes: failed to publish structuring failure',
        );
      }
    }
  }
}
