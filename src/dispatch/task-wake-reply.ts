// task-wake-reply.ts — bind principal replies back to originating tasks (#1299).
//
// Task-wake questions are sent from a scheduler conversation but replies arrive on
// Signal/email. Auto-registration on send attaches durable task binding metadata;
// the coordinator persists via context-bridge-release(reply) after judging relevance.

import type { Logger } from '../logger.js';
import { TaskTerminalStateError, type TaskRepo } from '../db/task-repo.js';
import type { OutboundContextCapability, OutboundContextRow } from './outbound-context.js';
import type { ContextBridgeInput } from './context-bridge-parse.js';

/** Metadata flag: inbound replies to this outbound entry must be persisted to a task. */
export const TASK_WAKE_BIND_REPLY_KEY = 'bind_reply';

/** Metadata field: originating task UUID for task-wake reply binding. */
export const TASK_WAKE_TASK_ID_KEY = 'task_id';

/** TTL for task-wake reply bindings — longer than any channel's auto-registration
 *  default, because the principal answers a task-wake question on their own schedule. */
export const TASK_WAKE_REPLY_TTL_HOURS = 168;

export function isTaskWakeReplyBinding(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!metadata) return false;
  return metadata[TASK_WAKE_BIND_REPLY_KEY] === true
    && typeof metadata[TASK_WAKE_TASK_ID_KEY] === 'string'
    && metadata[TASK_WAKE_TASK_ID_KEY].length > 0;
}

/** Build explicit context_bridge fields when a send originates from a bound task-wake turn. */
export function buildTaskWakeAutoBridge(opts: {
  taskId: string;
  agentId: string;
  messageContent: string;
}): ContextBridgeInput {
  const preview = opts.messageContent.replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    agent_id: opts.agentId,
    expected_reply: preview.length > 0
      ? `principal's reply to: ${preview}`
      : "principal's reply to the task question",
    metadata: {
      [TASK_WAKE_BIND_REPLY_KEY]: true,
      [TASK_WAKE_TASK_ID_KEY]: opts.taskId,
    },
    expires_in_hours: TASK_WAKE_REPLY_TTL_HOURS,
  };
}

/**
 * Task statuses a reply can no longer attach to. Matches the statuses whose end releases
 * the task's bindings in TaskRepo: done and cancelled are terminal, and failed is
 * abandoned work (#2312, #2592). A send never binds a reply to such a task either.
 */
export const ENDED_TASK_STATUSES: ReadonlySet<string> = new Set(['done', 'cancelled', 'failed']);

export interface TaskWakeReplyPersistResult {
  persisted: boolean;
  /**
   * True when the entry was released although nothing was written: the bound task no longer
   * exists or has already ended (#2592). Not a failure. There is nothing left to attach the
   * reply to, and keeping the entry active only lets it catch later, unrelated replies.
   */
  released?: boolean;
  /** Why a released entry's reply was not attached. Set only with `released`. */
  note?: string;
  taskId?: string;
  entryId?: string;
  error?: string;
}

type OutboundContextRelease = Pick<OutboundContextCapability, 'releaseEntry'>;

/**
 * Persist a principal reply on the task bound in entry metadata, then release the entry.
 * task_id is read from metadata — not from the coordinator. Called by
 * context-bridge-release when reply is provided for a task-wake binding.
 */
