// src/contacts/dedup-tasks.ts
//
// Housekeeping for the dedup review queue (#2493). The weekly scan used to only file
// tasks, so the queue collected tasks whose pair had already been settled some other
// way: a contact merged away by a combined "merge all five" decision, a pair excluded
// from a sibling task, the same pair filed twice. Those sat `blocked` or `waiting` on
// the principal indefinitely. Everything here runs in code, before any task is filed,
// so the queue the agent and the principal see only holds live questions.

import type { Logger } from '../logger.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { TaskRow } from '../db/queries/tasks.js';
import type { Contact } from './types.js';
import { canonicalPairKey, pairKeyFromDedupTask } from './dedup-pair-key.js';
import {
  DEDUP_ROUTE_TAG_PREFIX,
  dedupReviewRoute,
  dedupRouteTag,
  routeFromTags,
} from './dedup-routing.js';

/** Task statuses that count as an open review. */
export const OPEN_DEDUP_TASK_STATUSES = ['open', 'in_progress', 'waiting', 'blocked'];

const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

/** The agent id recorded on task events this module writes. */
const AGENT_ID = 'contacts';

export type DedupTaskRepo = Pick<TaskRepo, 'listTasks' | 'getTask' | 'completeTask' | 'updateTask'>;

export interface ReconcileOpenDedupTasksInput {
  taskRepo: DedupTaskRepo;
  /** Open dedup-tagged tasks, oldest first is not required. */
  openTasks: readonly TaskRow[];
  /** Every live contact, by id. A task naming a contact absent from this map is stale. */
  contactsById: ReadonlyMap<string, Contact>;
  /** Canonical pair keys with a recorded exclusion. */
  excludedPairKeys: ReadonlySet<string>;
  log: Logger;
}

export interface ReconcileOpenDedupTasksResult {
  /** Tasks completed because their pair was already settled or filed twice. */
  closed: number;
  /** Owner-ceo tasks handed back to Curia because the pair is not the principal's to decide. */
  reassigned: number;
  /** Tasks whose blocker had already closed, set back to open. */
  unblocked: number;
  /** Pair keys that still have an open task after reconciliation. */
  openPairKeys: Set<string>;
  /** Tasks whose update failed; they are retried on the next scan. */
  failed: number;
}

/**
 * Settle the open dedup queue against the current contacts and exclusions.
 *
 * - A task naming a contact that no longer exists is completed (its contact was merged
 *   into another one, or deleted).
 * - A task whose pair has an exclusion is completed.
 * - A second open task for a pair is completed in favour of the oldest.
 * - A task routed to Curia (see dedupReviewRoute) that sits with the principal is handed
 *   back to Curia. Every surviving task carries the pair's current route tag.
 * - A task blocked on a task that has since closed is reopened.
 *
 * Errors on one task are logged and counted; the rest still run.
 */
