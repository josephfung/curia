//
// Marks an outbound context bridge entry as released — stops expecting replies
// for that outbound message. Pinned on the coordinator and on specialists that
// own exchanges (ceo-inbox, contacts). An entry with a delegation hint is released
// only by its owner or by the delegate that routed the reply (#1972).
//
// When `reply` is provided and the entry is a task-wake binding (bind_reply +
// task_id in metadata), persists the principal answer on the bound task first, then
// releases — atomically (#1299).

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { isTaskWakeReplyBinding, recordTaskWakeReply } from '../../../../src/dispatch/task-wake-reply.js';
import { isUuid } from '../../../../src/util/uuid.js';
import { delegationHintOwner } from '../../../../src/dispatch/delegation-hint.js';

/**
 * A non-UUID `entry_id` is a Postgres 22P02 on the uuid column, and the driver
 * text is not something the model can act on. Name the block the real id is
 * copied from. A `dedup:<uuid>:<uuid>` key contains UUIDs and still is not one,
 * so the message has to say the whole value must be that entry's id (#1940).
 */
function invalidEntryIdError(entryId: string): string {
  return (
    `Invalid entry_id "${entryId}" — expected the UUID copied verbatim from the ` +
    `[ACTIVE OUTBOUND CONTEXT] block. If that block is not in this turn, there is ` +
    `nothing to release; do not call this tool or invent an id (a slug or a key ` +
    `built from other UUIDs is not an entry_id).`
  );
}

/** Refusal for a hinted entry: names the owner and the call that releases it instead. */
function ownedEntryError(entryId: string, owner: string): string {
  return (
    `Entry ${entryId} is owned by ${owner}, so do not release it yourself. When you ` +
    `route the reply, pass this id to delegate as outbound_entry_id; the platform ` +
    `releases the entry when ${owner} returns, unless ${owner} keeps the exchange open.`
  );
}

export class ContextBridgeReleaseHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { entry_id: rawEntryId, reply: rawReply } = ctx.input as {
      entry_id?: string;
      reply?: string;
    };
    const entryId = typeof rawEntryId === 'string' ? rawEntryId.trim() : '';
    const reply = typeof rawReply === 'string' ? rawReply.trim() : '';

    if (!entryId) {
      return { success: false, error: 'Missing required input: entry_id (string)' };
    }

    if (!isUuid(entryId)) {
      return { success: false, error: invalidEntryIdError(entryId) };
    }

    if (!ctx.outboundContext) {
      return {
        success: false,
        error: 'context-bridge-release requires outboundContext capability.',
      };
    }

    try {
      const entry = await ctx.outboundContext.getEntry(entryId);
      if (reply.length > 0) {
        if (!entry) {
          return { success: false, error: 'outbound context entry not found or already released' };
        }
        if (isTaskWakeReplyBinding(entry.metadata)) {
          if (!ctx.taskRepo) {
            return {
              success: false,
              error: 'context-bridge-release: taskRepo required when reply is provided for a task-wake binding.',
            };
          }
          const result = await recordTaskWakeReply({
            reply,
            entryId,
            entry,
            taskRepo: ctx.taskRepo,
            outboundContext: ctx.outboundContext,
            logger: ctx.log,
          });
          if (!result.persisted) {
            return { success: false, error: result.error ?? 'failed to record task-wake reply' };
          }
          return {
            success: true,
            data: { released: entryId, task_id: result.taskId },
          };
        }
        ctx.log.debug(
          { entryId },
          'reply ignored — entry is not a task-wake binding',
        );
        // Reply on a non-task-wake entry — ignore reply and release normally.
      }

      // An entry with a delegation hint belongs to that specialist (#1972). Only the
      // owner releases it directly; otherwise the platform does, when the delegation
      // that routed the reply returns. Task-wake bindings stay the caller's to close.
      // A missing entry (already released or expired) falls through to the no-op release.
      const owner = entry ? delegationHintOwner(entry.delegationHint) : null;
      if (entry && owner && owner !== ctx.agentId && !isTaskWakeReplyBinding(entry.metadata)) {
        ctx.log.info(
          { entryId, owner, caller: ctx.agentId },
          'context-bridge-release refused — entry is owned by a specialist',
        );
        return { success: false, error: ownedEntryError(entryId, owner) };
      }

      await ctx.outboundContext.releaseEntry(entryId);
      ctx.log.info({ entryId }, 'Context bridge entry released');
      return { success: true, data: { released: entryId } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, entryId }, 'Failed to release context bridge entry');
      return { success: false, error: `Failed to release context bridge entry: ${message}` };
    }
  }
}
