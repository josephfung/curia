// subtasks.ts — reading the onboarding task's topic subtasks (#2360).
//
// Each topic subtask is tagged `onboarding:topic:<topicId>` and `onboarding:session:<sessionId>`
// and created by the onboarding program. The model can tag any task, so only subtasks whose
// createdBy is the onboarding program count as topics.

import type { TaskRepo } from '../db/task-repo.js';
import type { TaskRow } from '../db/queries/tasks.js';
import { ONBOARDING_CREATED_BY } from './constants.js';

const TOPIC_TAG_PREFIX = 'onboarding:topic:';
const SESSION_TAG_PREFIX = 'onboarding:session:';
const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

/** The inbox topic: triage may be released only once it is done. */
export const INBOX_EXPECTATIONS_TOPIC = 'inbox-expectations';
/** The last session: onboarding completes once its topics, and every other subtask, are done. */
export const ONGOING_RHYTHM_SESSION = 'ongoing-rhythm';
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

/** The children that are onboarding topic subtasks. */
export function topicSubtasks(children: readonly TaskRow[]): TopicSubtask[] {
  const out: TopicSubtask[] = [];
  for (const task of children) {
    if (task.createdBy !== ONBOARDING_CREATED_BY) continue;
    const topicId = tagValue(task.tags, TOPIC_TAG_PREFIX);
    if (!topicId) continue;
    out.push({ task, topicId, sessionId: tagValue(task.tags, SESSION_TAG_PREFIX) });
  }
  return out;
}
