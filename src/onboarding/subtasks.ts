// subtasks.ts — reading the onboarding task's topic subtasks (#2360).
//
// Each topic subtask is tagged `onboarding:topic:<topicId>` and `onboarding:session:<sessionId>`
// and created by the onboarding program. The model can tag any task, so only subtasks whose
// createdBy is the onboarding program count as topics.

import type { TaskRepo } from '../db/task-repo.js';
import type { TaskRow } from '../db/queries/tasks.js';
import type { Logger } from '../logger.js';
import { ONBOARDING_CREATED_BY, REVIEW_DOCUMENT_TOPICS, REVIEW_NEXT_STEP_TOPIC, REVIEW_SESSION } from './constants.js';

const TOPIC_TAG_PREFIX = 'onboarding:topic:';
const SESSION_TAG_PREFIX = 'onboarding:session:';
const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

/** The inbox topic: triage may be released only once it is done. */
export const INBOX_EXPECTATIONS_TOPIC = 'inbox-expectations';
/** The last session: onboarding completes once its topics, and every other subtask, are done. */
export const ONGOING_RHYTHM_SESSION = 'ongoing-rhythm';
/** The recurring session after onboarding: never opened as onboarding subtasks. */
export const RECURRING_SESSION = 'weekly';
/** Tag on a topic subtask the principal declined (completed, but nothing was applied). */
export const DECLINED_TAG = 'onboarding:declined';
/**
 * A topic id as the playbook parser produces it. Ids ride into live principal turns (the onboarding
 * turn block), and the tag a model can rewrite with task-update is where they are read from, so
 * they are checked here, at the point of use.
 */
const TOPIC_ID_RE = /^[a-z0-9-]{1,64}$/;

/** Upper bound on children read for one onboarding task; the default playbook has under 25. */
const CHILD_LIMIT = 500;

export type TopicSubtask = { task: TaskRow; topicId: string; sessionId: string | null };

function tagValue(tags: readonly string[], prefix: string): string | null {
  const tag = tags.find((t) => t.startsWith(prefix));
  return tag ? tag.slice(prefix.length) : null;
}

export function isOpenTask(task: Pick<TaskRow, 'status'>): boolean {
  return !TERMINAL_STATUSES.has(task.status);
}

/** Every child of the onboarding task, whoever created it. */
export function listChildren(taskRepo: Pick<TaskRepo, 'listTasks'>, parentTaskId: string): Promise<TaskRow[]> {
  return taskRepo.listTasks({ parentTaskId, limit: CHILD_LIMIT });
}

/**
 * The children that are onboarding topic subtasks. A topic tag whose id is not `[a-z0-9-]{1,64}`
 * was not written by the program (a model can edit task tags): that subtask is dropped, with a warn.
 */
export function topicSubtasks(children: readonly TaskRow[], logger?: Pick<Logger, 'warn'>): TopicSubtask[] {
  const out: TopicSubtask[] = [];
  for (const task of children) {
    if (task.createdBy !== ONBOARDING_CREATED_BY) continue;
    const topicId = tagValue(task.tags, TOPIC_TAG_PREFIX);
    if (!topicId) continue;
    if (!TOPIC_ID_RE.test(topicId)) {
      logger?.warn({ taskId: task.id }, 'onboarding: topic subtask has an invalid topic id tag — ignored');
      continue;
    }
    out.push({ task, topicId, sessionId: tagValue(task.tags, SESSION_TAG_PREFIX) });
  }
  return out;
}

/**
 * Whether the onboarding task's Review document topics are still to come: none opened, or one open.
 * A playbook seeded before the document topics existed (walk-drafts) is judged on its other Review
 * topics, as the onboarding-progress tool completes a standalone review task on them.
 */
export async function reviewStillAhead(
  taskRepo: Pick<TaskRepo, 'listTasks'>,
  onboardingTaskId: string,
  logger?: Pick<Logger, 'warn'>,
): Promise<boolean> {
  const review = topicSubtasks(await listChildren(taskRepo, onboardingTaskId), logger).filter(
    (t) => t.sessionId === REVIEW_SESSION,
  );
  let deciding = review.filter((t) => (REVIEW_DOCUMENT_TOPICS as readonly string[]).includes(t.topicId));
  if (deciding.length === 0) deciding = review.filter((t) => t.topicId !== REVIEW_NEXT_STEP_TOPIC);
  return deciding.length === 0 || deciding.some((t) => isOpenTask(t.task));
}
