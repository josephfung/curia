// task-wake-reply.ts — bind CEO replies back to originating tasks (#1299).
//
// Task-wake questions are sent from a scheduler conversation but replies arrive on
// Signal/email. Auto-registration on send attaches durable task binding metadata;
// persistInboundTaskWakeReply writes the CEO's answer to the task before the
// coordinator acknowledges.

import type { Logger } from '../logger.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { OutboundContextRow, OutboundContextService } from './outbound-context.js';
import type { BoundTaskContext } from '../agents/resumable-task.js';
import type { ContextBridgeInput } from './context-bridge-parse.js';

/** Metadata flag: inbound replies to this outbound entry must be persisted to a task. */
export const TASK_WAKE_BIND_REPLY_KEY = 'bind_reply';

/** Metadata field: originating task UUID for task-wake reply binding. */
export const TASK_WAKE_TASK_ID_KEY = 'task_id';

/** Delegation hint injected on auto-bound task-wake sends. */
export const TASK_WAKE_DELEGATION_HINT = 'coordinator task-wake reply — persist to task';

/** TTL for task-wake reply bindings — longer than the 6h auto-registration default. */
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
    delegation_hint: TASK_WAKE_DELEGATION_HINT,
    expected_reply: preview.length > 0
      ? `CEO's reply to: ${preview}`
      : "CEO's reply to the task question",
    metadata: {
      [TASK_WAKE_BIND_REPLY_KEY]: true,
      [TASK_WAKE_TASK_ID_KEY]: opts.taskId,
    },
    expires_in_hours: TASK_WAKE_REPLY_TTL_HOURS,
  };
}

export function boundTaskFromSendContext(
  taskMetadata: Record<string, unknown> | undefined,
): BoundTaskContext | null {
  if (!taskMetadata) return null;
  const raw = taskMetadata['boundTask'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.taskId !== 'string' || record.taskId.length === 0) return null;
  return { taskId: record.taskId };
}

export interface TaskWakeReplyPersistResult {
  persisted: boolean;
  taskId?: string;
  entryId?: string;
}

/**
 * When the CEO replies to a task-wake question, durably record the answer on the
 * originating task and release the outbound context entry. Best-effort: failures are
 * logged but never block routing to the coordinator.
 */
export async function persistInboundTaskWakeReply(options: {
  principalReply: string;
  activeEntries: OutboundContextRow[];
  taskRepo: TaskRepo;
  outboundContextService: OutboundContextService;
  logger: Logger;
  isPrincipal: boolean;
}): Promise<TaskWakeReplyPersistResult> {
  if (!options.isPrincipal) return { persisted: false };

  const reply = options.principalReply.trim();
  if (reply.length === 0) return { persisted: false };

  const boundEntries = options.activeEntries.filter((entry) => isTaskWakeReplyBinding(entry.metadata));
  if (boundEntries.length === 0) return { persisted: false };

  // activeEntries are newest-first — bind to the most recent task-wake ask.
  const entry = boundEntries[0]!;
  const taskId = entry.metadata![TASK_WAKE_TASK_ID_KEY] as string;

  try {
    const task = await options.taskRepo.getTask(taskId);
    if (!task) {
      options.logger.warn({ taskId, entryId: entry.id }, 'task-wake reply: bound task not found — releasing entry');
      await options.outboundContextService.release(entry.id);
      return { persisted: false };
    }

    const progressNote = `CEO replied: ${reply.slice(0, 1500)}`;
    const updates: Parameters<TaskRepo['updateTask']>[1] = { progressNote };

    if (task.owner === 'ceo') {
      updates.owner = 'curia';
    }
    if (task.status === 'waiting' || task.status === 'blocked') {
      updates.status = 'in_progress';
    }

    await options.taskRepo.updateTask(taskId, updates, 'coordinator');
    await options.outboundContextService.release(entry.id);

    options.logger.info(
      { taskId, entryId: entry.id, boundEntryCount: boundEntries.length },
      'task-wake reply persisted to originating task',
    );

    return { persisted: true, taskId, entryId: entry.id };
  } catch (err) {
    options.logger.error(
      { err, taskId, entryId: entry.id },
      'task-wake reply persistence failed — coordinator will still handle inbound',
    );
    return { persisted: false };
  }
}
