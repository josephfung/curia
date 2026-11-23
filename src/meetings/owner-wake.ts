// owner-wake.ts — wake an agenda's owner task when its calendar event changes (#2360).
//
// The agenda event sync tells the owner task when the event is cancelled, about to
// start, missed or unreadable: a progress note on the task, then a coordinator wake.
// The owner id comes from agenda frontmatter, which the console can edit, so only an
// existing open coordinator task is woken, never an arbitrary one.

import { isPgUniqueViolation } from '../agents/resumable-continuation.js';
import { makeSystemOriginator } from '../contacts/principal.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { Logger } from '../logger.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';

/** Statuses a task never leaves; a task in one is not woken. Mirrors TaskRepo's guard. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'cancelled']);
const OWNER_AGENT = 'coordinator';
const CREATED_BY = 'meetings';

export interface AgendaOwnerWakeDeps {
  taskRepo: Pick<TaskRepo, 'getTask' | 'updateTask'>;
  scheduler: Pick<SchedulerService, 'enqueueTaskWake'>;
  logger: Logger;
}

/**
 * Add `note` to the owner task's progress and wake the coordinator on it now. A task that
 * is missing, closed or not the coordinator's is left alone, with a warning. A wake already
 * pending for the task (unique violation) is as good as a new one.
 */
export async function wakeAgendaOwner(deps: AgendaOwnerWakeDeps, taskId: string, note: string): Promise<void> {
  const task = await deps.taskRepo.getTask(taskId);
  if (!task || TERMINAL_STATUSES.has(task.status) || task.agentId !== OWNER_AGENT) {
    deps.logger.warn({ taskId }, 'agenda event sync: owner is not an open coordinator task, not waking it');
    return;
  }
  await deps.taskRepo.updateTask(task.id, { progressNote: note });
  try {
    await deps.scheduler.enqueueTaskWake({
      taskId: task.id,
      agentId: OWNER_AGENT,
      runAt: new Date(),
      createdBy: CREATED_BY,
      originator: makeSystemOriginator(),
    });
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      deps.logger.debug({ taskId: task.id }, 'agenda event sync: a coordinator wake is already pending');
      return;
    }
    throw err;
  }
}