export async function reconcileOpenDedupTasks(
  input: ReconcileOpenDedupTasksInput,
): Promise<ReconcileOpenDedupTasksResult> {
  const { taskRepo, contactsById, excludedPairKeys, log } = input;
  const result: ReconcileOpenDedupTasksResult = {
    closed: 0, reassigned: 0, unblocked: 0, openPairKeys: new Set(), failed: 0,
  };

  // Oldest first, so the task kept for a pair filed twice is the one with history on it.
  const tasks = [...input.openTasks].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const keptTaskByPair = new Map<string, string>();

  for (const task of tasks) {
    const key = pairKeyFromDedupTask(task);
    // A dedup-tagged task with no parseable pair is left alone; the scan logs the count.
    if (!key) continue;
    const [aId, bId] = key.split(':') as [string, string];
    const a = contactsById.get(aId);
    const b = contactsById.get(bId);

    try {
      let closeNote: string | null = null;
      if (!a || !b) {
        closeNote = 'Closed by the dedup scan: one of these contacts no longer exists '
          + '(merged into another contact or deleted), so there is nothing left to decide.';
      } else if (excludedPairKeys.has(key)) {
        closeNote = 'Closed by the dedup scan: this pair is already recorded as not a duplicate.';
      } else if (keptTaskByPair.has(key)) {
        closeNote = `Closed by the dedup scan: duplicate of task ${keptTaskByPair.get(key)} for the same pair.`;
      }
      if (closeNote) {
        await taskRepo.completeTask(task.id, closeNote, AGENT_ID);
        result.closed++;
        log.info({ taskId: task.id, pairKey: key, closeNote }, 'dedup-tasks: closed settled review task');
        continue;
      }

      keptTaskByPair.set(key, task.id);
      result.openPairKeys.add(key);

      // a and b are defined here: the !a || !b branch above always continues.
      const route = dedupReviewRoute(a!, b!);
      const tagsNeedUpdate = routeFromTags(task.tags) !== route;
      const handBack = route === 'curia' && task.owner === 'ceo';
      const blockerClosed = task.status === 'blocked' && task.blockedByTaskId !== null
        && await isTerminal(taskRepo, task.blockedByTaskId);

      if (!tagsNeedUpdate && !handBack && !blockerClosed) continue;

      const tags = tagsNeedUpdate
        ? [...task.tags.filter(t => !t.startsWith(DEDUP_ROUTE_TAG_PREFIX)), dedupRouteTag(route)]
        : undefined;
      const notes: string[] = [];
      if (handBack) {
        notes.push('Handed back to Curia by the dedup scan: neither contact is a person the '
          + 'principal has marked known or trusted, so Curia decides this pair (merge or keep separate).');
      }
      if (blockerClosed) {
        notes.push(`Unblocked by the dedup scan: task ${task.blockedByTaskId} has closed and this pair is still undecided.`);
      }
      await taskRepo.updateTask(
        task.id,
        {
          ...(tags && { tags }),
          ...(handBack && { owner: 'curia', status: 'open' }),
          ...(blockerClosed && { status: 'open', blockedByTaskId: null }),
          ...(notes.length > 0 && { progressNote: notes.join(' ') }),
        },
        AGENT_ID,
      );
      if (handBack) result.reassigned++;
      if (blockerClosed) result.unblocked++;
      log.info({ taskId: task.id, pairKey: key, route, handBack, blockerClosed }, 'dedup-tasks: updated review task');
    } catch (err) {
      result.failed++;
      // A failed close leaves the pair counted as open, so the scan does not file it again.
      result.openPairKeys.add(key);
      log.error({ err, taskId: task.id, pairKey: key }, 'dedup-tasks: failed to reconcile review task — retried next scan');
    }
  }

  return result;
}

async function isTerminal(taskRepo: DedupTaskRepo, taskId: string): Promise<boolean> {
  const blocker = await taskRepo.getTask(taskId);
  // A blocker that no longer exists blocks nothing.
  return blocker === null || TERMINAL_STATUSES.has(blocker.status);
}

/**
 * After a merge, complete the open review tasks that named the merged-away contact
 * (#2493). A combined decision ("merge all five") is carried out as several merges, and
 * each one strands every sibling task that names the contact it folded away. Those are
 * closed here, in the same pass, rather than waiting for the next weekly scan.
 *
 * The task for the merged pair itself is left for the agent to complete with its own
 * outcome note, unless `includeMergedPair` is set (the scan's automatic merges, where no
 * agent is working that task). Returns how many tasks were closed; never throws.
 */
export async function closeDedupTasksForMergedContact(
  taskRepo: DedupTaskRepo,
  merge: { survivorId: string; secondaryId: string; survivorName: string },
  log: Logger,
  options?: { includeMergedPair?: boolean },
): Promise<number> {
  const mergedPairKey = canonicalPairKey(merge.survivorId, merge.secondaryId);
  const secondary = merge.secondaryId.toLowerCase();
  let closed = 0;
  try {
    const openTasks = await taskRepo.listTasks({
      statuses: OPEN_DEDUP_TASK_STATUSES,
      tag: 'dedup',
      limit: 1000,
    });
    for (const task of openTasks) {
      const key = pairKeyFromDedupTask(task);
      if (!key || !key.split(':').includes(secondary)) continue;
      if (key === mergedPairKey && !options?.includeMergedPair) continue;
      try {
        await taskRepo.completeTask(
          task.id,
          key === mergedPairKey
            ? `Closed: these contacts were merged into ${merge.survivorName} (${merge.survivorId}).`
            : `Closed: contact ${secondary} was merged into ${merge.survivorName} (${merge.survivorId}), `
              + 'so this pair no longer exists. A later dedup scan re-checks the survivor.',
          AGENT_ID,
        );
        closed++;
      } catch (err) {
        log.warn({ err, taskId: task.id }, 'dedup-tasks: could not close a review task stranded by a merge — the next scan closes it');
      }
    }
  } catch (err) {
    log.warn({ err, ...merge }, 'dedup-tasks: could not list review tasks after a merge — the next scan closes stranded ones');
  }
  if (closed > 0) log.info({ ...merge, closed }, 'dedup-tasks: closed review tasks stranded by a merge');
  return closed;
}