export async function recordTaskWakeReply(options: {
  reply: string;
  entryId: string;
  entry: OutboundContextRow;
  taskRepo: TaskRepo;
  outboundContext: OutboundContextRelease;
  logger: Logger;
  /**
   * Who answered, for the progress note. Omitted for the principal; a recipient's reply
   * on their own turn names them (#2261), so a later wake does not read it as the principal's.
   */
  repliedBy?: string;
}): Promise<TaskWakeReplyPersistResult> {
  const reply = options.reply.trim();
  if (reply.length === 0) {
    return { persisted: false, error: 'reply must be non-empty' };
  }

  if (!isTaskWakeReplyBinding(options.entry.metadata)) {
    return { persisted: false, error: 'outbound context entry is not a task-wake binding' };
  }

  const taskId = options.entry.metadata![TASK_WAKE_TASK_ID_KEY] as string;

  const persistFailed = (err: unknown): TaskWakeReplyPersistResult => {
    // Leaves the entry active so the reply can be retried (DB unavailable, etc.).
    options.logger.error({ err, taskId, entryId: options.entryId }, 'task-wake reply persistence failed');
    return { persisted: false, error: 'failed to persist task-wake reply' };
  };

  // The task is gone or has ended, so the reply has nowhere to go. Release the entry and
  // report that plainly. Leaving it active is what let one stale ask keep matching (and
  // failing on) unrelated principal replies for days (#2592). Never throws: a failed
  // release gets its own error, so it is not mistaken for a failed write to the task.
  const releaseUnattached = async (
    reason: string,
    level: 'info' | 'warn',
  ): Promise<TaskWakeReplyPersistResult> => {
    // The reply is stored nowhere, so the note tells the coordinator what to do with it.
    const note = `${reason}; reply not attached. If it asks for something new, handle it as a new request.`;
    options.logger[level]({ taskId, entryId: options.entryId, reason }, 'task-wake reply: releasing entry without attaching reply');
    try {
      await options.outboundContext.releaseEntry(options.entryId);
    } catch (err) {
      options.logger.error({ err, taskId, entryId: options.entryId, reason }, 'task-wake reply: failed to release entry for an ended task');
      return { persisted: false, error: `${reason}, but releasing the outbound context entry failed; retry the release` };
    }
    return { persisted: false, released: true, note, taskId, entryId: options.entryId };
  };

  let task: Awaited<ReturnType<TaskRepo['getTask']>>;
  try {
    task = await options.taskRepo.getTask(taskId);
  } catch (err) {
    return persistFailed(err);
  }
  // A binding to a task id that no longer exists is a data problem, not routine: warn.
  if (!task) return releaseUnattached('task no longer exists', 'warn');
  // Done and cancelled cannot take a progress note (updateTask's terminal guard rejects
  // it), and a failed task is abandoned work, as its outreach is (#2312). Check up front
  // rather than leaning on the guard's error.
  if (ENDED_TASK_STATUSES.has(task.status)) {
    return releaseUnattached(`task already ${task.status}`, 'info');
  }

  const progressNote = `${options.repliedBy ?? 'principal'} replied: ${reply.slice(0, 1500)}`;
  const updates: Parameters<TaskRepo['updateTask']>[1] = { progressNote };

  // The principal answering hands their task back to Curia (#1299). A contact's answer
  // does not (#2261): a task the principal owns stays theirs, in its status, with the
  // answer noted. Curia's own parked task resumes, since the answer is what it waited on.
  const byPrincipal = options.repliedBy === undefined;
  if (byPrincipal && task.owner === 'ceo') {
    updates.owner = 'curia';
  }
  if ((byPrincipal || task.owner !== 'ceo') && (task.status === 'waiting' || task.status === 'blocked')) {
    updates.status = 'in_progress';
  }

  let updated: Awaited<ReturnType<TaskRepo['updateTask']>>;
  try {
    updated = await options.taskRepo.updateTask(taskId, updates, 'coordinator');
  } catch (err) {
    // The task ended between getTask and updateTask. Same outcome as the up-front check.
    if (err instanceof TaskTerminalStateError) {
      return releaseUnattached(`task already ${err.status}`, 'info');
    }
    return persistFailed(err);
  }
  // updateTask returns null, without throwing, when the task was deleted meanwhile.
  // Nothing was written, so this must not be reported as recorded.
  if (!updated) return releaseUnattached('task no longer exists', 'warn');

  try {
    await options.outboundContext.releaseEntry(options.entryId);
  } catch (err) {
    // The note is already on the task. Say so, so the failure is not read as a lost reply.
    options.logger.error({ err, taskId, entryId: options.entryId }, 'task-wake reply recorded, but releasing the entry failed');
    return { persisted: false, error: 'reply recorded on the task, but releasing the outbound context entry failed' };
  }

  options.logger.info(
    { taskId, entryId: options.entryId },
    'task-wake reply recorded on originating task',
  );

  return { persisted: true, taskId, entryId: options.entryId };
}
