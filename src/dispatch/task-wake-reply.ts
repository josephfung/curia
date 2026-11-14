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

  // The task is gone or finished, so the reply has nowhere to go. Release the entry and
  // report that plainly. Leaving it active is what let one stale ask keep matching (and
  // failing on) unrelated principal replies for days (#2592).
  const releaseUnattached = async (note: string): Promise<TaskWakeReplyPersistResult> => {
    options.logger.info({ taskId, entryId: options.entryId, note }, 'task-wake reply: releasing entry without attaching reply');
    await options.outboundContext.releaseEntry(options.entryId);
    return { persisted: false, released: true, note, taskId, entryId: options.entryId };
  };

  try {
    const task = await options.taskRepo.getTask(taskId);
    if (!task) {
      return await releaseUnattached('task no longer exists; reply not attached');
    }
    // A done or cancelled task cannot take a progress note: updateTask's terminal guard
    // rejects the write. Check up front rather than leaning on that error.
    if (task.status === 'done' || task.status === 'cancelled') {
      return await releaseUnattached(`task already ${task.status}; reply not attached`);
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

    await options.taskRepo.updateTask(taskId, updates, 'coordinator');
    await options.outboundContext.releaseEntry(options.entryId);

    options.logger.info(
      { taskId, entryId: options.entryId },
      'task-wake reply recorded on originating task',
    );

    return { persisted: true, taskId, entryId: options.entryId };
  } catch (err) {
    // The task ended between getTask and updateTask. Same outcome as the up-front check.
    if (err instanceof TaskTerminalStateError) {
      try {
        return await releaseUnattached(`task already ${err.status}; reply not attached`);
      } catch (releaseErr) {
        options.logger.error(
          { err: releaseErr, taskId, entryId: options.entryId },
          'task-wake reply: failed to release entry for a finished task',
        );
        return { persisted: false, error: 'failed to persist task-wake reply' };
      }
    }
    // Anything else (DB unavailable, etc.) leaves the entry active so the reply can be retried.
    options.logger.error(
      { err, taskId, entryId: options.entryId },
      'task-wake reply persistence failed',
    );
    return { persisted: false, error: 'failed to persist task-wake reply' };
  }
}
