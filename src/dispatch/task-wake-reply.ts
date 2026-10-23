// task-wake-reply.ts — bind principal replies back to originating tasks (#1299).
//
// Task-wake questions are sent from a scheduler conversation but replies arrive on
// Signal/email. Auto-registration on send attaches durable task binding metadata;
// the coordinator persists via context-bridge-release(reply) after judging relevance.

import type { Logger } from '../logger.js';
import type { TaskRepo } from '../db/task-repo.js';
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

  try {
    const task = await options.taskRepo.getTask(taskId);
    if (!task) {
      options.logger.warn({ taskId, entryId: options.entryId }, 'task-wake reply: bound task not found — releasing entry');
      await options.outboundContext.releaseEntry(options.entryId);
      return { persisted: false, error: `task not found: ${taskId}` };
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
    options.logger.error(
      { err, taskId, entryId: options.entryId },
      'task-wake reply persistence failed',
    );
    return { persisted: false, error: 'failed to persist task-wake reply' };
  }
}
